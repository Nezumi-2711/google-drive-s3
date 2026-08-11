import type { DriveUploadResult } from "./types";

export const DRIVE_CHUNK_SIZE = 256 * 1024;
const DRIVE_FIELDS = "id,name,size,mimeType,md5Checksum";

export function alignedSendLen(driveOffset: number, available: number): number {
    if (available <= 1) return 0;
    return Math.max(0, Math.floor((driveOffset + available - 1) / DRIVE_CHUNK_SIZE) * DRIVE_CHUNK_SIZE - driveOffset);
}

export async function createSession(accessToken: string, metadata: { name: string; parents: string[]; mimeType: string; existingFileId?: string }): Promise<string> {
    const url = metadata.existingFileId ? `https://www.googleapis.com/upload/drive/v3/files/${metadata.existingFileId}?uploadType=resumable&fields=${encodeURIComponent(DRIVE_FIELDS)}` : `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=${encodeURIComponent(DRIVE_FIELDS)}`;
    const response = await fetch(url, {
        method: metadata.existingFileId ? "PATCH" : "POST",
        headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json; charset=UTF-8",
            "X-Upload-Content-Type": metadata.mimeType,
        },
        body: JSON.stringify(metadata.existingFileId ? { name: metadata.name } : { name: metadata.name, parents: metadata.parents }),
    });
    const uploadUrl = response.headers.get("Location");
    if (!response.ok || !uploadUrl) throw new Error(`Failed to create Drive resumable session (${response.status})`);
    return uploadUrl;
}

export function nextDriveOffset(response: Response): number {
    const range = response.headers.get("Range");
    if (!range) return 0;
    const match = /^bytes=0-(\d+)$/.exec(range);
    if (!match) throw new Error("Drive returned an invalid committed range");
    return Number(match[1]) + 1;
}

export async function queryStatus(uploadUrl: string, accessToken: string): Promise<number> {
    const response = await fetch(uploadUrl, {
        method: "PUT",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Length": "0", "Content-Range": "bytes */*" },
    });
    if (response.status === 308) return nextDriveOffset(response);
    if (response.ok) {
        const metadata = await response.json<DriveUploadResult>();
        return Number(metadata.size ?? 0);
    }
    throw new Error(`Drive resumable status query failed (${response.status})`);
}

export async function putFinalChunk(uploadUrl: string, accessToken: string, startOffset: number, total: number, body: Uint8Array): Promise<DriveUploadResult> {
    const response = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Length": body.byteLength.toString(),
            "Content-Range": `bytes ${startOffset}-${total - 1}/${total}`,
        },
        body,
    });
    if (!response.ok) throw new Error(`Drive final chunk failed (${response.status}): ${await response.text()}`);
    return await response.json<DriveUploadResult>();
}

export async function createEmptyFile(accessToken: string, metadata: { name: string; parents: string[]; mimeType: string; existingFileId?: string }): Promise<DriveUploadResult> {
    const url = metadata.existingFileId ? `https://www.googleapis.com/drive/v3/files/${metadata.existingFileId}?fields=${encodeURIComponent(DRIVE_FIELDS)}` : `https://www.googleapis.com/drive/v3/files?fields=${encodeURIComponent(DRIVE_FIELDS)}`;
    const response = await fetch(url, {
        method: metadata.existingFileId ? "PATCH" : "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(metadata.existingFileId ? { name: metadata.name } : { name: metadata.name, parents: metadata.parents, mimeType: metadata.mimeType }),
    });
    if (!response.ok) throw new Error(`Drive empty-file creation failed (${response.status})`);
    return await response.json<DriveUploadResult>();
}

export async function cancelSession(uploadUrl: string, accessToken: string): Promise<void> {
    const response = await fetch(uploadUrl, { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } });
    if (response.status !== 499 && !response.ok && response.status !== 404) throw new Error(`Drive resumable cancellation failed (${response.status})`);
}
