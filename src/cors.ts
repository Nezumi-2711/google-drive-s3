import type { Env } from "./types";

const ALLOWED_METHODS = "GET, HEAD, PUT, POST, DELETE, OPTIONS";
const DEFAULT_ALLOWED_HEADERS = "Authorization, Content-Type, Content-Length, Content-MD5, Content-Encoding, Range, x-amz-content-sha256, x-amz-copy-source, x-amz-date, x-amz-decoded-content-length, x-amz-mp-object-size, x-amz-security-token";
const EXPOSED_HEADERS = "ETag, Content-Range, Content-Length, Last-Modified, Accept-Ranges, x-amz-request-id";

function configuredOrigins(env: Env): string[] {
    return (env.CORS_ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean);
}

function hasWildcardOrigin(env: Env): boolean {
    return env.CORS_ALLOWED_ORIGINS?.trim() === "*";
}

function appendVary(headers: Headers, value: string): void {
    const existing = headers.get("Vary");
    if (!existing) {
        headers.set("Vary", value);
        return;
    }

    if (!existing.split(",").some((part) => part.trim().toLowerCase() === value.toLowerCase())) {
        headers.set("Vary", `${existing}, ${value}`);
    }
}

/** Returns the permitted value for Access-Control-Allow-Origin, or null when CORS is disabled or denied. */
export function resolveOrigin(request: Request, env: Env): string | null {
    const origin = request.headers.get("Origin");
    if (!origin) return null;
    if (hasWildcardOrigin(env)) return "*";
    return configuredOrigins(env).includes(origin) ? origin : null;
}

/** Builds an unauthenticated browser preflight response. */
export function preflightResponse(request: Request, env: Env): Response {
    const headers = new Headers();
    const origin = resolveOrigin(request, env);

    if (origin) {
        headers.set("Access-Control-Allow-Origin", origin);
        headers.set("Access-Control-Allow-Methods", ALLOWED_METHODS);
        headers.set("Access-Control-Allow-Headers", request.headers.get("Access-Control-Request-Headers") ?? DEFAULT_ALLOWED_HEADERS);
        headers.set("Access-Control-Max-Age", "86400");
        if (!hasWildcardOrigin(env)) appendVary(headers, "Origin");
    }

    return new Response(null, { status: 204, headers });
}

/** Adds CORS response headers without mutating the response supplied by the request handler. */
export function withCors(response: Response, request: Request, env: Env): Response {
    const headers = new Headers(response.headers);

    if (env.CORS_ALLOWED_ORIGINS?.trim() && !hasWildcardOrigin(env)) {
        appendVary(headers, "Origin");
    }

    const origin = resolveOrigin(request, env);
    if (origin) {
        headers.set("Access-Control-Allow-Origin", origin);
        headers.set("Access-Control-Expose-Headers", EXPOSED_HEADERS);
    }

    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
