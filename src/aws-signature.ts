import type { S3ErrorCode } from "./s3-errors";
import type { Env } from "./types";

const MAX_PRESIGN_EXPIRY_SECONDS = 7 * 24 * 60 * 60;
const MAX_CLOCK_SKEW_MS = 15 * 60 * 1000;

export type VerifyResult = { ok: true } | { ok: false; code: S3ErrorCode; message?: string };

function encodeRFC3986(str: string): string {
    return encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function bufToHex(buf: ArrayBuffer): string {
    return Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

async function hmacSha256(key: string | ArrayBuffer, data: string): Promise<ArrayBuffer> {
    const keyData = typeof key === "string" ? new TextEncoder().encode(key) : key;
    const cryptoKey = await crypto.subtle.importKey("raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
}

async function sha256(data: string): Promise<string> {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
    return bufToHex(hash);
}

async function getSigningKey(secret: string, date: string, region: string, service: string): Promise<ArrayBuffer> {
    const kDate = await hmacSha256(`AWS4${secret}`, date);
    const kRegion = await hmacSha256(kDate, region);
    const kService = await hmacSha256(kRegion, service);
    return await hmacSha256(kService, "aws4_request");
}

async function createCanonicalRequest(request: Request, isQueryAuth: boolean): Promise<string> {
    const url = new URL(request.url);

    const method = request.method;
    const canonicalUri = url.pathname || "/";

    const params = Array.from(url.searchParams.entries())
        .filter(([key]) => key !== "X-Amz-Signature")
        .sort(([a], [b]) => {
            if (a < b) return -1;
            if (a > b) return 1;
            return 0;
        })
        .map(([key, val]) => `${encodeRFC3986(key)}=${encodeRFC3986(val)}`)
        .join("&");

    let signedHeadersList: string[];
    if (isQueryAuth) {
        signedHeadersList = (url.searchParams.get("X-Amz-SignedHeaders") ?? "host").split(";");
    } else {
        const authHeader = request.headers.get("Authorization") ?? "";
        const match = authHeader.match(/SignedHeaders=([^,\s]+)/);
        signedHeadersList = match ? match[1].split(";") : ["host"];
    }

    const canonicalHeaders = signedHeadersList
        .map((h) => {
            const headerName = h.toLowerCase();
            let headerValue = "";

            if (headerName === "host") {
                headerValue = url.hostname;
                const port = url.port;
                if (port && !((url.protocol === "https:" && port === "443") || (url.protocol === "http:" && port === "80"))) {
                    headerValue += `:${port}`;
                }
            } else if (headerName === "accept-encoding") {
                // Cloudflare's edge rewrites the incoming Accept-Encoding value before the Worker
                // sees it, so the literal value can never be recovered here. S3 SDKs that sign this
                // header (aws-sdk-go, used by rclone/mc) always set it to "identity" beforehand, since
                // S3 doesn't support transparent content-encoding on object bodies.
                headerValue = "identity";
            } else {
                headerValue = request.headers.get(headerName)?.trim() ?? "";
            }

            return `${headerName}:${headerValue}\n`;
        })
        .join("");

    const signedHeaders = signedHeadersList.join(";");
    const payloadHash = request.headers.get("x-amz-content-sha256") ?? "UNSIGNED-PAYLOAD";

    return [method, canonicalUri, params, canonicalHeaders, signedHeaders, payloadHash].join("\n");
}

function parseAmzDate(datetime: string): number | null {
    const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(datetime);
    if (!match) return null;

    const [, year, month, day, hour, minute, second] = match;
    const timestamp = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
    const parsed = new Date(timestamp);
    if (parsed.getUTCFullYear() !== Number(year) || parsed.getUTCMonth() !== Number(month) - 1 || parsed.getUTCDate() !== Number(day) || parsed.getUTCHours() !== Number(hour) || parsed.getUTCMinutes() !== Number(minute) || parsed.getUTCSeconds() !== Number(second)) {
        return null;
    }

    return timestamp;
}

function constantTimeEqual(left: string, right: string): boolean {
    if (left.length !== right.length) return false;
    let mismatch = 0;
    for (let index = 0; index < left.length; index++) {
        mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
    }
    return mismatch === 0;
}

function signatureMismatch(): VerifyResult {
    return { ok: false, code: "SignatureDoesNotMatch" };
}

/** Verifies an AWS Signature V4 signature carried in either the Authorization header or presigned query params. */
export async function verifySignature(request: Request, env: Env): Promise<VerifyResult> {
    const url = new URL(request.url);
    const headers = request.headers;

    const isQueryAuth = url.searchParams.has("X-Amz-Algorithm");

    let algorithm: string;
    if (isQueryAuth) {
        algorithm = url.searchParams.get("X-Amz-Algorithm") ?? "";
    } else {
        const authHeader = headers.get("Authorization") ?? "";
        algorithm = authHeader.split(" ")[0];
    }

    if (algorithm !== "AWS4-HMAC-SHA256") {
        return signatureMismatch();
    }

    const datetime = (isQueryAuth ? url.searchParams.get("X-Amz-Date") : headers.get("x-amz-date")) ?? "";
    if (!datetime) return isQueryAuth ? { ok: false, code: "AccessDenied", message: "Request has expired" } : signatureMismatch();
    const signedAt = parseAmzDate(datetime);
    if (signedAt === null) return isQueryAuth ? { ok: false, code: "AccessDenied", message: "Request has expired" } : signatureMismatch();

    if (isQueryAuth) {
        const expires = url.searchParams.get("X-Amz-Expires");
        if (!expires || !/^\d+$/.test(expires)) return { ok: false, code: "AccessDenied", message: "Request has expired" };
        const expiresIn = Number(expires);
        if (!Number.isSafeInteger(expiresIn) || expiresIn < 1 || expiresIn > MAX_PRESIGN_EXPIRY_SECONDS || Date.now() > signedAt + expiresIn * 1000) {
            return { ok: false, code: "AccessDenied", message: "Request has expired" };
        }
    } else if (Math.abs(Date.now() - signedAt) > MAX_CLOCK_SKEW_MS) {
        return { ok: false, code: "RequestTimeTooSkewed" };
    }

    const date = datetime.substring(0, 8);
    const credential = isQueryAuth ? (url.searchParams.get("X-Amz-Credential") ?? "") : (/Credential=([^,\s]+)/.exec(headers.get("Authorization") ?? "")?.[1] ?? "");
    const credentialParts = credential.split("/");
    if (credentialParts.length !== 5 || credentialParts[0] !== env.ACCESS_KEY || credentialParts.slice(1).join("/") !== `${date}/${env.REGION}/s3/aws4_request`) {
        return { ok: false, code: "AccessDenied" };
    }

    const canonicalRequest = await createCanonicalRequest(request, isQueryAuth);
    const hashedCanonicalRequest = await sha256(canonicalRequest);

    const credentialScope = `${date}/${env.REGION}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", datetime, credentialScope, hashedCanonicalRequest].join("\n");

    const signingKey = await getSigningKey(env.SECRET_KEY, date, env.REGION, "s3");
    const signature = await hmacSha256(signingKey, stringToSign);
    const signatureHex = bufToHex(signature);

    let expectedSignature = "";
    if (isQueryAuth) {
        expectedSignature = url.searchParams.get("X-Amz-Signature") ?? "";
    } else {
        const authHeader = headers.get("Authorization") ?? "";
        const match = authHeader.match(/Signature=([a-fA-F0-9]+)/);
        expectedSignature = match ? match[1] : "";
    }

    return constantTimeEqual(signatureHex, expectedSignature) ? { ok: true } : signatureMismatch();
}
