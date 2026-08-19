import { folderHasChildren, getAccessToken, getOrCreateFolder, getRootFolderId, listFolderChildren, updateDriveFile } from "./google-drive";
import type { Env } from "./types";

export interface BucketRecord {
    name: string;
    folderId: string;
    publicRead: boolean;
    createdTime: string | null;
}

export const RESERVED_BUCKET_NAMES = ["auth", "api", "docs"] as const;

const BUCKET_REGISTRY_CACHE_KEY = "bucket-registry";
const BUCKET_REGISTRY_TTL = 60; // 60 seconds

/**
 * Validates bucket name format.
 * 3-63 chars, lowercase alphanumeric or hyphens, no adjacent hyphens, not formatted as IP.
 * Returns null if valid, error message otherwise.
 */
export function validateBucketName(name: string): string | null {
    if (!name || typeof name !== "string") {
        return "Bucket name is required";
    }
    if (name.length < 3 || name.length > 63) {
        return "Bucket name must be between 3 and 63 characters long";
    }
    if (RESERVED_BUCKET_NAMES.includes(name.toLowerCase() as (typeof RESERVED_BUCKET_NAMES)[number])) {
        return `Bucket name '${name}' is reserved`;
    }
    const regex = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
    if (!regex.test(name)) {
        return "Bucket name must contain only lowercase letters, numbers, and hyphens, and start/end with a letter or number";
    }
    if (name.includes("--")) {
        return "Bucket name must not contain consecutive hyphens";
    }
    const ipRegex = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
    if (ipRegex.test(name)) {
        return "Bucket name must not be formatted as an IP address";
    }
    return null;
}

async function invalidateBucketCache(env: Env, name?: string, rootFolderId?: string): Promise<void> {
    await env.FOLDER_CACHE.delete(BUCKET_REGISTRY_CACHE_KEY);
    if (name) {
        await env.FOLDER_CACHE.delete(`bucket-stats:${name}`);
        if (rootFolderId) {
            await env.FOLDER_CACHE.delete(`${rootFolderId}/${name}`);
        }
    }
}

/** Lists all buckets from KV cache or fetches from Google Drive */
export async function getBucketRegistry(env: Env): Promise<BucketRecord[]> {
    const cached = await env.FOLDER_CACHE.get(BUCKET_REGISTRY_CACHE_KEY);
    if (cached) {
        try {
            return JSON.parse(cached) as BucketRecord[];
        } catch {
            // cache corrupt, fallback to fetching
        }
    }

    const accessToken = await getAccessToken(env);
    const rootFolderId = await getRootFolderId(accessToken, env);
    const files = await listFolderChildren(accessToken, rootFolderId, "files(id,name,mimeType,createdTime,appProperties)");

    const records: BucketRecord[] = files
        .filter((file) => file.mimeType === "application/vnd.google-apps.folder" && !RESERVED_BUCKET_NAMES.includes(file.name.toLowerCase() as (typeof RESERVED_BUCKET_NAMES)[number]))
        .map((folder) => ({
            name: folder.name,
            folderId: folder.id,
            publicRead: folder.appProperties?.s3PublicRead === "true",
            createdTime: folder.createdTime ?? null,
        }));

    await env.FOLDER_CACHE.put(BUCKET_REGISTRY_CACHE_KEY, JSON.stringify(records), {
        expirationTtl: BUCKET_REGISTRY_TTL,
    });

    return records;
}

/** Looks up a single bucket record by name */
export async function findBucketRecord(env: Env, bucket: string): Promise<BucketRecord | null> {
    if (!bucket) return null;
    const registry = await getBucketRegistry(env);
    return registry.find((b) => b.name === bucket) ?? null;
}

/** Creates a new bucket folder under root folder */
export async function createBucket(env: Env, name: string, publicRead: boolean): Promise<BucketRecord> {
    const validationError = validateBucketName(name);
    if (validationError) {
        const error = new Error(validationError);
        (error as { status?: number }).status = 400;
        throw error;
    }

    const existing = await findBucketRecord(env, name);
    if (existing) {
        const error = new Error(`Bucket '${name}' already exists`);
        (error as { status?: number }).status = 409;
        throw error;
    }

    const accessToken = await getAccessToken(env);
    const rootFolderId = await getRootFolderId(accessToken, env);

    const folderId = await getOrCreateFolder(accessToken, name, rootFolderId, env);

    if (publicRead) {
        await updateDriveFile(accessToken, folderId, {
            appProperties: { s3PublicRead: "true" },
        });
    }

    await invalidateBucketCache(env, name, rootFolderId);

    return {
        name,
        folderId,
        publicRead,
        createdTime: new Date().toISOString(),
    };
}

/** Updates an existing bucket (publicRead toggle or rename) */
export async function updateBucket(env: Env, name: string, patch: { publicRead?: boolean; name?: string }): Promise<BucketRecord> {
    const record = await findBucketRecord(env, name);
    if (!record) {
        const error = new Error(`Bucket '${name}' not found`);
        (error as { status?: number }).status = 404;
        throw error;
    }

    const accessToken = await getAccessToken(env);
    const rootFolderId = await getRootFolderId(accessToken, env);

    const updateBody: Record<string, unknown> = {};
    let newPublicRead = record.publicRead;
    let newName = record.name;

    if (patch.publicRead !== undefined) {
        newPublicRead = patch.publicRead;
        updateBody.appProperties = {
            s3PublicRead: newPublicRead ? "true" : "false",
        };
    }

    if (patch.name !== undefined && patch.name !== name) {
        const validationError = validateBucketName(patch.name);
        if (validationError) {
            const error = new Error(validationError);
            (error as { status?: number }).status = 400;
            throw error;
        }

        const conflict = await findBucketRecord(env, patch.name);
        if (conflict) {
            const error = new Error(`Bucket '${patch.name}' already exists`);
            (error as { status?: number }).status = 409;
            throw error;
        }

        newName = patch.name;
        updateBody.name = newName;
    }

    await updateDriveFile(accessToken, record.folderId, updateBody);

    await invalidateBucketCache(env, name, rootFolderId);
    if (newName !== name) {
        await invalidateBucketCache(env, newName, rootFolderId);
    }

    return {
        name: newName,
        folderId: record.folderId,
        publicRead: newPublicRead,
        createdTime: record.createdTime,
    };
}

/** Deletes a bucket if empty (moves folder to Drive trash) */
export async function deleteBucket(env: Env, name: string): Promise<void> {
    const record = await findBucketRecord(env, name);
    if (!record) {
        const error = new Error(`Bucket '${name}' not found`);
        (error as { status?: number }).status = 404;
        throw error;
    }

    const accessToken = await getAccessToken(env);
    const rootFolderId = await getRootFolderId(accessToken, env);

    const hasChildren = await folderHasChildren(accessToken, record.folderId);
    if (hasChildren) {
        const error = new Error(`Bucket '${name}' is not empty`);
        (error as { status?: number }).status = 409;
        throw error;
    }

    // Invalidate cache BEFORE moving to trash to prevent race reading stale state
    await invalidateBucketCache(env, name, rootFolderId);

    await updateDriveFile(accessToken, record.folderId, {
        trashed: true,
    });
}

export interface ImportCandidate {
    name: string;
    folderId: string;
    objectCount: number;
}

/** Lists folders in Drive root eligible for import into storage root folder */
export async function listImportCandidates(env: Env): Promise<ImportCandidate[]> {
    const accessToken = await getAccessToken(env);
    const rootFolderId = await getRootFolderId(accessToken, env);

    const rootChildren = await listFolderChildren(accessToken, "root", "files(id,name,mimeType)");
    const existingRegistry = await getBucketRegistry(env);
    const existingNames = new Set(existingRegistry.map((b) => b.name));

    const folders = rootChildren.filter((f) => f.mimeType === "application/vnd.google-apps.folder" && f.id !== rootFolderId && !existingNames.has(f.name) && !RESERVED_BUCKET_NAMES.includes(f.name.toLowerCase() as (typeof RESERVED_BUCKET_NAMES)[number]));

    const candidates: ImportCandidate[] = [];
    for (const folder of folders) {
        let objectCount = 0;
        try {
            const children = await listFolderChildren(accessToken, folder.id, "files(id,mimeType)");
            objectCount = children.filter((c) => c.mimeType !== "application/vnd.google-apps.folder").length;
        } catch {
            objectCount = 0;
        }
        candidates.push({
            name: folder.name,
            folderId: folder.id,
            objectCount,
        });
    }

    return candidates;
}

/** Moves selected folders from Drive root into storage root folder */
export async function importBuckets(env: Env, names: string[]): Promise<{ imported: string[]; failed: { name: string; error: string }[] }> {
    const accessToken = await getAccessToken(env);
    const rootFolderId = await getRootFolderId(accessToken, env);
    const rootChildren = await listFolderChildren(accessToken, "root", "files(id,name,mimeType)");

    const imported: string[] = [];
    const failed: { name: string; error: string }[] = [];

    for (const name of names) {
        const validationError = validateBucketName(name);
        if (validationError) {
            failed.push({ name, error: validationError });
            continue;
        }

        const match = rootChildren.find((f) => f.mimeType === "application/vnd.google-apps.folder" && f.name === name);
        if (!match) {
            failed.push({ name, error: `Folder '${name}' not found under My Drive root` });
            continue;
        }

        try {
            await updateDriveFile(
                accessToken,
                match.id,
                {},
                {
                    addParents: rootFolderId,
                    removeParents: "root",
                },
            );
            await invalidateBucketCache(env, name, rootFolderId);
            imported.push(name);
        } catch (err) {
            failed.push({ name, error: err instanceof Error ? err.message : String(err) });
        }
    }

    await env.FOLDER_CACHE.delete(BUCKET_REGISTRY_CACHE_KEY);

    return { imported, failed };
}
