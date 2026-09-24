import { decodedContentLength, isAwsChunked, pumpBody } from "./aws-chunked";
import type { DriveAbout, DriveDownloadResult, DriveFileMetadata, DriveUploadResult, Env, GoogleDriveAboutResponse, GoogleDriveFile, GoogleDriveSearchResponse } from "./types";

interface GoogleTokenResponse {
    access_token: string;
    expires_in: number;
    error_description?: string;
}

interface GoogleDriveCreateResponse {
    id: string;
}

const DRIVE_FIELDS = "id,name,size,mimeType,md5Checksum,modifiedTime";
const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const LIST_NODE_CAP = 5000;
const ROOT_PARENT = "root";
const READ_LOOKUP_TTL = 300;
const DRIVE_MEDIA_TIMEOUT_MS = 30_000;
// Downloads are read as growing Range requests (1, 2, 4 ... 32 MiB) so the first byte arrives quickly.
const FIRST_RANGE_BYTES = 1024 * 1024;
const MAX_RANGE_BYTES = 32 * 1024 * 1024;
// Stays well inside the 50-subrequest limit of the Workers Free plan; larger files get larger ranges instead.
const MAX_RANGE_REQUESTS = 32;
const MAX_RANGE_ATTEMPTS = 3;

async function lookupCacheKey(kind: "folder" | "file", parentId: string | null, name: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([parentId, name])));
    return `drive-lookup:v1:${kind}:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function readLookupCache(env: Env, key: string): Promise<unknown> {
    if (env.ENABLE_READ_CACHE === "false") return undefined;
    try {
        const stored = await env.FOLDER_CACHE.get(key);
        if (!stored) return undefined;
        const entry = JSON.parse(stored);
        if (entry && typeof entry.expiresAt === "number" && entry.expiresAt > Date.now()) return entry.value;
    } catch {
        return undefined;
    }
    return undefined;
}

async function writeLookupCache(env: Env, key: string, value: unknown, startedAt: number): Promise<void> {
    if (env.ENABLE_READ_CACHE === "false" || Date.now() >= startedAt + READ_LOOKUP_TTL * 1000) return;
    try {
        await env.FOLDER_CACHE.put(key, JSON.stringify({ expiresAt: startedAt + READ_LOOKUP_TTL * 1000, value }), { expirationTtl: READ_LOOKUP_TTL });
    } catch {
        console.warn("Drive lookup cache write failed");
    }
}

function isCachedFile(value: unknown, name: string): value is GoogleDriveFile {
    if (!value || typeof value !== "object") return false;
    const file = value as Record<string, unknown>;
    return (
        typeof file.id === "string" &&
        file.id.length > 0 &&
        file.name === name &&
        typeof file.mimeType === "string" &&
        typeof file.size === "string" &&
        /^\d+$/.test(file.size) &&
        (file.md5Checksum === undefined || typeof file.md5Checksum === "string") &&
        (file.modifiedTime === undefined || typeof file.modifiedTime === "string")
    );
}

export async function invalidateDriveFolderCache(env: Env, parentId: string, name: string): Promise<void> {
    await env.FOLDER_CACHE.delete(`${parentId}/${name}`);
    await env.FOLDER_CACHE.delete(await lookupCacheKey("folder", parentId, name));
}

export async function invalidateDriveObjectCache(env: Env, bucket: string, parentId: string, name: string): Promise<void> {
    await env.FOLDER_CACHE.delete(await lookupCacheKey("file", parentId, name));
    await env.FOLDER_CACHE.delete(`bucket-stats:${bucket}`);
}

function driveLiteral(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function driveFilesUrl(q: string, fields: string, pageToken?: string): string {
    const url = new URL("https://www.googleapis.com/drive/v3/files");
    url.searchParams.set("q", q);
    url.searchParams.set("pageSize", "1000");
    const fieldsWithPageToken = fields.includes("nextPageToken") ? fields : `nextPageToken,${fields}`;
    url.searchParams.set("fields", fieldsWithPageToken);
    if (pageToken) {
        url.searchParams.set("pageToken", pageToken);
    }
    return url.toString();
}

/** Fetches an OAuth access token, using the KV-cached one when available. */
export async function getAccessToken(env: Env): Promise<string> {
    const cacheKey = "google_access_token";

    const cachedToken = await env.AUTH_KV.get(cacheKey);
    if (cachedToken) {
        return cachedToken;
    }

    const response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            client_id: env.GOOGLE_CLIENT_ID,
            client_secret: env.GOOGLE_CLIENT_SECRET,
            refresh_token: env.GOOGLE_REFRESH_TOKEN,
            grant_type: "refresh_token",
        }),
    });

    const data: GoogleTokenResponse = await response.json();
    if (!response.ok) {
        throw new Error(`Token Error: ${data.error_description}`);
    }

    await env.AUTH_KV.put(cacheKey, data.access_token, {
        expirationTtl: data.expires_in - 60,
    });

    return data.access_token;
}

/** Resolve (tạo nếu chưa có) folder gốc chứa toàn bộ bucket. Throw nếu chưa cấu hình. */
export async function getRootFolderId(accessToken: string, env: Env): Promise<string> {
    if (!env.DRIVE_ROOT_FOLDER || env.DRIVE_ROOT_FOLDER.trim() === "") {
        throw new Error("Storage root folder is not configured");
    }
    const rootName = env.DRIVE_ROOT_FOLDER.trim();
    const cacheKey = `root:${rootName}`;
    const cached = await env.FOLDER_CACHE.get(cacheKey);
    if (cached) return cached;

    const id = await getOrCreateFolder(accessToken, rootName, ROOT_PARENT, env);
    await env.FOLDER_CACHE.put(cacheKey, id, { expirationTtl: 3600 });
    return id;
}

/** Folder của bucket, tạo nếu chưa có — dùng cho write path. */
export async function getBucketFolderId(accessToken: string, bucket: string, env: Env): Promise<string> {
    const rootFolderId = await getRootFolderId(accessToken, env);
    return await getOrCreateFolder(accessToken, bucket, rootFolderId, env);
}

/** Folder của bucket, null nếu chưa tồn tại — dùng cho list/stat path. */
export async function findBucketFolderId(accessToken: string, bucket: string, env: Env): Promise<string | null> {
    const rootFolderId = await getRootFolderId(accessToken, env);
    return await findFolderId(accessToken, bucket, rootFolderId);
}

/** Finds a folder by name under the given parent without creating it. Returns null if absent. */
export async function findFolderId(accessToken: string, folderName: string, parentId: string | null, env?: Env): Promise<string | null> {
    const startedAt = Date.now();
    const cacheKey = env && env.ENABLE_READ_CACHE !== "false" ? await lookupCacheKey("folder", parentId, folderName) : undefined;
    if (env && cacheKey) {
        const cached = await readLookupCache(env, cacheKey);
        if (typeof cached === "string" && cached.length > 0) return cached;
    }

    const parentQuery = parentId ? ` and '${parentId}' in parents` : "";
    const searchRes = await fetch(driveFilesUrl(`name='${driveLiteral(folderName)}' and mimeType='${FOLDER_MIME_TYPE}' and trashed=false${parentQuery}`, "files(id,name)"), {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!searchRes.ok) throw new Error(`Drive folder search failed: ${await searchRes.text()}`);

    const searchData: GoogleDriveSearchResponse = await searchRes.json();
    const folderId = searchData.files && searchData.files.length > 0 ? searchData.files[0].id : null;
    if (folderId && env && cacheKey) await writeLookupCache(env, cacheKey, folderId, startedAt);
    return folderId;
}

/** Finds a folder by name under the given parent, creating it if it doesn't exist yet. */
export async function getOrCreateFolder(accessToken: string, folderName: string, parentId: string | null, env: Env): Promise<string> {
    // Include parentId in the cache key so folders with the same name in different parents don't collide.
    const cacheKey = parentId ? `${parentId}/${folderName}` : folderName;
    const cached = await env.FOLDER_CACHE.get(cacheKey);
    if (cached) return cached;

    const found = await findFolderId(accessToken, folderName, parentId);
    if (found) {
        await env.FOLDER_CACHE.put(cacheKey, found, { expirationTtl: 3600 });
        await writeLookupCache(env, await lookupCacheKey("folder", parentId, folderName), found, Date.now());
        return found;
    }

    const createBody: { name: string; mimeType: string; parents?: string[] } = {
        name: folderName,
        mimeType: FOLDER_MIME_TYPE,
    };

    if (parentId) {
        createBody.parents = [parentId];
    }

    const createRes = await fetch("https://www.googleapis.com/drive/v3/files", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(createBody),
    });
    if (!createRes.ok) throw new Error(`Drive folder creation failed: ${await createRes.text()}`);

    const createData: GoogleDriveCreateResponse = await createRes.json();
    await env.FOLDER_CACHE.put(cacheKey, createData.id, { expirationTtl: 3600 });
    await writeLookupCache(env, await lookupCacheKey("folder", parentId, folderName), createData.id, Date.now());
    return createData.id;
}

export async function listFolderChildren(accessToken: string, folderId: string, fields = "files(id,name,mimeType,size,modifiedTime,createdTime,appProperties)"): Promise<GoogleDriveFile[]> {
    const allFiles: GoogleDriveFile[] = [];
    let pageToken: string | undefined;

    do {
        const listRes = await fetch(driveFilesUrl(`'${driveLiteral(folderId)}' in parents and trashed=false`, fields, pageToken), {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!listRes.ok) throw new Error(`Drive list failed: ${await listRes.text()}`);

        const data: GoogleDriveSearchResponse = await listRes.json();
        if (data.files) {
            allFiles.push(...data.files);
        }
        pageToken = data.nextPageToken;
    } while (pageToken);

    return allFiles;
}

export async function folderHasChildren(accessToken: string, folderId: string): Promise<boolean> {
    const url = new URL("https://www.googleapis.com/drive/v3/files");
    url.searchParams.set("q", `'${driveLiteral(folderId)}' in parents and trashed=false`);
    url.searchParams.set("pageSize", "1");
    url.searchParams.set("fields", "files(id)");
    const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`Drive folder child check failed: ${await res.text()}`);
    const data: GoogleDriveSearchResponse = await res.json();
    return Boolean(data.files && data.files.length > 0);
}

export async function updateDriveFile(accessToken: string, fileId: string, body: Record<string, unknown>, params?: { addParents?: string; removeParents?: string }): Promise<GoogleDriveFile> {
    const url = new URL(`https://www.googleapis.com/drive/v3/files/${fileId}`);
    url.searchParams.set("fields", "id,name,mimeType,size,modifiedTime,createdTime,appProperties,trashed");
    if (params?.addParents) url.searchParams.set("addParents", params.addParents);
    if (params?.removeParents) url.searchParams.set("removeParents", params.removeParents);

    const res = await fetch(url.toString(), {
        method: "PATCH",
        headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Drive file update failed: ${await res.text()}`);
    return (await res.json()) as GoogleDriveFile;
}

/** Resolves an S3 object key to its existing parent folder ID without creating folders. Returns null if parent hierarchy doesn't exist. */
export async function resolvePathToExistingFolderAndFile(accessToken: string, bucket: string, objectKey: string, env: Env, bucketFolderId?: string, useReadCache = true): Promise<{ parentFolderId: string; fileName: string } | null> {
    let currentFolderId = bucketFolderId ?? (await findBucketFolderId(accessToken, bucket, env));
    if (!currentFolderId) return null;

    const parts = objectKey.split("/").filter((p) => p);
    if (parts.length === 0) {
        throw new Error("Invalid object key");
    }

    const fileName = parts[parts.length - 1];
    const directories = parts.slice(0, -1);

    for (const dir of directories) {
        const nextFolderId = await findFolderId(accessToken, dir, currentFolderId, useReadCache ? env : undefined);
        if (!nextFolderId) return null;
        currentFolderId = nextFolderId;
    }

    return {
        parentFolderId: currentFolderId,
        fileName: fileName,
    };
}

/** Resolves an S3 object key to its parent folder ID, creating the directory hierarchy as needed. */
export async function resolvePathToFolderAndFile(accessToken: string, bucket: string, objectKey: string, env: Env): Promise<{ parentFolderId: string; fileName: string }> {
    let currentFolderId = await getBucketFolderId(accessToken, bucket, env);

    const parts = objectKey.split("/").filter((p) => p);

    if (parts.length === 0) {
        throw new Error("Invalid object key");
    }

    const fileName = parts[parts.length - 1];
    const directories = parts.slice(0, -1);

    for (const dir of directories) {
        currentFolderId = await getOrCreateFolder(accessToken, dir, currentFolderId, env);
    }

    return {
        parentFolderId: currentFolderId,
        fileName: fileName,
    };
}

export async function streamUploadToDrive(accessToken: string, request: Request, bucket: string, objectKey: string, mimeType: string, env: Env): Promise<DriveUploadResult> {
    const { parentFolderId, fileName } = await resolvePathToFolderAndFile(accessToken, bucket, objectKey, env);
    const existing = await findFileInFolder(accessToken, parentFolderId, fileName);
    const initUrl = existing ? `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=resumable&fields=${encodeURIComponent(DRIVE_FIELDS)}` : `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=${encodeURIComponent(DRIVE_FIELDS)}`;
    const decodedLength = decodedContentLength(request);

    // Initialize a resumable upload session.
    const initRes = await fetch(initUrl, {
        method: existing ? "PATCH" : "POST",
        headers: {
            Authorization: `Bearer ${accessToken}`,
            "X-Upload-Content-Type": mimeType,
            ...(decodedLength === undefined ? {} : { "X-Upload-Content-Length": decodedLength.toString() }),
            "Content-Type": "application/json; charset=UTF-8",
        },
        body: JSON.stringify(existing ? { name: fileName } : { name: fileName, parents: [parentFolderId] }),
    });

    const uploadUrl = initRes.headers.get("Location");
    if (!uploadUrl) {
        console.error(initRes.status);
        console.error(await initRes.text());
        throw new Error("Failed to get upload URL");
    }

    let uploadRes: Response;
    if (isAwsChunked(request)) {
        if (decodedLength === undefined) throw new Error("x-amz-decoded-content-length is required for aws-chunked uploads");
        const decoded = new FixedLengthStream(decodedLength, { highWaterMark: 1 << 20 });
        const uploadPromise = fetch(uploadUrl, {
            method: "PUT",
            headers: { Authorization: `Bearer ${accessToken}`, "Content-Length": decodedLength.toString() },
            body: decoded.readable,
            duplex: "half",
        } as RequestInit);
        await pumpBody(request.body, decoded.writable.getWriter(), { awsChunked: true, expectedLength: decodedLength });
        uploadRes = await uploadPromise;
    } else {
        const body = request.body ?? new Uint8Array();
        uploadRes = await fetch(uploadUrl, {
            method: "PUT",
            headers: { Authorization: `Bearer ${accessToken}`, ...(decodedLength === undefined ? {} : { "Content-Length": decodedLength.toString() }) },
            body,
            duplex: "half",
        } as RequestInit);
    }

    if (!uploadRes.ok) {
        const errorText = await uploadRes.text();
        throw new Error(`Upload failed: ${errorText}`);
    }

    const uploaded = await uploadRes.json<DriveUploadResult>();
    await invalidateDriveObjectCache(env, bucket, parentFolderId, fileName);
    return uploaded;
}

export async function findFileInFolder(accessToken: string, folderId: string, fileName: string, env?: Env): Promise<GoogleDriveFile | null> {
    const startedAt = Date.now();
    const cacheKey = env && env.ENABLE_READ_CACHE !== "false" ? await lookupCacheKey("file", folderId, fileName) : undefined;
    if (env && cacheKey) {
        const cached = await readLookupCache(env, cacheKey);
        if (isCachedFile(cached, fileName)) return cached;
    }

    const searchRes = await fetch(driveFilesUrl(`name='${driveLiteral(fileName)}' and '${driveLiteral(folderId)}' in parents and trashed=false`, `files(${DRIVE_FIELDS})`), {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!searchRes.ok) throw new Error(`Drive file search failed: ${await searchRes.text()}`);

    const data: GoogleDriveSearchResponse = await searchRes.json();
    const file = data.files && data.files.length > 0 ? data.files[0] : null;
    if (file && env && cacheKey) await writeLookupCache(env, cacheKey, file, startedAt);
    return file;
}

export async function streamDownloadFromDrive(accessToken: string, bucket: string, objectKey: string, env: Env, range?: string, bucketFolderId?: string, useReadCache = true): Promise<DriveDownloadResult> {
    const pathStartedAt = performance.now();
    const resolved = await resolvePathToExistingFolderAndFile(accessToken, bucket, objectKey, env, bucketFolderId, useReadCache);
    const pathDuration = performance.now() - pathStartedAt;
    if (!resolved) {
        throw new Error("File not found");
    }
    const { parentFolderId, fileName } = resolved;
    const fileStartedAt = performance.now();
    const file = await findFileInFolder(accessToken, parentFolderId, fileName, useReadCache ? env : undefined);
    const fileDuration = performance.now() - fileStartedAt;

    if (!file) {
        throw new Error("File not found");
    }

    const size = parseInt(file.size || "0", 10);
    const requested = parseByteRange(range, size);
    const start = requested?.start ?? 0;
    const end = requested?.end ?? size - 1;
    const firstEnd = Math.min(end, start + FIRST_RANGE_BYTES - 1);

    // Always read ranges: a plain alt=media GET of a large file can wait ~30s for its first byte, which callers
    // such as Forgejo (30s PER_WRITE_TIMEOUT, and two GETs per attachment download) cannot tolerate.
    const mediaStartedAt = performance.now();
    const downloadRes = await fetchDriveMedia(accessToken, file.id, size === 0 ? undefined : `bytes=${start}-${firstEnd}`);
    const mediaDuration = performance.now() - mediaStartedAt;

    // A 416 or a different total size means the cached metadata no longer describes the live file.
    if (downloadRes.status === 404 || downloadRes.status === 416 || (downloadRes.status === 206 && !isDriveRange(downloadRes, start, firstEnd, size))) {
        await downloadRes.body?.cancel();
        if (useReadCache && env.ENABLE_READ_CACHE !== "false") {
            await invalidateDriveObjectCache(env, bucket, parentFolderId, fileName);
            return streamDownloadFromDrive(accessToken, bucket, objectKey, env, range, bucketFolderId, false);
        }
        if (downloadRes.status === 404) throw new Error("File not found");
        console.error(JSON.stringify({ message: "drive media changed during download", status: downloadRes.status }));
        throw new Error("Download failed");
    }

    // Drive answering 200 to a Range request means it sent the whole file, usable only for a full download.
    if (!downloadRes.ok || (downloadRes.status === 200 && requested)) {
        console.error(downloadRes.status);
        console.error(await downloadRes.text());
        throw new Error("Download failed");
    }
    if (!downloadRes.body) throw new Error("Download response had no body");

    const length = end - start + 1;
    const complete = downloadRes.status === 200 || firstEnd === end;
    return {
        body: complete ? downloadRes.body : streamDriveRanges(env, accessToken, file.id, size, downloadRes.body, firstEnd + 1, end, length),
        contentType: file.mimeType || "application/octet-stream",
        size,
        id: file.id,
        md5Checksum: file.md5Checksum,
        modifiedTime: file.modifiedTime,
        status: requested ? 206 : 200,
        contentRange: requested ? `bytes ${start}-${end}/${size}` : undefined,
        contentLength: length.toString(),
        serverTiming: `path;dur=${pathDuration.toFixed(1)}, file;dur=${fileDuration.toFixed(1)}, media;dur=${mediaDuration.toFixed(1)}`,
    };
}

export class RangeNotSatisfiableError extends Error {
    constructor(readonly size: number) {
        super("Requested range not satisfiable");
    }
}

/** Resolves a single `bytes=` range against the object size. Absent, malformed and multi-range headers return null (serve the whole object), as S3 does. */
export function parseByteRange(header: string | undefined, size: number): { start: number; end: number } | null {
    const match = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
    if (!match || (match[1] === "" && match[2] === "")) return null;
    if (match[1] === "") {
        const suffix = Number(match[2]);
        if (suffix === 0 || size === 0) throw new RangeNotSatisfiableError(size);
        return { start: Math.max(0, size - suffix), end: size - 1 };
    }
    const start = Number(match[1]);
    if (match[2] !== "" && Number(match[2]) < start) return null;
    if (start >= size) throw new RangeNotSatisfiableError(size);
    return { start, end: match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1) };
}

async function fetchDriveMedia(accessToken: string, fileId: string, range?: string): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
        controller.abort();
    }, DRIVE_MEDIA_TIMEOUT_MS);
    try {
        return await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
            headers: { Authorization: `Bearer ${accessToken}`, ...(range ? { Range: range } : {}) },
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timeout);
    }
}

function isDriveRange(response: Response, start: number, end: number, size: number): boolean {
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("Content-Range") ?? "");
    return match !== null && Number(match[1]) === start && Number(match[2]) === end && Number(match[3]) === size;
}

/** Streams bytes [from, end] after the already-open first range, fetching the next range while the current one is piped. */
function streamDriveRanges(env: Env, accessToken: string, fileId: string, size: number, first: ReadableStream, from: number, end: number, length: number): ReadableStream {
    const { readable, writable } = new FixedLengthStream(length);
    let token = accessToken;
    let offset = from;
    let chunkSize = FIRST_RANGE_BYTES;
    let requestsLeft = MAX_RANGE_REQUESTS - 1;

    const fetchRange = async (rangeStart: number, rangeEnd: number): Promise<ReadableStream> => {
        for (let attempt = 1; ; attempt++) {
            let status = 0;
            try {
                const response = await fetchDriveMedia(token, fileId, `bytes=${rangeStart}-${rangeEnd}`);
                if (response.body && response.status === 206 && isDriveRange(response, rangeStart, rangeEnd, size)) return response.body;
                status = response.status;
                await response.body?.cancel();
            } catch (error) {
                if (attempt >= MAX_RANGE_ATTEMPTS) throw error;
            }
            const retryable = status === 0 || status === 401 || status === 429 || status >= 500;
            if (!retryable || attempt >= MAX_RANGE_ATTEMPTS) {
                console.error(JSON.stringify({ message: "drive range read failed", status, attempt }));
                throw new Error(`Drive range read returned ${status}`);
            }
            if (status === 401) {
                // The cached token can expire while a long download is still streaming.
                await env.AUTH_KV.delete("google_access_token");
                token = await getAccessToken(env);
            } else {
                await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
            }
        }
    };

    const nextRange = (): Promise<ReadableStream> | undefined => {
        if (offset > end) return undefined;
        chunkSize = Math.max(Math.min(chunkSize * 2, MAX_RANGE_BYTES), Math.ceil((end - offset + 1) / Math.max(1, requestsLeft)));
        const rangeStart = offset;
        const rangeEnd = Math.min(end, offset + chunkSize - 1);
        offset = rangeEnd + 1;
        requestsLeft--;
        const pending = fetchRange(rangeStart, rangeEnd);
        pending.catch(() => {});
        return pending;
    };

    const pump = async () => {
        let body = first;
        let next: Promise<ReadableStream> | undefined;
        try {
            for (;;) {
                next = nextRange();
                await body.pipeTo(writable, { preventClose: true });
                if (!next) break;
                body = await next;
                next = undefined;
            }
            await writable.close();
        } catch (error) {
            // Either the client went away or Drive failed mid-stream; the client sees a short body and can retry.
            next?.then((stream) => stream.cancel()).catch(() => {});
            await writable.abort(error).catch(() => {});
        }
    };
    void pump();
    return readable;
}

export async function deleteFromDrive(accessToken: string, bucket: string, objectKey: string, env: Env): Promise<void> {
    const resolved = await resolvePathToExistingFolderAndFile(accessToken, bucket, objectKey, env, undefined, false);
    if (!resolved) {
        throw new Error("File not found");
    }
    const { parentFolderId, fileName } = resolved;
    const file = await findFileInFolder(accessToken, parentFolderId, fileName);

    if (!file) {
        throw new Error("File not found");
    }

    const deleteRes = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!deleteRes.ok) {
        throw new Error("Delete failed");
    }
    await invalidateDriveObjectCache(env, bucket, parentFolderId, fileName);
}

export async function getFileMetadata(accessToken: string, bucket: string, objectKey: string, env: Env, bucketFolderId?: string): Promise<DriveFileMetadata> {
    const pathStartedAt = performance.now();
    const resolved = await resolvePathToExistingFolderAndFile(accessToken, bucket, objectKey, env, bucketFolderId);
    const pathDuration = performance.now() - pathStartedAt;
    if (!resolved) {
        throw new Error("File not found");
    }
    const { parentFolderId, fileName } = resolved;
    const fileStartedAt = performance.now();
    const file = await findFileInFolder(accessToken, parentFolderId, fileName, env);
    const fileDuration = performance.now() - fileStartedAt;

    if (!file) {
        throw new Error("File not found");
    }

    return {
        id: file.id,
        mimeType: file.mimeType || "application/octet-stream",
        size: parseInt(file.size || "0", 10),
        md5Checksum: file.md5Checksum,
        modifiedTime: file.modifiedTime,
        serverTiming: `path;dur=${pathDuration.toFixed(1)}, file;dur=${fileDuration.toFixed(1)}`,
    };
}

async function listChildren(accessToken: string, folderId: string): Promise<GoogleDriveFile[]> {
    const allFiles: GoogleDriveFile[] = [];
    let pageToken: string | undefined;

    do {
        const listRes = await fetch(driveFilesUrl(`'${driveLiteral(folderId)}' in parents and trashed=false`, "files(id,name,mimeType,size,modifiedTime,md5Checksum)", pageToken), {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!listRes.ok) throw new Error(`Drive list failed: ${await listRes.text()}`);

        const data: GoogleDriveSearchResponse = await listRes.json();
        if (data.files) {
            allFiles.push(...data.files);
        }
        pageToken = data.nextPageToken;
    } while (pageToken);

    return allFiles;
}

/** Splits an S3 prefix into the directory portion (real Drive folder path) and the partial name filter for the final segment. */
function splitPrefix(prefix: string): { dirPrefix: string; partial: string } {
    const index = prefix.lastIndexOf("/");
    return index === -1 ? { dirPrefix: "", partial: prefix } : { dirPrefix: prefix.slice(0, index + 1), partial: prefix.slice(index + 1) };
}

/** Walks an existing (read-only) folder path under the bucket; returns null if any segment is missing. */
async function resolvePrefixFolder(accessToken: string, bucket: string, dirParts: string[], env: Env, bucketFolderId?: string): Promise<string | null> {
    let folderId = bucketFolderId ?? (await findBucketFolderId(accessToken, bucket, env));
    for (const part of dirParts) {
        if (folderId === null) return null;
        folderId = await findFolderId(accessToken, part, folderId);
    }
    return folderId;
}

export interface ListedObject extends GoogleDriveFile {
    key: string;
}

/** Lists objects under a bucket, honoring an S3-style prefix and an optional single-level delimiter. */
export async function listObjects(accessToken: string, bucket: string, prefix: string, env: Env, delimiter?: string, bucketFolderId?: string): Promise<{ contents: ListedObject[]; commonPrefixes: string[]; truncated: boolean }> {
    const { dirPrefix, partial } = splitPrefix(prefix);
    const dirParts = dirPrefix.split("/").filter((part) => part !== "");
    const folderId = await resolvePrefixFolder(accessToken, bucket, dirParts, env, bucketFolderId);
    if (folderId === null) return { contents: [], commonPrefixes: [], truncated: false };

    const contents: ListedObject[] = [];
    const commonPrefixes = new Set<string>();
    let truncated = false;
    let scanned = 0;

    async function walk(currentFolderId: string, keyPrefix: string, applyPartialFilter: boolean): Promise<void> {
        const children = await listChildren(accessToken, currentFolderId);
        for (const child of children) {
            if (applyPartialFilter && !child.name.startsWith(partial)) continue;
            if (++scanned > LIST_NODE_CAP) {
                truncated = true;
                return;
            }
            const childKey = `${keyPrefix}${child.name}`;
            if (child.mimeType === FOLDER_MIME_TYPE) {
                if (delimiter) {
                    commonPrefixes.add(`${childKey}${delimiter}`);
                } else {
                    await walk(child.id, `${childKey}/`, false);
                }
            } else {
                contents.push({ ...child, key: childKey });
            }
            if (truncated) return;
        }
    }

    await walk(folderId, dirPrefix, true);
    return { contents, commonPrefixes: [...commonPrefixes].sort(), truncated };
}

/** Fetches Google Drive account and storage quota details. */
export async function getDriveAbout(accessToken: string): Promise<DriveAbout> {
    const url = new URL("https://www.googleapis.com/drive/v3/about");
    url.searchParams.set("fields", "user(displayName,emailAddress),storageQuota(limit,usage,usageInDrive,usageInDriveTrash)");

    const response = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
        throw new Error(`Drive about request failed: ${await response.text()}`);
    }

    const data: GoogleDriveAboutResponse = await response.json();
    const quota = data.storageQuota;
    const limit = quota?.limit !== undefined && quota?.limit !== null ? parseInt(quota.limit, 10) : null;
    const usage = quota?.usage ? parseInt(quota.usage, 10) : 0;
    const usageInDrive = quota?.usageInDrive ? parseInt(quota.usageInDrive, 10) : 0;
    const usageInDriveTrash = quota?.usageInDriveTrash ? parseInt(quota.usageInDriveTrash, 10) : 0;

    const free = limit !== null ? Math.max(0, limit - usage) : null;
    const percentUsed = limit !== null && limit > 0 ? Math.round((usage / limit) * 1000) / 10 : null;

    return {
        user: {
            emailAddress: data.user?.emailAddress ?? null,
            displayName: data.user?.displayName ?? null,
        },
        storageQuota: {
            limit,
            usage,
            usageInDrive,
            usageInDriveTrash,
            free,
            percentUsed,
        },
    };
}
