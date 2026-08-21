import { jsonResponse, verifySessionToken } from "./auth-api";
import { handleBucketRoutes, handleImportCandidatesRoute, handleImportRoute } from "./bucket-api";
import { getBucketRegistry } from "./bucket-registry";
import { getAccessToken, getDriveAbout, getRootFolderId, listObjects } from "./google-drive";
import { handleObjectRoutes, handleTicketDownload } from "./object-api";
import type { DriveAbout, Env } from "./types";

export const API_PATH_PREFIX = "api";
const DRIVE_ABOUT_CACHE_KEY = "drive-about";
const DRIVE_ABOUT_CACHE_TTL = 60; // 60s
const BUCKET_STATS_CACHE_TTL = 300; // 300s

export interface GatewayStatusResponse {
    gateway: {
        status: "ok" | "degraded";
        region: string;
        multipartEnabled: boolean;
        etagStyle: "md5" | "multipart";
        docsEnabled: boolean;
        buckets: string[];
        publicReadBuckets: string[];
        rootFolder: {
            name: string | null;
            id: string | null;
            configured: boolean;
        };
        corsOrigins: string[];
        credentials: {
            s3Keys: boolean;
            googleOAuth: boolean;
            dashboardPassword: boolean;
        };
    };
    drive: {
        connected: boolean;
        account: {
            email: string | null;
            displayName: string | null;
        } | null;
        quota: {
            limit: number | null;
            usage: number;
            usageInDrive: number;
            usageInDriveTrash: number;
            free: number | null;
            percentUsed: number | null;
        } | null;
        error: string | null;
    };
    checkedAt: string;
}

export interface BucketStatItem {
    name: string;
    objectCount: number;
    totalSize: number;
    lastModified: string | null;
    truncated: boolean;
    publicRead: boolean;
    error: string | null;
}

export interface BucketStatsResponse {
    buckets: BucketStatItem[];
    totals: {
        buckets: number;
        objectCount: number;
        totalSize: number;
    };
    cachedAt: string;
}

export async function handleApi(request: Request, env: Env, subPath: string): Promise<Response> {
    try {
        if (!env.DASHBOARD_PASSWORD) {
            return jsonResponse({ message: "Dashboard authentication is not configured" }, 503);
        }

        if (!env.DRIVE_ROOT_FOLDER || env.DRIVE_ROOT_FOLDER.trim() === "") {
            return jsonResponse({ message: "Storage root folder is not configured" }, 503);
        }

        const segments = subPath.split("/").filter(Boolean);
        const firstSegment = segments[0] || "";
        const remainingSegments = segments.slice(1);
        const url = new URL(request.url);

        // Ticket download does not require session token (uses 120s random token)
        if (firstSegment === "objects" && remainingSegments[0] === "content" && url.searchParams.has("ticket")) {
            return await handleTicketDownload(request, env);
        }

        const isValid = await verifySessionToken(request, env);
        if (!isValid) {
            return jsonResponse({ message: "Session expired or invalid" }, 401);
        }

        if (firstSegment === "status") {
            if (request.method !== "GET") return jsonResponse({ message: "Method Not Allowed" }, 405);
            return await handleStatus(env);
        }

        if (firstSegment === "buckets") {
            if (request.method === "GET" && remainingSegments.length === 0) {
                const forceRefresh = url.searchParams.get("refresh") === "1";
                return await handleBuckets(env, forceRefresh);
            }
            return await handleBucketRoutes(request, env, remainingSegments);
        }

        if (firstSegment === "objects") {
            return await handleObjectRoutes(request, env, remainingSegments);
        }

        if (firstSegment === "import-candidates") {
            return await handleImportCandidatesRoute(request, env);
        }

        if (firstSegment === "import") {
            return await handleImportRoute(request, env);
        }

        return jsonResponse({ message: "Not Found" }, 404);
    } catch (error) {
        console.error(
            JSON.stringify({
                message: "api handler error",
                error: error instanceof Error ? error.message : String(error),
                method: request.method,
                subPath,
            }),
        );
        return jsonResponse({ message: "Internal server error" }, 500);
    }
}

async function handleStatus(env: Env): Promise<Response> {
    let buckets: string[] = [];
    let pubBuckets: string[] = [];
    let rootFolderId: string | null = null;

    try {
        const registry = await getBucketRegistry(env);
        buckets = registry.map((b) => b.name);
        pubBuckets = registry.filter((b) => b.publicRead).map((b) => b.name);
    } catch (err) {
        console.error("Failed to load bucket registry for status", err);
    }

    const corsOrigins = env.CORS_ALLOWED_ORIGINS
        ? env.CORS_ALLOWED_ORIGINS.split(",")
              .map((o) => o.trim())
              .filter(Boolean)
        : [];

    let driveAbout: DriveAbout | null = null;
    let driveError: string | null = null;

    try {
        const accessToken = await getAccessToken(env);
        if (env.DRIVE_ROOT_FOLDER) {
            try {
                rootFolderId = await getRootFolderId(accessToken, env);
            } catch (err) {
                console.error("Failed to get root folder id", err);
            }
        }

        const cached = await env.AUTH_KV.get(DRIVE_ABOUT_CACHE_KEY);
        if (cached) {
            driveAbout = JSON.parse(cached) as DriveAbout;
        } else {
            driveAbout = await getDriveAbout(accessToken);
            await env.AUTH_KV.put(DRIVE_ABOUT_CACHE_KEY, JSON.stringify(driveAbout), {
                expirationTtl: DRIVE_ABOUT_CACHE_TTL,
            });
        }
    } catch (err) {
        driveError = err instanceof Error ? err.message : String(err);
    }

    const driveConnected = driveAbout !== null && driveError === null;

    const payload: GatewayStatusResponse = {
        gateway: {
            status: driveConnected ? "ok" : "degraded",
            region: env.REGION || "auto",
            multipartEnabled: env.ALLOW_MULTIPART === "true",
            etagStyle: env.ETAG_STYLE === "multipart" ? "multipart" : "md5",
            docsEnabled: env.ENABLE_DOCS !== "false",
            buckets,
            publicReadBuckets: pubBuckets,
            rootFolder: {
                name: env.DRIVE_ROOT_FOLDER || null,
                id: rootFolderId,
                configured: Boolean(env.DRIVE_ROOT_FOLDER && env.DRIVE_ROOT_FOLDER.trim() !== ""),
            },
            corsOrigins,
            credentials: {
                s3Keys: Boolean(env.ACCESS_KEY && env.SECRET_KEY),
                googleOAuth: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN),
                dashboardPassword: Boolean(env.DASHBOARD_PASSWORD),
            },
        },
        drive: {
            connected: driveConnected,
            account: driveAbout
                ? {
                      email: driveAbout.user.emailAddress,
                      displayName: driveAbout.user.displayName,
                  }
                : null,
            quota: driveAbout ? driveAbout.storageQuota : null,
            error: driveError,
        },
        checkedAt: new Date().toISOString(),
    };

    return jsonResponse(payload, 200);
}

async function handleBuckets(env: Env, forceRefresh: boolean): Promise<Response> {
    let records: { name: string; publicRead: boolean }[] = [];
    try {
        records = await getBucketRegistry(env);
    } catch (err) {
        console.error("Failed to acquire bucket registry", err);
    }

    let accessToken: string | null = null;
    try {
        accessToken = await getAccessToken(env);
    } catch (err) {
        console.error("Failed to acquire access token for bucket stats", err);
    }

    const bucketStats: BucketStatItem[] = [];

    for (const record of records) {
        const bucket = record.name;
        const cacheKey = `bucket-stats:${bucket}`;
        if (!forceRefresh) {
            const cached = await env.FOLDER_CACHE.get(cacheKey);
            if (cached) {
                try {
                    bucketStats.push(JSON.parse(cached) as BucketStatItem);
                    continue;
                } catch {
                    // if corrupted cache, proceed to fetch
                }
            }
        }

        if (!accessToken) {
            bucketStats.push({
                name: bucket,
                objectCount: 0,
                totalSize: 0,
                lastModified: null,
                truncated: false,
                publicRead: record.publicRead,
                error: "Google Drive access unavailable",
            });
            continue;
        }

        try {
            const { contents, truncated } = await listObjects(accessToken, bucket, "", env);
            let totalSize = 0;
            let latestModified: number | null = null;

            for (const item of contents) {
                const sz = parseInt(item.size, 10);
                if (!Number.isNaN(sz)) totalSize += sz;
                if (item.modifiedTime) {
                    const t = new Date(item.modifiedTime).getTime();
                    if (!Number.isNaN(t) && (latestModified === null || t > latestModified)) {
                        latestModified = t;
                    }
                }
            }

            const stat: BucketStatItem = {
                name: bucket,
                objectCount: contents.length,
                totalSize,
                lastModified: latestModified ? new Date(latestModified).toISOString() : null,
                truncated,
                publicRead: record.publicRead,
                error: null,
            };

            await env.FOLDER_CACHE.put(cacheKey, JSON.stringify(stat), {
                expirationTtl: BUCKET_STATS_CACHE_TTL,
            });

            bucketStats.push(stat);
        } catch (err) {
            bucketStats.push({
                name: bucket,
                objectCount: 0,
                totalSize: 0,
                lastModified: null,
                truncated: false,
                publicRead: record.publicRead,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    let totalCount = 0;
    let totalSize = 0;
    for (const b of bucketStats) {
        if (!b.error) {
            totalCount += b.objectCount;
            totalSize += b.totalSize;
        }
    }

    const response: BucketStatsResponse = {
        buckets: bucketStats,
        totals: {
            buckets: bucketStats.length,
            objectCount: totalCount,
            totalSize: totalSize,
        },
        cachedAt: new Date().toISOString(),
    };

    return jsonResponse(response, 200);
}
