import type { Env } from "./types";

/**
 * Returns the list of configured allowed buckets.
 */
export function allowedBuckets(env: Env): string[] {
    if (!env.ALLOWED_BUCKETS) {
        return [];
    }

    return env.ALLOWED_BUCKETS.split(",")
        .map((b) => b.trim())
        .filter((b) => b.length > 0);
}

/**
 * Returns the list of configured public read buckets.
 */
export function publicReadBuckets(env: Env): string[] {
    if (!env.PUBLIC_READ_BUCKETS) {
        return [];
    }

    return env.PUBLIC_READ_BUCKETS.split(",")
        .map((b) => b.trim())
        .filter((b) => b.length > 0);
}

/**
 * Checks whether the bucket is present in the ALLOWED_BUCKETS allowlist.
 * Access is denied by default when the allowlist is missing or empty.
 */
export function isAllowedBucket(bucket: string, env: Env): boolean {
    const buckets = allowedBuckets(env);
    if (buckets.length === 0) {
        return false;
    }

    return buckets.includes(bucket);
}

/** Checks whether the bucket allows unauthenticated read access. */
export function isPublicReadBucket(bucket: string, env: Env): boolean {
    const buckets = publicReadBuckets(env);
    return buckets.includes(bucket);
}
