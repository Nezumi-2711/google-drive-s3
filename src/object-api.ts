import { jsonResponse } from "./auth-api";
import { findBucketRecord } from "./bucket-registry";
import {
    deleteFromDrive,
    findFileInFolder,
    findFolderId,
    getAccessToken,
    getFileMetadata,
    getOrCreateFolder,
    listObjects,
    resolvePathToExistingFolderAndFile,
    resolvePathToFolderAndFile,
    streamDownloadFromDrive,
    streamUploadToDrive,
    updateDriveFile,
} from "./google-drive";
import {
    abortMultipartUpload,
    completeMultipartUpload,
    createMultipartUpload,
    etag,
    listMultipartParts,
    parsePositiveInt,
    uploadPartCore,
} from "./multipart-core";
import type { Env } from "./types";

export async function invalidateObjectCaches(env: Env, bucket: string, parentId?: string, name?: string): Promise<void> {
    await env.FOLDER_CACHE.delete(`bucket-stats:${bucket}`);
    if (parentId && name) {
        await env.FOLDER_CACHE.delete(`${parentId}/${name}`);
    }
}

async function sha256Hex(text: string): Promise<string> {
    const data = new TextEncoder().encode(text);
    const hash = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function handleTicketDownload(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const bucket = url.searchParams.get("bucket") ?? "";
    const key = url.searchParams.get("key") ?? "";
    const ticket = url.searchParams.get("ticket") ?? "";

    if (!bucket || !key || !ticket) {
        return jsonResponse({ message: "bucket, key, and ticket are required" }, 400);
    }

    const ticketHash = await sha256Hex(ticket);
    const ticketKey = `dl:${ticketHash}`;
    const stored = await env.AUTH_KV.get(ticketKey);

    if (!stored) {
        return jsonResponse({ message: "Invalid or expired download ticket" }, 403);
    }

    try {
        const payload = JSON.parse(stored) as { bucket: string; key: string };
        if (payload.bucket !== bucket || payload.key !== key) {
            return jsonResponse({ message: "Ticket does not match bucket and key" }, 403);
        }
    } catch {
        return jsonResponse({ message: "Invalid download ticket payload" }, 403);
    }

    // Single use ticket
    await env.AUTH_KV.delete(ticketKey);

    const bucketRecord = await findBucketRecord(env, bucket);
    if (!bucketRecord) {
        return jsonResponse({ message: `Bucket '${bucket}' not found` }, 404);
    }

    try {
        const accessToken = await getAccessToken(env);
        const range = request.headers.get("Range") ?? undefined;
        const result = await streamDownloadFromDrive(accessToken, bucket, key, env, range);

        const filename = key.split("/").filter(Boolean).pop() || "download";
        const headers = new Headers({
            "Content-Type": result.contentType,
            "Content-Length": result.contentLength || result.size.toString(),
            ETag: `"${etag(result)}"`,
            "Accept-Ranges": "bytes",
            "Content-Disposition": `attachment; filename="${encodeURIComponent(filename)}"`,
        });

        if (result.contentRange) headers.set("Content-Range", result.contentRange);
        if (result.modifiedTime) headers.set("Last-Modified", new Date(result.modifiedTime).toUTCString());

        return new Response(result.body, {
            status: result.status,
            headers,
        });
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("not found") || message.includes("File not found")) {
            return jsonResponse({ message: "Object not found" }, 404);
        }
        return jsonResponse({ message: "Failed to download object" }, 500);
    }
}

export async function handleObjectRoutes(request: Request, env: Env, subSegments: string[]): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const path = subSegments.join("/");

    // 1. GET /api/objects (List objects) OR DELETE /api/objects (Delete object)
    if (path === "") {
        const bucket = url.searchParams.get("bucket") ?? "";
        if (!bucket) return jsonResponse({ message: "bucket query parameter is required" }, 400);

        const bucketRecord = await findBucketRecord(env, bucket);
        if (!bucketRecord) return jsonResponse({ message: `Bucket '${bucket}' not found` }, 404);

        if (method === "GET") {
            const prefix = url.searchParams.get("prefix") ?? "";
            const delimiter = url.searchParams.get("delimiter") ?? undefined;
            try {
                const accessToken = await getAccessToken(env);
                const { contents, commonPrefixes, truncated } = await listObjects(accessToken, bucket, prefix, env, delimiter);
                return jsonResponse(
                    {
                        bucket,
                        prefix,
                        delimiter: delimiter ?? null,
                        folders: commonPrefixes.map((p) => {
                            const trimmed = p.endsWith("/") ? p.slice(0, -1) : p;
                            const name = trimmed.split("/").pop() || trimmed;
                            return { prefix: p, name };
                        }),
                        objects: contents.map((obj) => {
                            const name = obj.key.split("/").pop() || obj.key;
                            return {
                                key: obj.key,
                                name,
                                size: parseInt(obj.size || "0", 10),
                                contentType: obj.mimeType || "application/octet-stream",
                                lastModified: obj.modifiedTime || null,
                                etag: etag(obj),
                            };
                        }),
                        truncated,
                    },
                    200,
                );
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                return jsonResponse({ message }, 500);
            }
        }

        if (method === "DELETE") {
            const key = url.searchParams.get("key") ?? "";
            if (!key) return jsonResponse({ message: "key query parameter is required" }, 400);

            try {
                const accessToken = await getAccessToken(env);
                await deleteFromDrive(accessToken, bucket, key, env);
                await invalidateObjectCaches(env, bucket);
                return new Response(null, { status: 204 });
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                if (message.includes("not found") || message.includes("File not found")) {
                    return jsonResponse({ message: "Object not found" }, 404);
                }
                return jsonResponse({ message }, 500);
            }
        }

        return jsonResponse({ message: "Method Not Allowed" }, 405);
    }

    // 2. GET /api/objects/metadata?bucket=&key=
    if (path === "metadata") {
        if (method !== "GET") return jsonResponse({ message: "Method Not Allowed" }, 405);
        const bucket = url.searchParams.get("bucket") ?? "";
        const key = url.searchParams.get("key") ?? "";
        if (!bucket || !key) return jsonResponse({ message: "bucket and key query parameters are required" }, 400);

        const bucketRecord = await findBucketRecord(env, bucket);
        if (!bucketRecord) return jsonResponse({ message: `Bucket '${bucket}' not found` }, 404);

        try {
            const accessToken = await getAccessToken(env);
            const meta = await getFileMetadata(accessToken, bucket, key, env);
            const name = key.split("/").pop() || key;
            return jsonResponse(
                {
                    key,
                    name,
                    size: meta.size,
                    contentType: meta.mimeType,
                    lastModified: meta.modifiedTime,
                    etag: etag(meta),
                },
                200,
            );
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            if (message.includes("not found") || message.includes("File not found")) {
                return jsonResponse({ message: "Object not found" }, 404);
            }
            return jsonResponse({ message }, 500);
        }
    }

    // 3. GET /api/objects/content?bucket=&key= (Stream download) OR PUT /api/objects/content?bucket=&key= (Direct upload)
    if (path === "content") {
        const bucket = url.searchParams.get("bucket") ?? "";
        const key = url.searchParams.get("key") ?? "";
        if (!bucket || !key) return jsonResponse({ message: "bucket and key query parameters are required" }, 400);

        const bucketRecord = await findBucketRecord(env, bucket);
        if (!bucketRecord) return jsonResponse({ message: `Bucket '${bucket}' not found` }, 404);

        if (method === "GET") {
            try {
                const accessToken = await getAccessToken(env);
                const range = request.headers.get("Range") ?? undefined;
                const result = await streamDownloadFromDrive(accessToken, bucket, key, env, range);

                const filename = key.split("/").filter(Boolean).pop() || "download";
                const headers = new Headers({
                    "Content-Type": result.contentType,
                    "Content-Length": result.contentLength || result.size.toString(),
                    ETag: `"${etag(result)}"`,
                    "Accept-Ranges": "bytes",
                    "Content-Disposition": `attachment; filename="${encodeURIComponent(filename)}"`,
                });

                if (result.contentRange) headers.set("Content-Range", result.contentRange);
                if (result.modifiedTime) headers.set("Last-Modified", new Date(result.modifiedTime).toUTCString());

                return new Response(result.body, {
                    status: result.status,
                    headers,
                });
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                if (message.includes("not found") || message.includes("File not found")) {
                    return jsonResponse({ message: "Object not found" }, 404);
                }
                return jsonResponse({ message }, 500);
            }
        }

        if (method === "PUT") {
            try {
                const accessToken = await getAccessToken(env);
                const contentType = request.headers.get("Content-Type") || "application/octet-stream";
                const result = await streamUploadToDrive(accessToken, request, bucket, key, contentType, env);
                await invalidateObjectCaches(env, bucket);
                return jsonResponse(
                    {
                        key,
                        etag: etag(result),
                        size: parseInt(result.size || "0", 10),
                    },
                    200,
                );
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                return jsonResponse({ message }, 500);
            }
        }

        return jsonResponse({ message: "Method Not Allowed" }, 405);
    }

    // 4. POST /api/objects/folder OR DELETE /api/objects/folder
    if (path === "folder") {
        if (method === "POST") {
            let body: { bucket?: string; prefix?: string };
            try {
                body = (await request.json()) as { bucket?: string; prefix?: string };
            } catch {
                return jsonResponse({ message: "Invalid JSON body" }, 400);
            }
            const bucket = body.bucket ?? "";
            let prefix = body.prefix ?? "";
            if (!bucket || !prefix) return jsonResponse({ message: "bucket and prefix are required" }, 400);

            if (!prefix.endsWith("/")) prefix = `${prefix}/`;

            const bucketRecord = await findBucketRecord(env, bucket);
            if (!bucketRecord) return jsonResponse({ message: `Bucket '${bucket}' not found` }, 404);

            try {
                const accessToken = await getAccessToken(env);
                // Check if folder already exists
                const existingResolved = await resolvePathToExistingFolderAndFile(accessToken, bucket, `${prefix}dummy`, env);
                if (existingResolved) {
                    return jsonResponse({ message: "Folder already exists" }, 409);
                }

                // Create folder hierarchy
                const resolved = await resolvePathToFolderAndFile(accessToken, bucket, `${prefix}dummy`, env);
                await invalidateObjectCaches(env, bucket);
                return jsonResponse({ prefix }, 201);
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                return jsonResponse({ message }, 500);
            }
        }

        if (method === "DELETE") {
            const bucket = url.searchParams.get("bucket") ?? "";
            let prefix = url.searchParams.get("prefix") ?? "";
            const recursive = url.searchParams.get("recursive") === "1";
            if (!bucket || !prefix) return jsonResponse({ message: "bucket and prefix query parameters are required" }, 400);

            if (!prefix.endsWith("/")) prefix = `${prefix}/`;

            const bucketRecord = await findBucketRecord(env, bucket);
            if (!bucketRecord) return jsonResponse({ message: `Bucket '${bucket}' not found` }, 404);

            try {
                const accessToken = await getAccessToken(env);
                // Walk to the target folder
                const parts = prefix.split("/").filter(Boolean);
                if (parts.length === 0) {
                    return jsonResponse({ message: "Cannot delete bucket root via folder delete" }, 400);
                }

                let currentFolderId: string | null = bucketRecord.folderId;
                let parentOfTarget: string | null = null;
                const targetFolderName = parts[parts.length - 1];

                for (let i = 0; i < parts.length; i++) {
                    const segment = parts[i];
                    if (!currentFolderId) break;
                    if (i === parts.length - 1) {
                        parentOfTarget = currentFolderId;
                    }
                    currentFolderId = await findFolderId(accessToken, segment, currentFolderId);
                }

                if (!currentFolderId) {
                    return jsonResponse({ message: "Folder not found" }, 404);
                }

                if (!recursive) {
                    const { contents, commonPrefixes } = await listObjects(accessToken, bucket, prefix, env, "/");
                    if (contents.length > 0 || commonPrefixes.length > 0) {
                        return jsonResponse({ message: "Folder is not empty" }, 409);
                    }
                }

                // Update folder to trashed=true
                await updateDriveFile(accessToken, currentFolderId, { trashed: true });
                await invalidateObjectCaches(env, bucket, parentOfTarget ?? undefined, targetFolderName);
                return new Response(null, { status: 204 });
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                return jsonResponse({ message }, 500);
            }
        }

        return jsonResponse({ message: "Method Not Allowed" }, 405);
    }

    // 5. Download ticket: POST /api/objects/download-ticket { bucket, key }
    if (path === "download-ticket") {
        if (method !== "POST") return jsonResponse({ message: "Method Not Allowed" }, 405);
        let body: { bucket?: string; key?: string };
        try {
            body = (await request.json()) as { bucket?: string; key?: string };
        } catch {
            return jsonResponse({ message: "Invalid JSON body" }, 400);
        }

        const bucket = body.bucket ?? "";
        const key = body.key ?? "";
        if (!bucket || !key) return jsonResponse({ message: "bucket and key are required" }, 400);

        const bucketRecord = await findBucketRecord(env, bucket);
        if (!bucketRecord) return jsonResponse({ message: `Bucket '${bucket}' not found` }, 404);

        const tokenBytes = crypto.getRandomValues(new Uint8Array(24));
        const ticket = btoa(String.fromCharCode(...tokenBytes))
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/, "");

        const ticketHash = await sha256Hex(ticket);
        await env.AUTH_KV.put(`dl:${ticketHash}`, JSON.stringify({ bucket, key }), { expirationTtl: 120 });

        const downloadUrl = `/api/objects/content?bucket=${encodeURIComponent(bucket)}&key=${encodeURIComponent(key)}&ticket=${ticket}`;
        return jsonResponse({ ticket, downloadUrl, expiresIn: 120 }, 201);
    }

    // 6. Multipart upload routes
    // POST /api/objects/uploads -> initiate
    // DELETE /api/objects/uploads?bucket=&key=&uploadId= -> abort
    if (path === "uploads") {
        if (method === "POST") {
            let body: { bucket?: string; key?: string; contentType?: string };
            try {
                body = (await request.json()) as { bucket?: string; key?: string; contentType?: string };
            } catch {
                return jsonResponse({ message: "Invalid JSON body" }, 400);
            }
            const bucket = body.bucket ?? "";
            const key = body.key ?? "";
            const contentType = body.contentType || "application/octet-stream";
            if (!bucket || !key) return jsonResponse({ message: "bucket and key are required" }, 400);

            const bucketRecord = await findBucketRecord(env, bucket);
            if (!bucketRecord) return jsonResponse({ message: `Bucket '${bucket}' not found` }, 404);

            try {
                const accessToken = await getAccessToken(env);
                const result = await createMultipartUpload(env, accessToken, bucket, key, contentType);
                if ("kind" in result && result.kind === "error") {
                    return jsonResponse({ message: result.message || result.code }, result.status);
                }
                return jsonResponse(
                    {
                        uploadId: (result as { uploadId: string }).uploadId,
                        bucket,
                        key,
                        partSize: (result as { partSize: number }).partSize,
                    },
                    201,
                );
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                return jsonResponse({ message }, 500);
            }
        }

        if (method === "DELETE") {
            const bucket = url.searchParams.get("bucket") ?? "";
            const key = url.searchParams.get("key") ?? "";
            const uploadId = url.searchParams.get("uploadId") ?? "";
            if (!bucket || !key || !uploadId) return jsonResponse({ message: "bucket, key, and uploadId query parameters are required" }, 400);

            const bucketRecord = await findBucketRecord(env, bucket);
            if (!bucketRecord) return jsonResponse({ message: `Bucket '${bucket}' not found` }, 404);

            const result = await abortMultipartUpload(env, bucket, key, uploadId);
            if (result !== true) {
                return jsonResponse({ message: "Upload not found" }, 404);
            }
            return new Response(null, { status: 204 });
        }

        return jsonResponse({ message: "Method Not Allowed" }, 405);
    }

    // PUT /api/objects/uploads/part?bucket=&key=&uploadId=&partNumber=
    if (path === "uploads/part") {
        if (method !== "PUT") return jsonResponse({ message: "Method Not Allowed" }, 405);
        const bucket = url.searchParams.get("bucket") ?? "";
        const key = url.searchParams.get("key") ?? "";
        const uploadId = url.searchParams.get("uploadId") ?? "";
        const partNumber = parsePositiveInt(url.searchParams.get("partNumber"));
        if (!bucket || !key || !uploadId || !partNumber) return jsonResponse({ message: "bucket, key, uploadId, and partNumber query parameters are required" }, 400);

        const bucketRecord = await findBucketRecord(env, bucket);
        if (!bucketRecord) return jsonResponse({ message: `Bucket '${bucket}' not found` }, 404);

        try {
            const accessToken = await getAccessToken(env);
            const result = await uploadPartCore(request, env, accessToken, bucket, key, uploadId, partNumber);
            if ("kind" in result && result.kind === "error") {
                if (result.code === "SlowDown") {
                    return new Response(JSON.stringify({ message: "SlowDown" }), {
                        status: 503,
                        headers: { "Content-Type": "application/json", "Retry-After": result.retryAfter ?? "1" },
                    });
                }
                return jsonResponse({ message: result.message || result.code }, result.status);
            }
            return jsonResponse({ partNumber, etag: (result as { etag: string }).etag }, 200);
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            return jsonResponse({ message }, 500);
        }
    }

    // POST /api/objects/uploads/complete
    if (path === "uploads/complete") {
        if (method !== "POST") return jsonResponse({ message: "Method Not Allowed" }, 405);
        let body: { bucket?: string; key?: string; uploadId?: string; parts?: Array<{ partNumber: number; etag: string }>; totalSize?: number };
        try {
            body = (await request.json()) as typeof body;
        } catch {
            return jsonResponse({ message: "Invalid JSON body" }, 400);
        }

        const bucket = body.bucket ?? "";
        const key = body.key ?? "";
        const uploadId = body.uploadId ?? "";
        const parts = body.parts ?? [];
        if (!bucket || !key || !uploadId || !Array.isArray(parts)) return jsonResponse({ message: "bucket, key, uploadId, and parts array are required" }, 400);

        const bucketRecord = await findBucketRecord(env, bucket);
        if (!bucketRecord) return jsonResponse({ message: `Bucket '${bucket}' not found` }, 404);

        try {
            const result = await completeMultipartUpload(env, bucket, key, uploadId, parts, body.totalSize);
            if ("kind" in result && result.kind === "error") {
                return jsonResponse({ message: result.message || result.code }, result.status);
            }
            await invalidateObjectCaches(env, bucket);
            return jsonResponse({ key: (result as { key: string }).key, etag: (result as { etag: string }).etag }, 200);
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            return jsonResponse({ message }, 500);
        }
    }

    // GET /api/objects/uploads/parts?bucket=&key=&uploadId=
    if (path === "uploads/parts") {
        if (method !== "GET") return jsonResponse({ message: "Method Not Allowed" }, 405);
        const bucket = url.searchParams.get("bucket") ?? "";
        const key = url.searchParams.get("key") ?? "";
        const uploadId = url.searchParams.get("uploadId") ?? "";
        if (!bucket || !key || !uploadId) return jsonResponse({ message: "bucket, key, and uploadId query parameters are required" }, 400);

        const bucketRecord = await findBucketRecord(env, bucket);
        if (!bucketRecord) return jsonResponse({ message: `Bucket '${bucket}' not found` }, 404);

        const marker = parsePositiveInt(url.searchParams.get("marker"), 0);
        const maxParts = parsePositiveInt(url.searchParams.get("maxParts"), 1000);
        if (marker === undefined || maxParts === undefined || maxParts > 1000) return jsonResponse({ message: "Invalid pagination parameters" }, 400);

        try {
            const result = await listMultipartParts(env, bucket, key, uploadId, marker, maxParts);
            if ("kind" in result && result.kind === "error") {
                return jsonResponse({ message: result.message || result.code }, result.status);
            }
            return jsonResponse(result, 200);
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            return jsonResponse({ message }, 500);
        }
    }

    return jsonResponse({ message: "Not Found" }, 404);
}
