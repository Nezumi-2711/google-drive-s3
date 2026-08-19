import { describe, expect, it, vi } from "vitest";

import { sha256 } from "../src/aws-signature";
import worker from "../src/index";
import type { BucketStatItem, BucketStatsResponse, GatewayStatusResponse } from "../src/status-api";
import type { Env } from "../src/types";

import { env } from "cloudflare:test";

const ENV = env as unknown as Env;
const ENDPOINT = "https://s3-api.example.com";
const CTX = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;

async function getValidToken(): Promise<string> {
    const correctHash = await sha256("test-dashboard-password");
    const loginRes = await worker.fetch(
        new Request(`${ENDPOINT}/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "CF-Connecting-IP": "127.0.0.1" },
            body: JSON.stringify({ passwordHash: correctHash }),
        }),
        ENV,
        CTX,
    );
    expect(loginRes.status).toBe(200);
    const data = (await loginRes.json()) as { token: string };
    return data.token;
}

describe("Dashboard status API routes (/api/*)", () => {
    it("returns 401 when Authorization header is missing or invalid", async () => {
        const res = await worker.fetch(new Request(`${ENDPOINT}/api/status`), ENV, CTX);
        expect(res.status).toBe(401);

        const invalidRes = await worker.fetch(
            new Request(`${ENDPOINT}/api/status`, {
                headers: { Authorization: "Bearer invalid-token" },
            }),
            ENV,
            CTX,
        );
        expect(invalidRes.status).toBe(401);
    });

    it("returns 503 when DASHBOARD_PASSWORD is not configured", async () => {
        const withoutPassword = { ...ENV, DASHBOARD_PASSWORD: undefined };
        const res = await worker.fetch(
            new Request(`${ENDPOINT}/api/status`, {
                headers: { Authorization: "Bearer any-token" },
            }),
            withoutPassword,
            CTX,
        );
        expect(res.status).toBe(503);
    });

    it("returns 405 for non-GET methods", async () => {
        const token = await getValidToken();
        const res = await worker.fetch(
            new Request(`${ENDPOINT}/api/status`, {
                method: "POST",
                headers: { Authorization: `Bearer ${token}` },
            }),
            ENV,
            CTX,
        );
        expect(res.status).toBe(405);
    });

    it("returns 200 with valid token and healthy drive response on /api/status", async () => {
        const token = await getValidToken();

        const fakeFetch = vi.fn(async (input: RequestInfo | URL) => {
            const url = new URL(typeof input === "string" ? input : input instanceof Request ? input.url : input.toString());

            if (url.origin === "https://oauth2.googleapis.com") {
                return Response.json({ access_token: "mock-access-token", expires_in: 3600 });
            }

            if (url.pathname === "/drive/v3/about") {
                return Response.json({
                    user: {
                        emailAddress: "test@example.com",
                        displayName: "Test User",
                    },
                    storageQuota: {
                        limit: "15000000000",
                        usage: "5000000000",
                        usageInDrive: "4500000000",
                        usageInDriveTrash: "500000000",
                    },
                });
            }

            return new Response("Not found", { status: 404 });
        });

        vi.stubGlobal("fetch", fakeFetch);

        try {
            const res = await worker.fetch(
                new Request(`${ENDPOINT}/api/status`, {
                    headers: { Authorization: `Bearer ${token}` },
                }),
                ENV,
                CTX,
            );

            expect(res.status).toBe(200);
            const data = (await res.json()) as GatewayStatusResponse;

            expect(data.gateway.status).toBe("ok");
            expect(data.gateway.region).toBe("auto");
            expect(data.gateway.multipartEnabled).toBe(true);
            expect(data.gateway.buckets).toEqual(["test-bucket", "empty-bucket", "my-bucket"]);
            expect(data.gateway.credentials).toEqual({
                s3Keys: true,
                googleOAuth: true,
                dashboardPassword: true,
            });

            expect(data.drive.connected).toBe(true);
            expect(data.drive.account?.email).toBe("test@example.com");
            expect(data.drive.quota?.limit).toBe(15000000000);
            expect(data.drive.quota?.usage).toBe(5000000000);
            expect(data.drive.quota?.free).toBe(10000000000);
            expect(data.drive.quota?.percentUsed).toBe(33.3);
            expect(data.drive.error).toBeNull();
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("does not leak secrets in /api/status response", async () => {
        const token = await getValidToken();

        const fakeFetch = vi.fn(async (input: RequestInfo | URL) => {
            const url = new URL(typeof input === "string" ? input : input instanceof Request ? input.url : input.toString());
            if (url.origin === "https://oauth2.googleapis.com") {
                return Response.json({ access_token: "mock-access-token", expires_in: 3600 });
            }
            if (url.pathname === "/drive/v3/about") {
                return Response.json({
                    user: { emailAddress: "test@example.com", displayName: "Test User" },
                    storageQuota: { limit: "1000", usage: "500" },
                });
            }
            return new Response("Not found", { status: 404 });
        });

        vi.stubGlobal("fetch", fakeFetch);

        try {
            const res = await worker.fetch(
                new Request(`${ENDPOINT}/api/status`, {
                    headers: { Authorization: `Bearer ${token}` },
                }),
                ENV,
                CTX,
            );

            const text = await res.text();
            expect(text).not.toContain("test-secret-key");
            expect(text).not.toContain("test-refresh-token");
            expect(text).not.toContain("test-dashboard-password");
            expect(text).not.toContain("test-client-secret");
            expect(text).not.toContain("test-access-key");
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("handles Drive errors gracefully with degraded status on /api/status", async () => {
        await (ENV.AUTH_KV as KVNamespace).delete("drive-about");
        const token = await getValidToken();

        const fakeFetch = vi.fn(async (input: RequestInfo | URL) => {
            const url = new URL(typeof input === "string" ? input : input instanceof Request ? input.url : input.toString());
            if (url.origin === "https://oauth2.googleapis.com") {
                return Response.json({ access_token: "mock-access-token", expires_in: 3600 });
            }
            if (url.pathname === "/drive/v3/about") {
                return new Response("Internal Server Error", { status: 500 });
            }
            return new Response("Not found", { status: 404 });
        });

        vi.stubGlobal("fetch", fakeFetch);

        try {
            const res = await worker.fetch(
                new Request(`${ENDPOINT}/api/status`, {
                    headers: { Authorization: `Bearer ${token}` },
                }),
                ENV,
                CTX,
            );

            expect(res.status).toBe(200);
            const data = (await res.json()) as GatewayStatusResponse;
            expect(data.gateway.status).toBe("degraded");
            expect(data.drive.connected).toBe(false);
            expect(data.drive.account).toBeNull();
            expect(data.drive.quota).toBeNull();
            expect(data.drive.error).toContain("Drive about request failed");
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("returns bucket statistics on /api/buckets", async () => {
        await (ENV.AUTH_KV as KVNamespace).delete("drive-about");
        const token = await getValidToken();

        const fakeFetch = vi.fn(async (input: RequestInfo | URL) => {
            const url = new URL(typeof input === "string" ? input : input instanceof Request ? input.url : input.toString());
            if (url.origin === "https://oauth2.googleapis.com") {
                return Response.json({ access_token: "mock-access-token", expires_in: 3600 });
            }
            if (url.pathname === "/drive/v3/files") {
                const q = url.searchParams.get("q") ?? "";
                if (q.includes("name='test-bucket'")) {
                    return Response.json({ files: [{ id: "folder-test-bucket", name: "test-bucket" }] });
                }
                if (q.includes("'folder-test-bucket' in parents")) {
                    return Response.json({
                        files: [
                            {
                                id: "file-1",
                                name: "hello.txt",
                                mimeType: "text/plain",
                                size: "1024",
                                modifiedTime: "2026-08-19T00:00:00.000Z",
                            },
                        ],
                    });
                }
                return Response.json({ files: [] });
            }
            return new Response("Not found", { status: 404 });
        });

        vi.stubGlobal("fetch", fakeFetch);

        try {
            const res = await worker.fetch(
                new Request(`${ENDPOINT}/api/buckets?refresh=1`, {
                    headers: { Authorization: `Bearer ${token}` },
                }),
                ENV,
                CTX,
            );

            expect(res.status).toBe(200);
            const data = (await res.json()) as BucketStatsResponse;
            expect(data.buckets).toHaveLength(3);
            const testBucket = data.buckets.find((b: BucketStatItem) => b.name === "test-bucket");
            expect(testBucket).toBeTruthy();
            expect(testBucket?.objectCount).toBe(1);
            expect(testBucket?.totalSize).toBe(1024);
            expect(testBucket?.lastModified).toBe("2026-08-19T00:00:00.000Z");
            expect(data.totals.objectCount).toBe(1);
            expect(data.totals.totalSize).toBe(1024);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("routes /api to S3 handler when 'api' is configured as an allowed bucket", async () => {
        const customEnv = { ...ENV, ALLOWED_BUCKETS: "api,test-bucket" };
        const res = await worker.fetch(new Request(`${ENDPOINT}/api/status`), customEnv, CTX);
        // S3 router checks signature or returns SignatureDoesNotMatch / AccessDenied etc.
        expect(res.status).toBe(403);
        const text = await res.text();
        expect(text).toContain("<Error><Code>");
    });
});
