import { constantTimeEqual, sha256 } from "./aws-signature";
import type { Env } from "./types";

export const AUTH_PATH_PREFIX = "auth";
const SESSION_PREFIX = "session:";
const LOGIN_FAIL_PREFIX = "login-fail:";
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_SECONDS = 900;

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            "Content-Type": "application/json",
            ...headers,
        },
    });
}

export async function verifySessionToken(request: Request, env: Env): Promise<boolean> {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return false;
    const token = authHeader.slice("Bearer ".length).trim();
    if (!token) return false;
    return (await env.AUTH_KV.get(`${SESSION_PREFIX}${await sha256(token)}`)) !== null;
}

function generateToken(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

export async function handleAuth(request: Request, env: Env, subPath: string): Promise<Response> {
    try {
        if (!env.DASHBOARD_PASSWORD) {
            return jsonResponse({ message: "Dashboard authentication is not configured" }, 503);
        }

        if (subPath === "login") {
            if (request.method !== "POST") {
                return jsonResponse({ message: "Method Not Allowed" }, 405);
            }

            let body: { passwordHash?: unknown };
            try {
                body = await request.json();
            } catch {
                return jsonResponse({ message: "Invalid JSON body" }, 400);
            }

            if (!body || typeof body.passwordHash !== "string" || !body.passwordHash) {
                return jsonResponse({ message: "Missing or invalid passwordHash" }, 400);
            }

            const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
            const failKey = `${LOGIN_FAIL_PREFIX}${ip}`;
            const failedAttemptsStr = await env.AUTH_KV.get(failKey);
            const failedAttempts = failedAttemptsStr ? parseInt(failedAttemptsStr, 10) : 0;

            if (failedAttempts >= MAX_FAILED_ATTEMPTS) {
                return jsonResponse({ message: "Too many failed attempts. Please try again later." }, 429, { "Retry-After": LOCKOUT_SECONDS.toString() });
            }

            const expectedHash = await sha256(env.DASHBOARD_PASSWORD);
            const providedHash = body.passwordHash.trim().toLowerCase();

            if (!constantTimeEqual(expectedHash, providedHash)) {
                const nextAttempts = failedAttempts + 1;
                await env.AUTH_KV.put(failKey, nextAttempts.toString(), { expirationTtl: LOCKOUT_SECONDS });
                return jsonResponse({ message: "Invalid password" }, 401);
            }

            // Login successful
            await env.AUTH_KV.delete(failKey);
            const token = generateToken();
            const tokenHash = await sha256(token);
            const sessionData = {
                createdAt: new Date().toISOString(),
                ip,
            };
            await env.AUTH_KV.put(`${SESSION_PREFIX}${tokenHash}`, JSON.stringify(sessionData), {
                expirationTtl: SESSION_TTL_SECONDS,
            });

            return jsonResponse({ token, expiresIn: SESSION_TTL_SECONDS }, 200);
        }

        if (subPath === "session") {
            if (request.method !== "GET") {
                return jsonResponse({ message: "Method Not Allowed" }, 405);
            }

            const isValid = await verifySessionToken(request, env);
            if (!isValid) {
                return jsonResponse({ message: "Session expired or invalid" }, 401);
            }

            return jsonResponse({ valid: true }, 200);
        }

        if (subPath === "logout") {
            if (request.method !== "POST") {
                return jsonResponse({ message: "Method Not Allowed" }, 405);
            }

            const authHeader = request.headers.get("Authorization");
            if (authHeader?.startsWith("Bearer ")) {
                const token = authHeader.slice("Bearer ".length).trim();
                if (token) {
                    const tokenHash = await sha256(token);
                    await env.AUTH_KV.delete(`${SESSION_PREFIX}${tokenHash}`);
                }
            }

            return new Response(null, { status: 204 });
        }

        return jsonResponse({ message: "Not Found" }, 404);
    } catch (error) {
        console.error(
            JSON.stringify({
                message: "auth handler error",
                error: error instanceof Error ? error.message : String(error),
                method: request.method,
                subPath,
            }),
        );
        return jsonResponse({ message: "Internal server error" }, 500);
    }
}
