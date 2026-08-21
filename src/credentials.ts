import type { Env } from "./types";

export interface S3AccessKey {
    accessKeyId: string; // "GDS" + 17 chars of [A-Z2-7] (no "/" — the credential scope is split on it)
    secretAccessKey: string; // base64url of 30 random bytes = 40 chars
    label: string; // 1-32 chars, [a-zA-Z0-9 _-]
    createdAt: string; // ISO
    expiresAt: string | null; // ISO when retiring after a rotation, else null
}

interface CredentialStore {
    version: 1;
    keys: S3AccessKey[];
}

export const CREDENTIALS_KV_KEY = "s3-credentials";
export const MAX_ACCESS_KEYS = 5;
// KV cacheTtl minimum is 60s. Signature verification reads this store on every S3 request,
// so it must be edge-cached — consequence: revoke/rotate take up to 60s to propagate globally.
export const CREDENTIALS_CACHE_TTL = 60;

const ACCESS_KEY_ID_PREFIX = "GDS";
const ACCESS_KEY_ID_RANDOM_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // RFC 4648 base32 alphabet, no "/"
const LABEL_PATTERN = /^[a-zA-Z0-9 _-]{1,32}$/;
/** Grace periods accepted by rotateAccessKey: revoke now, 1h, 24h, 7d. */
export const ALLOWED_GRACE_SECONDS = [0, 3600, 86400, 604800] as const;
export type GraceSeconds = (typeof ALLOWED_GRACE_SECONDS)[number];

export class CredentialsError extends Error {
    readonly status: number;

    constructor(message: string, status = 400) {
        super(message);
        this.name = "CredentialsError";
        this.status = status;
    }
}

function generateAccessKeyId(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(17));
    let id = ACCESS_KEY_ID_PREFIX;
    for (const byte of bytes) {
        id += ACCESS_KEY_ID_RANDOM_CHARS[byte % ACCESS_KEY_ID_RANDOM_CHARS.length];
    }
    return id;
}

function generateSecretAccessKey(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(30));
    return btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

export function validateLabel(label: unknown): label is string {
    return typeof label === "string" && LABEL_PATTERN.test(label);
}

function pruneExpiredKeys(keys: S3AccessKey[]): S3AccessKey[] {
    const now = Date.now();
    return keys.filter((key) => key.expiresAt === null || new Date(key.expiresAt).getTime() > now);
}

async function persistCredentials(env: Env, keys: S3AccessKey[]): Promise<void> {
    const store: CredentialStore = { version: 1, keys };
    await env.AUTH_KV.put(CREDENTIALS_KV_KEY, JSON.stringify(store));
}

/**
 * Loads the credential store from KV with a 60s edge cache.
 *
 * On first use (no stored value) the store is seeded from the legacy `ACCESS_KEY`/`SECRET_KEY`
 * secrets so existing deployments keep working unchanged. On a KV read *throw* the error
 * propagates — fail closed so a revoked key can never silently come back to life via env fallback.
 */
export async function loadCredentials(env: Env): Promise<S3AccessKey[]> {
    let raw: string | null;
    try {
        raw = await env.AUTH_KV.get(CREDENTIALS_KV_KEY, { type: "text", cacheTtl: CREDENTIALS_CACHE_TTL });
    } catch (err) {
        console.error(
            JSON.stringify({
                message: "failed to load s3-credentials from KV",
                error: err instanceof Error ? err.message : String(err),
            }),
        );
        throw err;
    }

    if (raw !== null) {
        try {
            const store = JSON.parse(raw) as CredentialStore;
            if (!Array.isArray(store.keys)) throw new Error("malformed credential store");
            const live = pruneExpiredKeys(store.keys);
            if (live.length !== store.keys.length) {
                await persistCredentials(env, live);
            }
            return live;
        } catch (err) {
            console.error(
                JSON.stringify({
                    message: "corrupt s3-credentials store in KV",
                    error: err instanceof Error ? err.message : String(err),
                }),
            );
            throw new CredentialsError("Credential store is corrupt", 500);
        }
    }

    // Seed from legacy bootstrap secrets on first use.
    if (env.ACCESS_KEY && env.SECRET_KEY) {
        const seeded: S3AccessKey = {
            accessKeyId: env.ACCESS_KEY,
            secretAccessKey: env.SECRET_KEY,
            label: "bootstrap",
            createdAt: new Date().toISOString(),
            expiresAt: null,
        };
        await persistCredentials(env, [seeded]);
        return [seeded];
    }

    return [];
}

/** Resolves an access key by id, rejecting keys whose grace period has elapsed. */
export async function findAccessKey(env: Env, accessKeyId: string): Promise<S3AccessKey | null> {
    const keys = await loadCredentials(env);
    const key = keys.find((candidate) => candidate.accessKeyId === accessKeyId);
    if (!key) return null;
    if (key.expiresAt && new Date(key.expiresAt).getTime() <= Date.now()) return null;
    return key;
}

/** Lists access keys without their secrets. */
export async function listAccessKeys(env: Env): Promise<Omit<S3AccessKey, "secretAccessKey">[]> {
    const keys = await loadCredentials(env);
    return keys.map(({ secretAccessKey: _secret, ...meta }) => meta);
}

/** Returns the full key record including its secret. */
export async function revealAccessKey(env: Env, accessKeyId: string): Promise<S3AccessKey | null> {
    const keys = await loadCredentials(env);
    return keys.find((candidate) => candidate.accessKeyId === accessKeyId) ?? null;
}

export async function createAccessKey(env: Env, label: string): Promise<S3AccessKey> {
    if (!validateLabel(label)) {
        throw new CredentialsError("Label must be 1-32 characters using letters, numbers, spaces, '_' or '-'");
    }
    const keys = await loadCredentials(env);
    if (keys.length >= MAX_ACCESS_KEYS) {
        throw new CredentialsError(`Maximum of ${MAX_ACCESS_KEYS} access keys reached. Revoke or rotate an existing key first.`);
    }
    const key: S3AccessKey = {
        accessKeyId: generateAccessKeyId(),
        secretAccessKey: generateSecretAccessKey(),
        label,
        createdAt: new Date().toISOString(),
        expiresAt: null,
    };
    await persistCredentials(env, [...keys, key]);
    return key;
}

/**
 * Creates a replacement key carrying the same label and retires the old one:
 * `graceSeconds === 0` deletes it immediately, otherwise it keeps authenticating until
 * `expiresAt` elapses. Allowed grace values are 0 / 1h / 24h / 7d.
 */
export async function rotateAccessKey(env: Env, accessKeyId: string, graceSeconds: GraceSeconds): Promise<{ created: S3AccessKey; previous: { accessKeyId: string; expiresAt: string | null } }> {
    if (!ALLOWED_GRACE_SECONDS.includes(graceSeconds)) {
        throw new CredentialsError(`graceSeconds must be one of ${ALLOWED_GRACE_SECONDS.join(", ")}`);
    }
    const keys = await loadCredentials(env);
    const index = keys.findIndex((candidate) => candidate.accessKeyId === accessKeyId);
    if (index === -1) {
        throw new CredentialsError("Access key not found", 404);
    }

    const previous = keys[index];
    const created: S3AccessKey = {
        accessKeyId: generateAccessKeyId(),
        secretAccessKey: generateSecretAccessKey(),
        label: previous.label,
        createdAt: new Date().toISOString(),
        expiresAt: null,
    };

    const nextKeys = [...keys];
    if (graceSeconds === 0) {
        nextKeys.splice(index, 1);
    } else {
        nextKeys[index] = { ...previous, expiresAt: new Date(Date.now() + graceSeconds * 1000).toISOString() };
    }
    nextKeys.push(created);

    await persistCredentials(env, nextKeys);
    return {
        created,
        previous: { accessKeyId: previous.accessKeyId, expiresAt: nextKeys[index]?.expiresAt ?? null },
    };
}

export async function revokeAccessKey(env: Env, accessKeyId: string): Promise<void> {
    const keys = await loadCredentials(env);
    const index = keys.findIndex((candidate) => candidate.accessKeyId === accessKeyId);
    if (index === -1) {
        throw new CredentialsError("Access key not found", 404);
    }
    const nextKeys = keys.filter((_, i) => i !== index);
    await persistCredentials(env, nextKeys);
}
