import { decodedContentLength, isAwsChunked, pumpBody } from "./aws-chunked";
import { createSession, nextDriveOffset } from "./drive-resumable";
import { deleteFromDrive, findFileInFolder, getFileMetadata, listObjects, resolvePathToFolderAndFile, streamDownloadFromDrive, streamUploadToDrive } from "./google-drive";
import { S3Exception, s3Error } from "./s3-errors";
import { completeMultipartUploadResult, generateListBucketResult, initiateMultipartUploadResult, listMultipartUploadsResult, listPartsResult, parseCompleteMultipartUpload } from "./s3-xml";
import type { DriveUploadResult, Env } from "./types";

const MAX_COMPLETE_XML = 4 * 1024 * 1024;

function etag(file: { id: string; md5Checksum?: string }): string {
    return file.md5Checksum || file.id;
}

function xmlResponse(body: string, status = 200): Response {
    return new Response(body, { status, headers: { "Content-Type": "application/xml", "Cache-Control": "no-transform" } });
}

function multipartStub(env: Env, uploadId: string) {
    return env.MPU.getByName(uploadId);
}

function encodeUploadId(bucket: string, key: string): string {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const random = btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    return `${random}.${encodeURIComponent(bucket)}.${encodeURIComponent(key)}`;
}

function uploadIdMatches(uploadId: string, bucket: string, key: string): boolean {
    const parts = uploadId.split(".");
    if (parts.length < 3) return false;
    try {
        return decodeURIComponent(parts[1]) === bucket && decodeURIComponent(parts.slice(2).join(".")) === key;
    } catch {
        return false;
    }
}

function parsePositiveInt(value: string | null, fallback?: number): number | undefined {
    if (value === null) return fallback;
    if (!/^\d+$/.test(value)) return undefined;
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : undefined;
}

async function drainBody(body: ReadableStream | null): Promise<void> {
    if (body) await body.pipeTo(new WritableStream());
}

async function partEtag(uploadId: string, partNumber: number, partLen: number, fileOffset: number): Promise<string> {
    const value = new TextEncoder().encode(`${uploadId}:${partNumber}:${partLen}:${fileOffset}`);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", value)).subarray(0, 16);
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function multipartObjectEtag(metadata: DriveUploadResult, partEtags: string[], style: Env["ETAG_STYLE"]): Promise<string> {
    if (style !== "multipart" || partEtags.length === 0) return etag(metadata);
    const bytes = new Uint8Array(partEtags.length * 16);
    for (let index = 0; index < partEtags.length; index++) {
        const value = partEtags[index];
        for (let byte = 0; byte < 16; byte++) bytes[index * 16 + byte] = Number.parseInt(value.slice(byte * 2, byte * 2 + 2), 16);
    }
    const digest = await crypto.subtle.digest("MD5", bytes);
    return `${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}-${partEtags.length}`;
}

async function createMultipart(request: Request, env: Env, accessToken: string, bucket: string, key: string): Promise<Response> {
    if (env.ALLOW_MULTIPART !== "true") return s3Error("NotImplemented", 501, undefined, `/${bucket}/${key}`);
    const mimeType = request.headers.get("Content-Type") || "application/octet-stream";
    const { parentFolderId, fileName } = await resolvePathToFolderAndFile(accessToken, bucket, key, env);
    const existing = await findFileInFolder(accessToken, parentFolderId, fileName);
    const uploadUrl = await createSession(accessToken, { name: fileName, parents: [parentFolderId], mimeType, existingFileId: existing?.id });
    const uploadId = encodeUploadId(bucket, key);
    const initialized = await multipartStub(env, uploadId).init({ uploadUrl, bucket, key, mimeType, parentFolderId, fileName, existingFileId: existing?.id });
    if (!initialized) throw new Error("Failed to initialize multipart state");
    return xmlResponse(initiateMultipartUploadResult(bucket, key, uploadId));
}

async function uploadPart(request: Request, env: Env, accessToken: string, bucket: string, key: string, url: URL): Promise<Response> {
    const uploadId = url.searchParams.get("uploadId") ?? "";
    const partNumber = parsePositiveInt(url.searchParams.get("partNumber"));
    if (!uploadIdMatches(uploadId, bucket, key)) return s3Error("NoSuchUpload", 404, undefined, `/${bucket}/${key}`);
    if (!partNumber || partNumber > 10_000) return s3Error("InvalidArgument", 400, "partNumber must be between 1 and 10000", `/${bucket}/${key}`);
    if (request.headers.has("x-amz-copy-source")) return s3Error("NotImplemented", 501, undefined, `/${bucket}/${key}`);
    const length = decodedContentLength(request);
    if (length === undefined) return s3Error("InvalidArgument", 400, "Content-Length or x-amz-decoded-content-length is required", `/${bucket}/${key}`);

    const stub = multipartStub(env, uploadId);
    const requestId = crypto.randomUUID();
    const onAbort = () => void stub.cancelWaiter(requestId);
    request.signal.addEventListener("abort", onAbort, { once: true });
    const lease = await stub.beginPart(requestId, partNumber, length);
    request.signal.removeEventListener("abort", onAbort);
    if (lease.kind === "slowdown") return s3Error("SlowDown", 503, undefined, `/${bucket}/${key}`, false, { "Retry-After": "1" });
    if (lease.kind === "error") return s3Error(lease.code, lease.code === "NoSuchUpload" ? 404 : 500, lease.message, `/${bucket}/${key}`);
    if (lease.kind === "committed") {
        await drainBody(request.body);
        return new Response(null, { status: 200, headers: { ETag: `"${lease.etag}"` } });
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
        return new Response(null, { status: 200, headers: { ETag: `"${value}"` } });
    } catch (error) {
        await stub.failPart(partNumber);
        throw error;
    }
}

async function completeMultipart(request: Request, env: Env, bucket: string, key: string, url: URL): Promise<Response> {
    const uploadId = url.searchParams.get("uploadId") ?? "";
    if (!uploadIdMatches(uploadId, bucket, key)) return s3Error("NoSuchUpload", 404, undefined, `/${bucket}/${key}`);
    const contentLength = parsePositiveInt(request.headers.get("Content-Length"));
    if (contentLength !== undefined && contentLength > MAX_COMPLETE_XML) return s3Error("EntityTooLarge", 400, "Completion XML exceeds 4 MiB", `/${bucket}/${key}`);
    const text = await request.text();
    if (text.length > MAX_COMPLETE_XML) return s3Error("EntityTooLarge", 400, "Completion XML exceeds 4 MiB", `/${bucket}/${key}`);
    let parts: Array<{ partNumber: number; etag: string }>;
    try {
        parts = parseCompleteMultipartUpload(text);
    } catch {
        return s3Error("MalformedXML", 400, undefined, `/${bucket}/${key}`);
    }
    const expectedTotal = parsePositiveInt(request.headers.get("x-amz-mp-object-size"));
    const result = await multipartStub(env, uploadId).complete(parts, expectedTotal);
    if (result.kind === "error") return s3Error(result.code, result.code === "NoSuchUpload" ? 404 : 400, result.message, `/${bucket}/${key}`);
    const value = await multipartObjectEtag(result.metadata, result.partEtags, env.ETAG_STYLE);
    return xmlResponse(completeMultipartUploadResult(bucket, key, value));
}

async function abortMultipart(env: Env, bucket: string, key: string, url: URL): Promise<Response> {
    const uploadId = url.searchParams.get("uploadId") ?? "";
    if (!uploadIdMatches(uploadId, bucket, key) || !(await multipartStub(env, uploadId).abort())) return s3Error("NoSuchUpload", 404, undefined, `/${bucket}/${key}`);
    return new Response(null, { status: 204 });
}

async function listParts(env: Env, bucket: string, key: string, url: URL): Promise<Response> {
    const uploadId = url.searchParams.get("uploadId") ?? "";
    if (!uploadIdMatches(uploadId, bucket, key)) return s3Error("NoSuchUpload", 404, undefined, `/${bucket}/${key}`);
    const marker = parsePositiveInt(url.searchParams.get("part-number-marker"), 0);
    const maxParts = parsePositiveInt(url.searchParams.get("max-parts"), 1000);
    if (marker === undefined || maxParts === undefined || maxParts > 1000) return s3Error("InvalidArgument", 400, undefined, `/${bucket}/${key}`);
    const result = await multipartStub(env, uploadId).listParts(marker, maxParts);
    if (!result) return s3Error("NoSuchUpload", 404, undefined, `/${bucket}/${key}`);
    return xmlResponse(listPartsResult(bucket, key, uploadId, result));
}

async function putObject(request: Request, env: Env, accessToken: string, bucket: string, key: string): Promise<Response> {
    if (request.headers.has("x-amz-copy-source")) return s3Error("NotImplemented", 501, undefined, `/${bucket}/${key}`);
    const result = await streamUploadToDrive(accessToken, request, bucket, key, request.headers.get("Content-Type") || "application/octet-stream", env);
    return new Response(null, { status: 200, headers: { ETag: `"${etag(result)}"` } });
}

export async function dispatch(request: Request, env: Env, accessToken: string, bucket: string, key: string): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const resource = `/${bucket}${key ? `/${key}` : ""}`;

    if (method === "POST" && key && url.searchParams.has("uploads")) return createMultipart(request, env, accessToken, bucket, key);
    if (method === "PUT" && key && url.searchParams.has("uploadId") && url.searchParams.has("partNumber")) return uploadPart(request, env, accessToken, bucket, key, url);
    if (method === "POST" && key && url.searchParams.has("uploadId")) return completeMultipart(request, env, bucket, key, url);
    if (method === "DELETE" && key && url.searchParams.has("uploadId")) return abortMultipart(env, bucket, key, url);
    if (method === "GET" && key && url.searchParams.has("uploadId")) return listParts(env, bucket, key, url);
    if (method === "GET" && !key && url.searchParams.has("uploads")) return xmlResponse(listMultipartUploadsResult(bucket));
    if (method === "PUT" && key) return putObject(request, env, accessToken, bucket, key);

    if (method === "GET") {
        if (!key) {
            const prefix = url.searchParams.get("prefix") ?? "";
            const delimiter = url.searchParams.get("delimiter") ?? undefined;
            const { contents, commonPrefixes, truncated } = await listObjects(accessToken, bucket, prefix, env, delimiter);
            return xmlResponse(generateListBucketResult(bucket, prefix, delimiter, contents, commonPrefixes, truncated));
        }
        try {
            const file = await streamDownloadFromDrive(accessToken, bucket, key, env, request.headers.get("Range") ?? undefined);
            const headers = new Headers({
                "Content-Type": file.contentType,
                "Content-Length": file.contentLength ?? file.size.toString(),
                "Cache-Control": "s-maxage=300, no-store, no-transform",
                "Accept-Ranges": "bytes",
                ETag: `"${etag(file)}"`,
            });
            if (file.contentRange) headers.set("Content-Range", file.contentRange);
            if (file.modifiedTime) headers.set("Last-Modified", new Date(file.modifiedTime).toUTCString());
            return new Response(file.body, { status: file.status, headers });
        } catch (error) {
            if (error instanceof Error && error.message === "File not found") return s3Error("NoSuchKey", 404, undefined, resource);
            throw error;
        }
    }

    if (method === "HEAD") {
        if (!key) return new Response(null, { status: 200 });
        try {
            const metadata = await getFileMetadata(accessToken, bucket, key, env);
            const headers = new Headers({ "Content-Type": metadata.mimeType, "Content-Length": metadata.size.toString(), "Cache-Control": "no-transform", "Accept-Ranges": "bytes", ETag: `"${etag(metadata)}"` });
            if (metadata.modifiedTime) headers.set("Last-Modified", new Date(metadata.modifiedTime).toUTCString());
            return new Response(null, { status: 200, headers });
        } catch (error) {
            if (error instanceof Error && error.message === "File not found") return s3Error("NoSuchKey", 404, undefined, resource, true);
            throw error;
        }
    }

    if (method === "DELETE" && key) {
        try {
            await deleteFromDrive(accessToken, bucket, key, env);
            return new Response(null, { status: 204 });
        } catch (error) {
            if (error instanceof Error && error.message === "File not found") return s3Error("NoSuchKey", 404, undefined, resource);
            throw error;
        }
    }

    throw new S3Exception("MethodNotAllowed", 405);
}
