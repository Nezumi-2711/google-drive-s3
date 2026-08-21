import { jsonResponse } from "./auth-api";
import { getBucketRegistry } from "./bucket-registry";
import { ALLOWED_GRACE_SECONDS, CredentialsError, createAccessKey, type GraceSeconds, listAccessKeys, loadCredentials, revealAccessKey, revokeAccessKey, rotateAccessKey } from "./credentials";
import type { Env } from "./types";

const REVEAL_FAIL_PREFIX = "reveal-fail:";
const REVEAL_MAX_ATTEMPTS = 20;
const REVEAL_WINDOW_SECONDS = 60;

interface CreateKeyBody {
    label?: unknown;
}

interface RotateKeyBody {
    graceSeconds?: unknown;
}

export interface IntegrationAccessKeyMetadata {
    accessKeyId: string;
    label: string;
    createdAt: string;
    expiresAt: string | null;
}

export interface IntegrationInfoResponse {
    endpoint: string;
    region: string;
    forcePathStyle: true;
    buckets: string[];
    publicReadBuckets: string[];
    multipartEnabled: boolean;
    etagStyle: "md5" | "multipart";
    corsOrigins: string[];
    docsUrl: string | null;
    openApiUrl: string | null;
    accessKeys: IntegrationAccessKeyMetadata[];
    limits: {
        maxAccessKeys: number;
        keyPropagationSeconds: number;
        presignExpiryMaxSeconds: number;
    };
}

async function checkRevealRateLimit(request: Request, env: Env): Promise<Response | null> {
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const failKey = `${REVEAL_FAIL_PREFIX}${ip}`;
    const attemptsStr = await env.AUTH_KV.get(failKey);
    const attempts = attemptsStr ? parseInt(attemptsStr, 10) : 0;

    if (attempts >= REVEAL_MAX_ATTEMPTS) {
        return jsonResponse({ message: "Too many secret reveals. Please try again later." }, 429, { "Retry-After": REVEAL_WINDOW_SECONDS.toString() });
    }

    await env.AUTH_KV.put(failKey, (attempts + 1).toString(), { expirationTtl: REVEAL_WINDOW_SECONDS });
    return null;
}

function credentialsErrorResponse(err: unknown): Response {
    if (err instanceof CredentialsError) {
        return jsonResponse({ message: err.message }, err.status);
    }
    const status = (err as { status?: number }).status || 500;
    const message = err instanceof Error ? err.message : String(err);
    return jsonResponse({ message }, status);
}

function parseGraceSeconds(body: RotateKeyBody): GraceSeconds | null {
    const value = body.graceSeconds;
    if (typeof value !== "number" || !Number.isInteger(value) || !ALLOWED_GRACE_SECONDS.includes(value as GraceSeconds)) {
        return null;
    }
    return value as GraceSeconds;
}

/** Handles every `/api/integration*` route. Session verification already happened in status-api. */
export async function handleIntegrationRoutes(request: Request, env: Env, subSegments: string[]): Promise<Response> {
    const method = request.method;

    // GET /api/integration
    if (method === "GET" && subSegments.length === 0) {
        try {
            let buckets: string[] = [];
            let publicReadBuckets: string[] = [];
            try {
                const registry = await getBucketRegistry(env);
                buckets = registry.map((b) => b.name);
                publicReadBuckets = registry.filter((b) => b.publicRead).map((b) => b.name);
            } catch (err) {
                console.error("Failed to load bucket registry for integration info", err);
            }

            const corsOrigins = env.CORS_ALLOWED_ORIGINS
                ? env.CORS_ALLOWED_ORIGINS.split(",")
                      .map((o) => o.trim())
                      .filter(Boolean)
                : [];

            const docsEnabled = env.ENABLE_DOCS !== "false";
            const origin = new URL(request.url).origin;

            const payload: IntegrationInfoResponse = {
                endpoint: origin,
                region: env.REGION || "auto",
                forcePathStyle: true,
                buckets,
                publicReadBuckets,
                multipartEnabled: env.ALLOW_MULTIPART === "true",
                etagStyle: env.ETAG_STYLE === "multipart" ? "multipart" : "md5",
                corsOrigins,
                docsUrl: docsEnabled ? `${origin}/docs` : null,
                openApiUrl: docsEnabled ? `${origin}/openapi.yaml` : null,
                accessKeys: await listAccessKeys(env),
                limits: {
                    maxAccessKeys: 5,
                    keyPropagationSeconds: 60,
                    presignExpiryMaxSeconds: 7 * 24 * 60 * 60,
                },
            };
            return jsonResponse(payload, 200);
        } catch (err) {
            return credentialsErrorResponse(err);
        }
    }

    // POST /api/integration/keys
    if (method === "POST" && subSegments[0] === "keys" && subSegments.length === 1) {
        let body: CreateKeyBody;
        try {
            body = (await request.json()) as CreateKeyBody;
        } catch {
            return jsonResponse({ message: "Invalid JSON body" }, 400);
        }

        try {
            const key = await createAccessKey(env, typeof body.label === "string" ? body.label : "");
            return jsonResponse(key, 201);
        } catch (err) {
            return credentialsErrorResponse(err);
        }
    }

    // POST /api/integration/keys/:id/rotate
    if (method === "POST" && subSegments[0] === "keys" && subSegments[2] === "rotate" && subSegments.length === 3) {
        let body: RotateKeyBody;
        try {
            body = (await request.json()) as RotateKeyBody;
        } catch {
            return jsonResponse({ message: "Invalid JSON body" }, 400);
        }

        const graceSeconds = parseGraceSeconds(body);
        if (graceSeconds === null) {
            return jsonResponse({ message: `graceSeconds must be one of ${ALLOWED_GRACE_SECONDS.join(", ")}` }, 400);
        }

        try {
            const result = await rotateAccessKey(env, decodeURIComponent(subSegments[1]), graceSeconds);
            return jsonResponse(result, 200);
        } catch (err) {
            return credentialsErrorResponse(err);
        }
    }

    // GET /api/integration/keys/:id/secret
    if (method === "GET" && subSegments[0] === "keys" && subSegments[2] === "secret" && subSegments.length === 3) {
        try {
            const limited = await checkRevealRateLimit(request, env);
            if (limited) return limited;

            const key = await revealAccessKey(env, decodeURIComponent(subSegments[1]));
            if (!key) return jsonResponse({ message: "Access key not found" }, 404);
            return jsonResponse({ secretAccessKey: key.secretAccessKey }, 200);
        } catch (err) {
            return credentialsErrorResponse(err);
        }
    }

    // DELETE /api/integration/keys/:id
    if (method === "DELETE" && subSegments[0] === "keys" && subSegments.length === 2) {
        try {
            await revokeAccessKey(env, decodeURIComponent(subSegments[1]));
            return new Response(null, { status: 204 });
        } catch (err) {
            return credentialsErrorResponse(err);
        }
    }

    return jsonResponse({ message: "Method Not Allowed" }, 405);
}

/** Live-key count for the dashboard status card — computed from the store rather than env. */
export async function hasLiveS3Keys(env: Env): Promise<boolean> {
    try {
        return (await loadCredentials(env)).length > 0;
    } catch {
        return false;
    }
}
