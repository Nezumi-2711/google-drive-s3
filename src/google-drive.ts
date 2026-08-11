import { decodedContentLength, isAwsChunked, pumpBody } from "./aws-chunked";
import type { DriveDownloadResult, DriveFileMetadata, DriveUploadResult, Env, GoogleDriveFile, GoogleDriveSearchResponse } from "./types";

interface GoogleTokenResponse {
    access_token: string;
    expires_in: number;
    error_description?: string;
}

interface GoogleDriveCreateResponse {
    id: string;
}

const DRIVE_FIELDS = "id,name,size,mimeType,md5Checksum";

function driveLiteral(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function driveFilesUrl(q: string, fields: string): string {
    const url = new URL("https://www.googleapis.com/drive/v3/files");
    url.searchParams.set("q", q);
    url.searchParams.set("fields", fields);
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

/** Finds a folder by name under the given parent, creating it if it doesn't exist yet. */
async function getOrCreateFolder(accessToken: string, folderName: string, parentId: string | null, env: Env): Promise<string> {
    // Include parentId in the cache key so folders with the same name in different parents don't collide.
    const cacheKey = parentId ? `${parentId}/${folderName}` : folderName;
    const cached = await env.FOLDER_CACHE.get(cacheKey);
    if (cached) return cached;

    const parentQuery = parentId ? ` and '${parentId}' in parents` : "";
    const searchRes = await fetch(driveFilesUrl(`name='${driveLiteral(folderName)}' and mimeType='application/vnd.google-apps.folder' and trashed=false${parentQuery}`, "files(id,name)"), {
        headers: { Authorization: `Bearer ${accessToken}` },
    });

    const searchData: GoogleDriveSearchResponse = await searchRes.json();

    if (searchData.files && searchData.files.length > 0) {
        const folderId = searchData.files[0].id;
        await env.FOLDER_CACHE.put(cacheKey, folderId, { expirationTtl: 3600 });
        return folderId;
    }

    const createBody: { name: string; mimeType: string; parents?: string[] } = {
        name: folderName,
        mimeType: "application/vnd.google-apps.folder",
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

    const createData: GoogleDriveCreateResponse = await createRes.json();
    await env.FOLDER_CACHE.put(cacheKey, createData.id, { expirationTtl: 3600 });
    return createData.id;
}

/** Resolves an S3 object key to its parent folder ID, creating the directory hierarchy as needed. */
export async function resolvePathToFolderAndFile(accessToken: string, bucket: string, objectKey: string, env: Env): Promise<{ parentFolderId: string; fileName: string }> {
    let currentFolderId = await getOrCreateFolder(accessToken, bucket, null, env);

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

    return await uploadRes.json();
}

export async function findFileInFolder(accessToken: string, folderId: string, fileName: string): Promise<GoogleDriveFile | null> {
    const searchRes = await fetch(driveFilesUrl(`name='${driveLiteral(fileName)}' and '${driveLiteral(folderId)}' in parents and trashed=false`, `files(${DRIVE_FIELDS})`), {
        headers: { Authorization: `Bearer ${accessToken}` },
    });

    const data: GoogleDriveSearchResponse = await searchRes.json();
    return data.files && data.files.length > 0 ? data.files[0] : null;
}

export async function streamDownloadFromDrive(accessToken: string, bucket: string, objectKey: string, env: Env, range?: string): Promise<DriveDownloadResult> {
    const { parentFolderId, fileName } = await resolvePathToFolderAndFile(accessToken, bucket, objectKey, env);
    const file = await findFileInFolder(accessToken, parentFolderId, fileName);

    if (!file) {
        throw new Error("File not found");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => {
        controller.abort();
    }, 30000);

    const downloadRes = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`, {
        headers: { Authorization: `Bearer ${accessToken}`, ...(range ? { Range: range } : {}) },
        signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!downloadRes.ok) {
        console.error(downloadRes.status);
        console.error(await downloadRes.text());
        throw new Error("Download failed");
    }

    return {
        body: downloadRes.body!,
        contentType: file.mimeType || "application/octet-stream",
        size: parseInt(file.size || "0", 10),
        id: file.id,
        md5Checksum: file.md5Checksum,
        status: downloadRes.status,
        contentRange: downloadRes.headers.get("Content-Range") ?? undefined,
        contentLength: downloadRes.headers.get("Content-Length") ?? undefined,
    };
}

export async function deleteFromDrive(accessToken: string, bucket: string, objectKey: string, env: Env): Promise<void> {
    const { parentFolderId, fileName } = await resolvePathToFolderAndFile(accessToken, bucket, objectKey, env);
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
}

export async function getFileMetadata(accessToken: string, bucket: string, objectKey: string, env: Env): Promise<DriveFileMetadata> {
    const { parentFolderId, fileName } = await resolvePathToFolderAndFile(accessToken, bucket, objectKey, env);
    const file = await findFileInFolder(accessToken, parentFolderId, fileName);

    if (!file) {
        throw new Error("File not found");
    }

    return {
        id: file.id,
        mimeType: file.mimeType || "application/octet-stream",
        size: parseInt(file.size || "0", 10),
        md5Checksum: file.md5Checksum,
    };
}

export async function listFiles(accessToken: string, bucket: string, env: Env): Promise<GoogleDriveFile[]> {
    const folderId = await getOrCreateFolder(accessToken, bucket, null, env);

    const listRes = await fetch(driveFilesUrl(`'${driveLiteral(folderId)}' in parents and trashed=false`, "files(id,name,mimeType,size,modifiedTime,md5Checksum)"), {
        headers: { Authorization: `Bearer ${accessToken}` },
    });

    const data: GoogleDriveSearchResponse = await listRes.json();
    return data.files || [];
}
