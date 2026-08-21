import {
    MAX_COMPLETE_XML,
    abortMultipartUpload,
    completeMultipartUpload,
    createMultipartUpload,
    etag,
    listMultipartParts,
    parsePositiveInt,
    uploadPartCore,
} from "./multipart-core";
import { deleteFromDrive, getFileMetadata, listObjects, streamDownloadFromDrive, streamUploadToDrive } from "./google-drive";
import { S3Exception, s3Error } from "./s3-errors";
import { completeMultipartUploadResult, generateListBucketResult, initiateMultipartUploadResult, listMultipartUploadsResult, listPartsResult, parseCompleteMultipartUpload } from "./s3-xml";
import type { Env } from "./types";

function xmlResponse(body: string, status = 200): Response {
    return new Response(body, { status, headers: { "Content-Type": "application/xml", "Cache-Control": "no-transform" } });
}

async function createMultipart(request: Request, env: Env, accessToken: string, bucket: string, key: string): Promise<Response> {
    const mimeType = request.headers.get("Content-Type") || "application/octet-stream";
    const result = await createMultipartUpload(env, accessToken, bucket, key, mimeType);
    if ("kind" in result && result.kind === "error") {
        return s3Error(result.code, result.status, result.message, `/${bucket}/${key}`);
    }
    return xmlResponse(initiateMultipartUploadResult(bucket, key, (result as { uploadId: string }).uploadId));
}

async function uploadPart(request: Request, env: Env, accessToken: string, bucket: string, key: string, url: URL): Promise<Response> {
    const uploadId = url.searchParams.get("uploadId") ?? "";
    const partNumber = parsePositiveInt(url.searchParams.get("partNumber"));
    const result = await uploadPartCore(request, env, accessToken, bucket, key, uploadId, partNumber);
    if ("kind" in result && result.kind === "error") {
        if (result.code === "SlowDown") {
            return s3Error("SlowDown", 503, undefined, `/${bucket}/${key}`, false, { "Retry-After": result.retryAfter ?? "1" });
        }
        return s3Error(result.code, result.status, result.message, `/${bucket}/${key}`);
    }
    return new Response(null, { status: 200, headers: { ETag: `"${(result as { etag: string }).etag}"` } });
}

async function completeMultipart(request: Request, env: Env, bucket: string, key: string, url: URL): Promise<Response> {
    const uploadId = url.searchParams.get("uploadId") ?? "";
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
    const result = await completeMultipartUpload(env, bucket, key, uploadId, parts, expectedTotal);
    if ("kind" in result && result.kind === "error") {
        return s3Error(result.code, result.status, result.message, `/${bucket}/${key}`);
    }
    return xmlResponse(completeMultipartUploadResult(bucket, key, (result as { etag: string }).etag));
}

async function abortMultipart(env: Env, bucket: string, key: string, url: URL): Promise<Response> {
    const uploadId = url.searchParams.get("uploadId") ?? "";
    const result = await abortMultipartUpload(env, bucket, key, uploadId);
    if (result !== true) return s3Error("NoSuchUpload", 404, undefined, `/${bucket}/${key}`);
    return new Response(null, { status: 204 });
}

async function listParts(env: Env, bucket: string, key: string, url: URL): Promise<Response> {
    const uploadId = url.searchParams.get("uploadId") ?? "";
    const marker = parsePositiveInt(url.searchParams.get("part-number-marker"), 0);
    const maxParts = parsePositiveInt(url.searchParams.get("max-parts"), 1000);
    if (marker === undefined || maxParts === undefined || maxParts > 1000) return s3Error("InvalidArgument", 400, undefined, `/${bucket}/${key}`);
    const result = await listMultipartParts(env, bucket, key, uploadId, marker, maxParts);
    if ("kind" in result && result.kind === "error") {
        return s3Error(result.code, result.status, result.message, `/${bucket}/${key}`);
    }
    return xmlResponse(listPartsResult(bucket, key, uploadId, result as import("./types").MultipartPartsList));
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
