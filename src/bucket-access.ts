import type { Env } from "./types";

/**
 * Checks whether the bucket is present in the ALLOWED_BUCKETS allowlist.
 * Access is denied by default when the allowlist is missing or empty.
 */
export function isAllowedBucket(bucket: string, env: Env): boolean {
    if (!env.ALLOWED_BUCKETS) {
        return false;
    }

    const allowedBuckets = env.ALLOWED_BUCKETS.split(",")
        .map((b) => b.trim())
        .filter((b) => b);

    if (allowedBuckets.length === 0) {
        return false;
    }

    return allowedBuckets.includes(bucket);
}

/** Checks whether the bucket allows unauthenticated read access. */
export function isPublicReadBucket(bucket: string, env: Env): boolean {
    if (!env.PUBLIC_READ_BUCKETS) {
        return false;
    }

    const publicReadBuckets = env.PUBLIC_READ_BUCKETS.split(",")
        .map((b) => b.trim())
        .filter((b) => b);

    return publicReadBuckets.includes(bucket);
}
