import { beforeEach, describe, expect, it, vi } from "vitest";

import { sha256 } from "../src/aws-signature";
import worker from "../src/index";
import type { Env } from "../src/types";

import { env } from "cloudflare:test";

const ENV = env as unknown as Env;
const ENDPOINT = "https://s3-api.example.com";
const CTX = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;

let testIpCounter = 1;
function getUniqueIp(): string {
    return `10.0.0.${testIpCounter++}`;
}

async function getValidToken(ip = getUniqueIp()): Promise<string> {
    const passwordHash = await sha256("test-dashboard-password");
    const loginRes = await worker.fetch(
        new Request(`${ENDPOINT}/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
            body: JSON.stringify({ passwordHash }),
        }),
        ENV,
        CTX,
    );
    const data = (await loginRes.json()) as { token: string };
    return data.token;
}

beforeEach(async () => {
    await (ENV.AUTH_KV as KVNamespace).delete("drive-about");
    await (ENV.FOLDER_CACHE as KVNamespace).delete("bucket-registry");
    for (const { name } of (await (ENV.FOLDER_CACHE as KVNamespace).list()).keys) {
        await (ENV.FOLDER_CACHE as KVNamespace).delete(name);
    }
});

describe("Bucket management CRUD API routes (/api/buckets, /api/import*)", () => {
    it("returns 503 on /api/buckets when DRIVE_ROOT_FOLDER is unset", async () => {
        const token = await getValidToken();
        const customEnv = { ...ENV, DRIVE_ROOT_FOLDER: undefined };
        const res = await worker.fetch(
            new Request(`${ENDPOINT}/api/buckets`, {
                headers: { Authorization: `Bearer ${token}` },
            }),
            customEnv,
            CTX,
        );
        expect(res.status).toBe(503);
        const data = (await res.json()) as { message: string };
        expect(data.message).toBe("Storage root folder is not configured");
    });

    it("rejects reserved bucket names on POST /api/buckets with 400", async () => {
        const token = await getValidToken();
        for (const reserved of ["auth", "api", "docs"]) {
            const res = await worker.fetch(
                new Request(`${ENDPOINT}/api/buckets`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                    body: JSON.stringify({ name: reserved }),
                }),
                ENV,
                CTX,
            );
            expect(res.status).toBe(400);
            const data = (await res.json()) as { message: string };
            expect(data.message).toContain("reserved");
        }
    });

    it("rejects invalid bucket names on POST /api/buckets with 400", async () => {
        const token = await getValidToken();
        const invalidNames = ["ab", "Abc", "bucket--name", "-bucket", "bucket-", "192.168.1.1"];
        for (const name of invalidNames) {
            const res = await worker.fetch(
                new Request(`${ENDPOINT}/api/buckets`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                    body: JSON.stringify({ name }),
                }),
                ENV,
                CTX,
            );
            expect(res.status).toBe(400);
        }
    });

    it("creates a bucket with POST /api/buckets and handles conflict with 409", async () => {
        const token = await getValidToken();

        const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = new URL(typeof input === "string" ? input : input instanceof Request ? input.url : input.toString());
            const method = init?.method ?? (input instanceof Request ? input.method : "GET");

            if (url.origin === "https://oauth2.googleapis.com") {
                return Response.json({ access_token: "mock-access-token", expires_in: 3600 });
            }

            if (url.pathname === "/drive/v3/files") {
                const q = url.searchParams.get("q") ?? "";
                if (method === "GET") {
                    if (q.includes("name='s3-storage'") && q.includes("'root' in parents")) {
                        return Response.json({ files: [{ id: "root-folder-id", name: "s3-storage" }] });
                    }
                    if (q.includes("'root-folder-id' in parents") && q.includes("mimeType='application/vnd.google-apps.folder'")) {
                        return Response.json({ files: [] });
                    }
                    if (q.includes("name='new-bucket'")) {
                        return Response.json({ files: [] });
                    }
                    return Response.json({ files: [] });
                }
                if (method === "POST") {
                    return Response.json({ id: "new-bucket-folder-id" });
                }
            }
            if (url.pathname === "/drive/v3/files/new-bucket-folder-id" && method === "PATCH") {
                return Response.json({ id: "new-bucket-folder-id", name: "new-bucket" });
            }
            return new Response("Not found", { status: 404 });
        });

        vi.stubGlobal("fetch", fakeFetch);

        try {
            const res = await worker.fetch(
                new Request(`${ENDPOINT}/api/buckets`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                    body: JSON.stringify({ name: "new-bucket", publicRead: true }),
                }),
                ENV,
                CTX,
            );
            expect(res.status).toBe(201);
            const data = (await res.json()) as { name: string; folderId: string; publicRead: boolean };
            expect(data.name).toBe("new-bucket");
            expect(data.folderId).toBe("new-bucket-folder-id");
            expect(data.publicRead).toBe(true);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("updates bucket publicRead with PATCH /api/buckets/:name", async () => {
        const token = await getValidToken();

        const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = new URL(typeof input === "string" ? input : input instanceof Request ? input.url : input.toString());
            const method = init?.method ?? (input instanceof Request ? input.method : "GET");

            if (url.origin === "https://oauth2.googleapis.com") {
                return Response.json({ access_token: "mock-access-token", expires_in: 3600 });
            }
            if (url.pathname === "/drive/v3/files") {
                const q = url.searchParams.get("q") ?? "";
                if (q.includes("name='s3-storage'") && q.includes("'root' in parents")) {
                    return Response.json({ files: [{ id: "root-folder-id", name: "s3-storage" }] });
                }
                if (q.includes("'root-folder-id' in parents")) {
                    return Response.json({
                        files: [{ id: "folder-target-bucket", name: "target-bucket", mimeType: "application/vnd.google-apps.folder", appProperties: { s3PublicRead: "false" } }],
                    });
                }
            }
            if (url.pathname === "/drive/v3/files/folder-target-bucket" && method === "PATCH") {
                return Response.json({ id: "folder-target-bucket", name: "target-bucket", appProperties: { s3PublicRead: "true" } });
            }
            return new Response("Not found", { status: 404 });
        });

        vi.stubGlobal("fetch", fakeFetch);

        try {
            const res = await worker.fetch(
                new Request(`${ENDPOINT}/api/buckets/target-bucket`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                    body: JSON.stringify({ publicRead: true }),
                }),
                ENV,
                CTX,
            );
            expect(res.status).toBe(200);
            const data = (await res.json()) as { name: string; publicRead: boolean };
            expect(data.name).toBe("target-bucket");
            expect(data.publicRead).toBe(true);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("rejects DELETE /api/buckets/:name when bucket has children with 409", async () => {
        const token = await getValidToken();

        const fakeFetch = vi.fn(async (input: RequestInfo | URL) => {
            const url = new URL(typeof input === "string" ? input : input instanceof Request ? input.url : input.toString());

            if (url.origin === "https://oauth2.googleapis.com") {
                return Response.json({ access_token: "mock-access-token", expires_in: 3600 });
            }
            if (url.pathname === "/drive/v3/files") {
                const q = url.searchParams.get("q") ?? "";
                if (q.includes("name='s3-storage'") && q.includes("'root' in parents")) {
                    return Response.json({ files: [{ id: "root-folder-id", name: "s3-storage" }] });
                }
                if (q.includes("'root-folder-id' in parents")) {
                    return Response.json({
                        files: [{ id: "folder-non-empty", name: "non-empty", mimeType: "application/vnd.google-apps.folder" }],
                    });
                }
                if (q.includes("'folder-non-empty' in parents")) {
                    return Response.json({ files: [{ id: "child-file-1" }] });
                }
            }
            return new Response("Not found", { status: 404 });
        });

        vi.stubGlobal("fetch", fakeFetch);

        try {
            const res = await worker.fetch(
                new Request(`${ENDPOINT}/api/buckets/non-empty`, {
                    method: "DELETE",
                    headers: { Authorization: `Bearer ${token}` },
                }),
                ENV,
                CTX,
            );
            expect(res.status).toBe(409);
            const data = (await res.json()) as { message: string };
            expect(data.message).toContain("not empty");
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("deletes empty bucket with DELETE /api/buckets/:name and returns 204", async () => {
        const token = await getValidToken();

        const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = new URL(typeof input === "string" ? input : input instanceof Request ? input.url : input.toString());
            const method = init?.method ?? (input instanceof Request ? input.method : "GET");

            if (url.origin === "https://oauth2.googleapis.com") {
                return Response.json({ access_token: "mock-access-token", expires_in: 3600 });
            }
            if (url.pathname === "/drive/v3/files") {
                const q = url.searchParams.get("q") ?? "";
                if (q.includes("name='s3-storage'") && q.includes("'root' in parents")) {
                    return Response.json({ files: [{ id: "root-folder-id", name: "s3-storage" }] });
                }
                if (q.includes("'root-folder-id' in parents")) {
                    return Response.json({
                        files: [{ id: "folder-empty", name: "empty", mimeType: "application/vnd.google-apps.folder" }],
                    });
                }
                if (q.includes("'folder-empty' in parents")) {
                    return Response.json({ files: [] });
                }
            }
            if (url.pathname === "/drive/v3/files/folder-empty" && method === "PATCH") {
                return Response.json({ id: "folder-empty", trashed: true });
            }
            return new Response("Not found", { status: 404 });
        });

        vi.stubGlobal("fetch", fakeFetch);

        try {
            const res = await worker.fetch(
                new Request(`${ENDPOINT}/api/buckets/empty`, {
                    method: "DELETE",
                    headers: { Authorization: `Bearer ${token}` },
                }),
                ENV,
                CTX,
            );
            expect(res.status).toBe(204);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("lists import candidates and imports selected buckets", async () => {
        const token = await getValidToken();

        const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = new URL(typeof input === "string" ? input : input instanceof Request ? input.url : input.toString());
            const method = init?.method ?? (input instanceof Request ? input.method : "GET");

            if (url.origin === "https://oauth2.googleapis.com") {
                return Response.json({ access_token: "mock-access-token", expires_in: 3600 });
            }
            if (url.pathname === "/drive/v3/files") {
                const q = url.searchParams.get("q") ?? "";
                if (q.includes("name='s3-storage'") && q.includes("'root' in parents")) {
                    return Response.json({ files: [{ id: "root-folder-id", name: "s3-storage" }] });
                }
                if (q.includes("'root-folder-id' in parents")) {
                    return Response.json({ files: [] });
                }
                if (q.includes("'root' in parents")) {
                    return Response.json({
                        files: [
                            { id: "root-folder-id", name: "s3-storage", mimeType: "application/vnd.google-apps.folder" },
                            { id: "import-folder-1", name: "legacy-bucket", mimeType: "application/vnd.google-apps.folder" },
                        ],
                    });
                }
                if (q.includes("'import-folder-1' in parents")) {
                    return Response.json({
                        files: [
                            { id: "f1", mimeType: "text/plain" },
                            { id: "f2", mimeType: "text/plain" },
                        ],
                    });
                }
            }
            if (url.pathname === "/drive/v3/files/import-folder-1" && method === "PATCH") {
                return Response.json({ id: "import-folder-1", name: "legacy-bucket" });
            }
            return new Response("Not found", { status: 404 });
        });

        vi.stubGlobal("fetch", fakeFetch);

        try {
            // GET /api/import-candidates
            const listRes = await worker.fetch(
                new Request(`${ENDPOINT}/api/import-candidates`, {
                    headers: { Authorization: `Bearer ${token}` },
                }),
                ENV,
                CTX,
            );
            expect(listRes.status).toBe(200);
            const listData = (await listRes.json()) as { candidates: Array<{ name: string; folderId: string; objectCount: number }> };
            expect(listData.candidates).toHaveLength(1);
            expect(listData.candidates[0].name).toBe("legacy-bucket");
            expect(listData.candidates[0].objectCount).toBe(2);

            // POST /api/import
            const importRes = await worker.fetch(
                new Request(`${ENDPOINT}/api/import`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                    body: JSON.stringify({ names: ["legacy-bucket"] }),
                }),
                ENV,
                CTX,
            );
            expect(importRes.status).toBe(200);
            const importData = (await importRes.json()) as { imported: string[]; failed: unknown[] };
            expect(importData.imported).toEqual(["legacy-bucket"]);
            expect(importData.failed).toHaveLength(0);
        } finally {
            vi.unstubAllGlobals();
        }
    });
});
