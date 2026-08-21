import { decodedContentLength, isAwsChunked, pumpBody } from "./aws-chunked";
import { createSession, nextDriveOffset } from "./drive-resumable";
import { findFileInFolder, resolvePathToFolderAndFile } from "./google-drive";
import type { DriveUploadResult, Env } from "./types";

export const MAX_COMPLETE_XML = 4 * 1024 * 1024;
export const DEFAULT_PART_SIZE = 8 * 1024 * 1024; // 8 MiB aligned to 256 KiB

export type CoreError =
    | { kind: "error"; code: "NoSuchUpload"; status: 404; message?: string }
    | { kind: "error"; code: "InvalidArgument"; status: 400; message?: string }
    | { kind: "error"; code: "NotImplemented"; status: 501; message?: string }
    | { kind: "error"; code: "EntityTooLarge"; status: 400; message?: string }
    | { kind: "error"; code: "MalformedXML"; status: 400; message?: string }
    | { kind: "error"; code: "InvalidPart" | "InvalidPartOrder"; status: 400; message: string }
    | { kind: "error"; code: "SlowDown"; status: 503; message?: string; retryAfter?: string }
    | { kind: "error"; code: "InternalError"; status: 500; message: string };

export function etag(file: { id: string; md5Checksum?: string }): string {
    return file.md5Checksum || file.id;
}

export function multipartStub(env: Env, uploadId: string) {
    return env.MPU.getByName(uploadId);
}

export function encodeUploadId(bucket: string, key: string): string {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const random = btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    return `${random}.${encodeURIComponent(bucket)}.${encodeURIComponent(key)}`;
}

export function uploadIdMatches(uploadId: string, bucket: string, key: string): boolean {
    const parts = uploadId.split(".");
    if (parts.length < 3) return false;
    try {
        return decodeURIComponent(parts[1]) === bucket && decodeURIComponent(parts.slice(2).join(".")) === key;
    } catch {
        return false;
    }
}

export function parsePositiveInt(value: string | null, fallback?: number): number | undefined {
    if (value === null) return fallback;
    if (!/^\d+$/.test(value)) return undefined;
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : undefined;
}

export async function drainBody(body: ReadableStream | null): Promise<void> {
    if (body) await body.pipeTo(new WritableStream());
}

export async function partEtag(uploadId: string, partNumber: number, partLen: number, fileOffset: number): Promise<string> {
    const value = new TextEncoder().encode(`${uploadId}:${partNumber}:${partLen}:${fileOffset}`);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", value)).subarray(0, 16);
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function multipartObjectEtag(metadata: DriveUploadResult, partEtags: string[], style: Env["ETAG_STYLE"]): Promise<string> {
    if (style !== "multipart" || partEtags.length === 0) return etag(metadata);
    const bytes = new Uint8Array(partEtags.length * 16);
    for (let index = 0; index < partEtags.length; index++) {
        const value = partEtags[index];
        for (let byte = 0; byte < 16; byte++) bytes[index * 16 + byte] = Number.parseInt(value.slice(byte * 2, byte * 2 + 2), 16);
    }
    const digest = await crypto.subtle.digest("MD5", bytes);
    return `${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}-${partEtags.length}`;
}

export async function createMultipartUpload(
    env: Env,
    accessToken: string,
    bucket: string,
    key: string,
    mimeType: string,
): Promise<{ uploadId: string; partSize: number } | CoreError> {
    if (env.ALLOW_MULTIPART !== "true") return { kind: "error", code: "NotImplemented", status: 501 };
    const { parentFolderId, fileName } = await resolvePathToFolderAndFile(accessToken, bucket, key, env);
    const existing = await findFileInFolder(accessToken, parentFolderId, fileName);
    const uploadUrl = await createSession(accessToken, { name: fileName, parents: [parentFolderId], mimeType, existingFileId: existing?.id });
    const uploadId = encodeUploadId(bucket, key);
    const initialized = await multipartStub(env, uploadId).init({ uploadUrl, bucket, key, mimeType, parentFolderId, fileName, existingFileId: existing?.id });
    if (!initialized) throw new Error("Failed to initialize multipart state");
    return { uploadId, partSize: DEFAULT_PART_SIZE };
}

export async function uploadPartCore(
    request: Request,
    env: Env,
    accessToken: string,
    bucket: string,
    key: string,
    uploadId: string,
    partNumber: number | undefined,
): Promise<{ etag: string } | CoreError> {
    if (!uploadIdMatches(uploadId, bucket, key)) return { kind: "error", code: "NoSuchUpload", status: 404 };
    if (!partNumber || partNumber > 10_000) return { kind: "error", code: "InvalidArgument", status: 400, message: "partNumber must be between 1 and 10000" };
    if (request.headers.has("x-amz-copy-source")) return { kind: "error", code: "NotImplemented", status: 501 };
    const length = decodedContentLength(request);
    if (length === undefined) return { kind: "error", code: "InvalidArgument", status: 400, message: "Content-Length or x-amz-decoded-content-length is required" };

    const stub = multipartStub(env, uploadId);
    const requestId = crypto.randomUUID();
    const onAbort = () => void stub.cancelWaiter(requestId);
    request.signal.addEventListener("abort", onAbort, { once: true });
    const lease = await stub.beginPart(requestId, partNumber, length);
    request.signal.removeEventListener("abort", onAbort);
    if (lease.kind === "slowdown") return { kind: "error", code: "SlowDown", status: 503, retryAfter: "1" };
    if (lease.kind === "error") return { kind: "error", code: lease.code, status: lease.code === "NoSuchUpload" ? 404 : 500, message: lease.message };
    if (lease.kind === "committed") {
        await drainBody(request.body);
        return { etag: lease.etag };
    }

    try {
        const fixed = lease.sendLen === 0 ? null : new FixedLengthStream(lease.sendLen, { highWaterMark: 1 << 20 });
        const drivePromise = fixed
            ? fetch(lease.uploadUrl, {
                  method: "PUT",
                  headers: {
                      Authorization: `Bearer ${accessToken}`,
                      "Content-Length": lease.sendLen.toString(),
                      "Content-Range": `bytes ${lease.driveOffset}-${lease.driveOffset + lease.sendLen - 1}/*`,
                  },
                  body: fixed.readable,
                  duplex: "half",
              } as RequestInit)
            : null;
        const sink = fixed?.writable ?? new WritableStream<ArrayBuffer | ArrayBufferView>();
        const pumped = await pumpBody(request.body, sink.getWriter(), {
            awsChunked: isAwsChunked(request),
            expectedLength: length,
            skipBytes: lease.skipBytes,
            maxBytes: lease.sendLen,
            prefix: lease.carry,
        });
        const driveResponse = drivePromise ? await drivePromise : null;
        if (driveResponse && driveResponse.status !== 308) throw new Error(`Drive part upload returned ${driveResponse.status}: ${await driveResponse.text()}`);
        const newOffset = driveResponse ? nextDriveOffset(driveResponse) : lease.driveOffset;
        const value = await partEtag(uploadId, partNumber, length, lease.driveOffset + lease.carry.byteLength);
        if (!(await stub.endPart(partNumber, newOffset, pumped.tail, value, length))) throw new Error("Multipart lease was lost before commit");
        return { etag: value };
    } catch (error) {
        await stub.failPart(partNumber);
        throw error;
    }
}

export async function completeMultipartUpload(
    env: Env,
    bucket: string,
    key: string,
    uploadId: string,
    parts: Array<{ partNumber: number; etag: string }>,
    expectedTotal?: number,
): Promise<{ etag: string; key: string } | CoreError> {
    if (!uploadIdMatches(uploadId, bucket, key)) return { kind: "error", code: "NoSuchUpload", status: 404 };
    const result = await multipartStub(env, uploadId).complete(parts, expectedTotal);
    if (result.kind === "error") return { kind: "error", code: result.code, status: result.code === "NoSuchUpload" ? 404 : 400, message: result.message };
    const value = await multipartObjectEtag(result.metadata, result.partEtags, env.ETAG_STYLE);
    return { etag: value, key };
}

export async function abortMultipartUpload(env: Env, bucket: string, key: string, uploadId: string): Promise<boolean | CoreError> {
    if (!uploadIdMatches(uploadId, bucket, key)) return { kind: "error", code: "NoSuchUpload", status: 404 };
    const success = await multipartStub(env, uploadId).abort();
    if (!success) return { kind: "error", code: "NoSuchUpload", status: 404 };
    return true;
}

export async function listMultipartParts(
    env: Env,
    bucket: string,
    key: string,
    uploadId: string,
    marker = 0,
    maxParts = 1000,
): Promise<import("./types").MultipartPartsList | CoreError> {
    if (!uploadIdMatches(uploadId, bucket, key)) return { kind: "error", code: "NoSuchUpload", status: 404 };
    if (marker < 0 || maxParts < 0 || maxParts > 1000) return { kind: "error", code: "InvalidArgument", status: 400 };
    const result = await multipartStub(env, uploadId).listParts(marker, maxParts);
    if (!result) return { kind: "error", code: "NoSuchUpload", status: 404 };
    return result;
}
