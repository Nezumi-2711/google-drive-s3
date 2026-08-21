import { AwsClient } from "aws4fetch";
import { afterEach, describe, expect, it, vi } from "vitest";

import { preflightResponse, withCors } from "../src/cors";
import worker from "../src/index";
import type { Env } from "../src/types";

import { env } from "cloudflare:test";

const ENV = env as unknown as Env;
const ENDPOINT = "https://s3-api.example.com";
const ORIGIN = "http://localhost:5173";
const CTX = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;

async function signed(path: string, init: RequestInit): Promise<Request> {
    const aws = new AwsClient({ accessKeyId: ENV.ACCESS_KEY, secretAccessKey: ENV.SECRET_KEY, region: ENV.REGION, service: "s3" });
    const bodyLength = typeof init.body === "string" ? new TextEncoder().encode(init.body).byteLength : init.body instanceof Uint8Array ? init.body.byteLength : undefined;
    return aws.sign(`${ENDPOINT}${path}`, {
        ...init,
        headers: { "x-amz-content-sha256": "UNSIGNED-PAYLOAD", ...(bodyLength === undefined ? {} : { "x-amz-decoded-content-length": String(bodyLength) }), ...init.headers },
    });
}

function fakeGoogleFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname === "oauth2.googleapis.com") return Promise.resolve(Response.json({ access_token: "token", expires_in: 3600 }));
    if (url.pathname === "/drive/v3/files" && request.method === "GET") {
        const q = url.searchParams.get("q") ?? "";
        if (q.includes("name='s3-storage'") && q.includes("'root' in parents")) {
            return Promise.resolve(Response.json({ files: [{ id: "root-folder-id", name: "s3-storage" }] }));
        }
        if (q.includes("'root-folder-id' in parents")) {
            return Promise.resolve(Response.json({ files: [{ id: "folder-test-bucket", name: "test-bucket", mimeType: "application/vnd.google-apps.folder" }] }));
        }
        if (q.includes("name='test-bucket'")) {
            return Promise.resolve(Response.json({ files: [{ id: "folder-test-bucket", name: "test-bucket", mimeType: "application/vnd.google-apps.folder" }] }));
        }
        return Promise.resolve(Response.json({ files: [] }));
    }
    if (url.pathname === "/drive/v3/files" && request.method === "POST") return Promise.resolve(Response.json({ id: "folder-1" }));
    if (url.pathname.startsWith("/upload/drive/v3/files")) return Promise.resolve(new Response(null, { headers: { Location: "https://www.googleapis.com/upload/session/test" } }));
    if (url.pathname === "/upload/session/test") return Promise.resolve(Response.json({ id: "file-1", name: "file.txt", md5Checksum: "d41d8cd98f00b204e9800998ecf8427e" }));
    return Promise.resolve(new Response("Not Found", { status: 404 }));
}

afterEach(() => vi.unstubAllGlobals());

describe("CORS", () => {
    it("returns allow-list preflight headers", async () => {
        const response = preflightResponse(
            new Request(`${ENDPOINT}/test-bucket/file.txt`, {
                method: "OPTIONS",
                headers: { Origin: ORIGIN, "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": "content-type,x-amz-date" },
            }),
            ENV,
        );

        expect(response.status).toBe(204);
        expect(response.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
        expect(response.headers.get("Access-Control-Allow-Methods")).toBe("GET, HEAD, PUT, POST, PATCH, DELETE, OPTIONS");
        expect(response.headers.get("Access-Control-Allow-Headers")).toBe("content-type,x-amz-date");
        expect(response.headers.get("Access-Control-Max-Age")).toBe("86400");
        expect(response.headers.get("Vary")).toBe("Origin");
    });

    it("returns a bare 204 for a disallowed origin", async () => {
        const response = preflightResponse(new Request(`${ENDPOINT}/test-bucket/file.txt`, { method: "OPTIONS", headers: { Origin: "https://not-allowed.example", "Access-Control-Request-Method": "PUT" } }), ENV);

        expect(response.status).toBe(204);
        expect([...response.headers]).toEqual([]);
    });

    it("keeps OPTIONS requests without an Origin byte-compatible with the prior bare 204", () => {
        const response = preflightResponse(new Request(`${ENDPOINT}/test-bucket/file.txt`, { method: "OPTIONS" }), ENV);

        expect(response.status).toBe(204);
        expect([...response.headers]).toEqual([]);
    });

    it("exposes ETag for successful PUT responses", async () => {
        vi.stubGlobal("fetch", vi.fn(fakeGoogleFetch));
        const request = await signed("/test-bucket/file.txt", { method: "PUT", body: "hello", headers: { Origin: ORIGIN, "Content-Type": "text/plain" } });
        const response = await worker.fetch(request, ENV, CTX);

        expect(response.status).toBe(200);
        expect(response.headers.get("ETag")).toBe('"d41d8cd98f00b204e9800998ecf8427e"');
        expect(response.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
        expect(response.headers.get("Access-Control-Expose-Headers")).toContain("ETag");
    });

    it("adds CORS headers to access-denied and missing-key errors", async () => {
        const denied = await worker.fetch(new Request(`${ENDPOINT}/not-a-bucket`, { headers: { Origin: ORIGIN } }), ENV, CTX);
        expect(denied.status).toBe(403);
        expect(denied.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);

        vi.stubGlobal("fetch", vi.fn(fakeGoogleFetch));
        const missing = await worker.fetch(await signed("/test-bucket/missing.txt", { method: "GET", headers: { Origin: ORIGIN } }), ENV, CTX);
        expect(missing.status).toBe(404);
        expect(await missing.text()).toContain("<Code>NoSuchKey</Code>");
        expect(missing.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    });

    it("does not alter the S3 response for a disallowed Origin", async () => {
        const response = await worker.fetch(new Request(`${ENDPOINT}/not-a-bucket`, { headers: { Origin: "https://not-allowed.example" } }), ENV, CTX);

        expect(response.status).toBe(403);
        expect(await response.text()).toContain("<Code>AccessDenied</Code>");
        expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
        expect(response.headers.get("Access-Control-Expose-Headers")).toBeNull();
        expect(response.headers.get("Vary")).toBe("Origin");
    });

    it("does not attach Access-Control headers to server-to-server responses without Origin", () => {
        const response = withCors(new Response("S3 response", { status: 200, headers: { ETag: '"etag"' } }), new Request(`${ENDPOINT}/test-bucket/file.txt`), ENV);

        expect(response.status).toBe(200);
        expect(response.headers.get("ETag")).toBe('"etag"');
        expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
        expect(response.headers.get("Access-Control-Expose-Headers")).toBeNull();
        expect(response.headers.get("Vary")).toBe("Origin");
    });

    it("emits no CORS headers when CORS_ALLOWED_ORIGINS is unset", () => {
        const request = new Request(`${ENDPOINT}/test-bucket/file.txt`, { headers: { Origin: ORIGIN } });
        const response = withCors(new Response(null, { headers: { ETag: '"etag"' } }), request, { ...ENV, CORS_ALLOWED_ORIGINS: undefined });
        expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
        expect(response.headers.get("Access-Control-Expose-Headers")).toBeNull();
        expect(response.headers.get("Vary")).toBeNull();
    });
});
