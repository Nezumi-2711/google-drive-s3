import type { Env } from "./types";

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

/** Verifies an AWS Signature V4 signature carried in either the Authorization header or presigned query params. */
export async function verifySignature(request: Request, env: Env): Promise<boolean> {
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

    if (!algorithm?.includes("AWS4-HMAC-SHA256")) {
        return false;
    }

    const datetime = (isQueryAuth ? url.searchParams.get("X-Amz-Date") : headers.get("x-amz-date")) ?? "";

    if (!datetime) return false;

    const date = datetime.substring(0, 8);

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
        const match = authHeader.match(/Signature=([a-f0-9]+)/);
        expectedSignature = match ? match[1] : "";
    }

    return signatureHex === expectedSignature;
}
