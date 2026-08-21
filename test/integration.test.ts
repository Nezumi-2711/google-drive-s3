import { AwsClient } from "aws4fetch";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { sha256 } from "../src/aws-signature";
import { CREDENTIALS_KV_KEY } from "../src/credentials";
import worker from "../src/index";
import type { IntegrationInfoResponse } from "../src/integration-api";
import type { Env, S3AccessKey } from "../src/types";
import { FakeDrive } from "./fake-drive";

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

function authed(path: string, method: string, token: string, body?: unknown): Request {
    return new Request(`${ENDPOINT}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
}

/** Signs an S3 request with an arbitrary key pair. */
async function signedWith(accessKeyId: string, secretAccessKey: string, path: string, init: RequestInit): Promise<Request> {
    const aws = new AwsClient({ accessKeyId, secretAccessKey, region: ENV.REGION, service: "s3" });
    return aws.sign(`${ENDPOINT}${path}`, {
        ...init,
        headers: { "x-amz-content-sha256": "UNSIGNED-PAYLOAD", ...init.headers },
    });
}

async function signed(path: string, init: RequestInit): Promise<Request> {
    return signedWith(ENV.ACCESS_KEY, ENV.SECRET_KEY, path, init);
}

let token: string;
let drive: FakeDrive;

beforeEach(async () => {
    await ENV.AUTH_KV.delete(CREDENTIALS_KV_KEY);
    for (const { name } of (await ENV.AUTH_KV.list({ prefix: "reveal-fail:" })).keys) await ENV.AUTH_KV.delete(name);
    token = await getValidToken();

    drive = new FakeDrive();
    const rootFolderId = "folder-root";
    drive.folders.set(rootFolderId, { id: rootFolderId, name: "s3-storage", parent: "root" });
    const testBucketId = "folder-test-bucket";
    drive.folders.set(testBucketId, { id: testBucketId, name: "test-bucket", parent: rootFolderId });

    vi.stubGlobal(
        "fetch",
        vi.fn((input, init) => drive.handle(input, init)),
    );
    await ENV.AUTH_KV.delete("google_access_token");
});

describe("Integration API routes (/api/integration*)", () => {
    it("returns 401 without a session token", async () => {
        const res = await worker.fetch(new Request(`${ENDPOINT}/api/integration`), ENV, CTX);
        expect(res.status).toBe(401);

        const invalidRes = await worker.fetch(new Request(`${ENDPOINT}/api/integration`, { headers: { Authorization: "Bearer nope" } }), ENV, CTX);
        expect(invalidRes.status).toBe(401);
    });

    it("seeds the store from bootstrap env secrets on first use and keeps them working", async () => {
        // A signed request with the legacy env pair must pass before anything exists in KV.
        const res = await worker.fetch(await signed("/test-bucket/bootstrap.txt", { method: "PUT", body: "hi" }), ENV, CTX);
        expect(res.status).toBe(200);

        // The store is now seeded with the bootstrap key.
        const stored = await ENV.AUTH_KV.get(CREDENTIALS_KV_KEY);
        expect(stored).not.toBeNull();
        const keys = (JSON.parse(stored as string) as { keys: S3AccessKey[] }).keys;
        expect(keys).toHaveLength(1);
        expect(keys[0].accessKeyId).toBe(ENV.ACCESS_KEY);
        expect(keys[0].secretAccessKey).toBe(ENV.SECRET_KEY);
        expect(keys[0].label).toBe("bootstrap");
    });

    it("returns integration info with metadata-only access keys", async () => {
        const createRes = await worker.fetch(authed("/api/integration/keys", "POST", token, { label: "info-test" }), ENV, CTX);
        expect(createRes.status).toBe(201);

        const res = await worker.fetch(authed("/api/integration", "GET", token), ENV, CTX);
        expect(res.status).toBe(200);
        const data = (await res.json()) as IntegrationInfoResponse;
        expect(data.endpoint).toBe(ENDPOINT);
        expect(data.region).toBe("auto");
        expect(data.forcePathStyle).toBe(true);
        expect(Array.isArray(data.buckets)).toBe(true);
        expect(data.multipartEnabled).toBe(true);
        expect(data.docsUrl).toBe(`${ENDPOINT}/docs`);
        expect(data.openApiUrl).toBe(`${ENDPOINT}/openapi.yaml`);
        expect(data.limits.maxAccessKeys).toBe(5);
        expect(data.limits.keyPropagationSeconds).toBe(60);
        // Creating a key seeds the bootstrap key from env secrets, so both are listed.
        expect(data.accessKeys).toHaveLength(2);
        expect(data.accessKeys.map((k) => k.label)).toContain("info-test");
        expect(data.accessKeys.find((k) => k.label === "info-test")?.accessKeyId.startsWith("GDS")).toBe(true);
        for (const accessKey of data.accessKeys) {
            expect((accessKey as unknown as Record<string, unknown>).secretAccessKey).toBeUndefined();
        }
    });

    it("creates a key that authenticates against the gateway", async () => {
        const createRes = await worker.fetch(authed("/api/integration/keys", "POST", token, { label: "cli-key" }), ENV, CTX);
        expect(createRes.status).toBe(201);
        const key = (await createRes.json()) as S3AccessKey;
        expect(key.accessKeyId.startsWith("GDS")).toBe(true);
        expect(key.secretAccessKey).toHaveLength(40);

        const res = await worker.fetch(await signedWith(key.accessKeyId, key.secretAccessKey, "/test-bucket/new-key.txt", { method: "PUT", body: "from new key" }), ENV, CTX);
        expect(res.status).toBe(200);
    });

    it("rejects invalid labels and enforces MAX_ACCESS_KEYS", async () => {
        const badLabel = await worker.fetch(authed("/api/integration/keys", "POST", token, { label: "bad label!" }), ENV, CTX);
        expect(badLabel.status).toBe(400);

        const emptyLabel = await worker.fetch(authed("/api/integration/keys", "POST", token, { label: "" }), ENV, CTX);
        expect(emptyLabel.status).toBe(400);

        // Bootstrap seeding happens on first load; fill the rest of the slots.
        const probe = await worker.fetch(await signed("/test-bucket/probe.txt", { method: "PUT", body: "x" }), ENV, CTX);
        expect(probe.status).toBe(200);

        for (let i = 0; i < 4; i++) {
            const res = await worker.fetch(authed("/api/integration/keys", "POST", token, { label: `key-${i}` }), ENV, CTX);
            expect(res.status).toBe(201);
        }

        const overflow = await worker.fetch(authed("/api/integration/keys", "POST", token, { label: "one-too-many" }), ENV, CTX);
        expect(overflow.status).toBe(400);
    });

    it("rotates with a grace period so both keys work, then expires the old one", async () => {
        const probe = await worker.fetch(await signed("/test-bucket/grace-probe.txt", { method: "PUT", body: "x" }), ENV, CTX);
        expect(probe.status).toBe(200);

        const createRes = await worker.fetch(authed("/api/integration/keys", "POST", token, { label: "rotating" }), ENV, CTX);
        const original = (await createRes.json()) as S3AccessKey;

        const rotateRes = await worker.fetch(authed(`/api/integration/keys/${original.accessKeyId}/rotate`, "POST", token, { graceSeconds: 3600 }), ENV, CTX);
        expect(rotateRes.status).toBe(200);
        const rotation = (await rotateRes.json()) as { created: S3AccessKey; previous: { accessKeyId: string; expiresAt: string | null } };
        expect(rotation.created.label).toBe("rotating");
        expect(rotation.previous.expiresAt).not.toBeNull();

        // Both pairs work during the grace window.
        const oldRes = await worker.fetch(await signedWith(original.accessKeyId, original.secretAccessKey, "/test-bucket/during-grace.txt", { method: "PUT", body: "old" }), ENV, CTX);
        expect(oldRes.status).toBe(200);
        const newRes = await worker.fetch(await signedWith(rotation.created.accessKeyId, rotation.created.secretAccessKey, "/test-bucket/during-grace.txt", { method: "PUT", body: "new" }), ENV, CTX);
        expect(newRes.status).toBe(200);

        // Force-expire the old key; it must stop authenticating.
        const stored = JSON.parse((await ENV.AUTH_KV.get(CREDENTIALS_KV_KEY)) as string) as { keys: S3AccessKey[] };
        stored.keys = stored.keys.map((k) => (k.accessKeyId === original.accessKeyId ? { ...k, expiresAt: new Date(Date.now() - 1000).toISOString() } : k));
        await ENV.AUTH_KV.put(CREDENTIALS_KV_KEY, JSON.stringify(stored));

        const expiredRes = await worker.fetch(await signedWith(original.accessKeyId, original.secretAccessKey, "/test-bucket/after-grace.txt", { method: "PUT", body: "late" }), ENV, CTX);
        expect(expiredRes.status).toBe(403);
        const stillNewRes = await worker.fetch(await signedWith(rotation.created.accessKeyId, rotation.created.secretAccessKey, "/test-bucket/after-grace.txt", { method: "PUT", body: "fine" }), ENV, CTX);
        expect(stillNewRes.status).toBe(200);
    });

    it("rotates with graceSeconds 0 so the old key is rejected immediately", async () => {
        const probe = await worker.fetch(await signed("/test-bucket/revoke-now-probe.txt", { method: "PUT", body: "x" }), ENV, CTX);
        expect(probe.status).toBe(200);

        const createRes = await worker.fetch(authed("/api/integration/keys", "POST", token, { label: "instant-rotate" }), ENV, CTX);
        const original = (await createRes.json()) as S3AccessKey;

        const rotateRes = await worker.fetch(authed(`/api/integration/keys/${original.accessKeyId}/rotate`, "POST", token, { graceSeconds: 0 }), ENV, CTX);
        expect(rotateRes.status).toBe(200);
        const rotation = (await rotateRes.json()) as { created: S3AccessKey; previous: { accessKeyId: string; expiresAt: string | null } };
        expect(rotation.previous.expiresAt).toBeNull();

        const oldRes = await worker.fetch(await signedWith(original.accessKeyId, original.secretAccessKey, "/test-bucket/gone.txt", { method: "PUT", body: "nope" }), ENV, CTX);
        expect(oldRes.status).toBe(403);
        const newRes = await worker.fetch(await signedWith(rotation.created.accessKeyId, rotation.created.secretAccessKey, "/test-bucket/here.txt", { method: "PUT", body: "yes" }), ENV, CTX);
        expect(newRes.status).toBe(200);
    });

    it("rejects invalid graceSeconds values", async () => {
        const probe = await worker.fetch(await signed("/test-bucket/bad-grace-probe.txt", { method: "PUT", body: "x" }), ENV, CTX);
        expect(probe.status).toBe(200);

        const createRes = await worker.fetch(authed("/api/integration/keys", "POST", token, { label: "grace-check" }), ENV, CTX);
        const key = (await createRes.json()) as S3AccessKey;

        const res = await worker.fetch(authed(`/api/integration/keys/${key.accessKeyId}/rotate`, "POST", token, { graceSeconds: 1234 }), ENV, CTX);
        expect(res.status).toBe(400);
    });

    it("revokes a key so its S3 requests are rejected and it disappears from the list", async () => {
        const probe = await worker.fetch(await signed("/test-bucket/revoke-probe.txt", { method: "PUT", body: "x" }), ENV, CTX);
        expect(probe.status).toBe(200);

        const createRes = await worker.fetch(authed("/api/integration/keys", "POST", token, { label: "short-lived" }), ENV, CTX);
        const key = (await createRes.json()) as S3AccessKey;

        const deleteRes = await worker.fetch(authed(`/api/integration/keys/${key.accessKeyId}`, "DELETE", token), ENV, CTX);
        expect(deleteRes.status).toBe(204);

        const revokedRes = await worker.fetch(await signedWith(key.accessKeyId, key.secretAccessKey, "/test-bucket/revoked.txt", { method: "PUT", body: "nope" }), ENV, CTX);
        expect(revokedRes.status).toBe(403);

        const listRes = await worker.fetch(authed("/api/integration", "GET", token), ENV, CTX);
        const data = (await listRes.json()) as IntegrationInfoResponse;
        expect(data.accessKeys.find((k) => k.accessKeyId === key.accessKeyId)).toBeUndefined();
    });

    it("reveals a secret through the dedicated route", async () => {
        const probe = await worker.fetch(await signed("/test-bucket/reveal-probe.txt", { method: "PUT", body: "x" }), ENV, CTX);
        expect(probe.status).toBe(200);

        const createRes = await worker.fetch(authed("/api/integration/keys", "POST", token, { label: "reveal-me" }), ENV, CTX);
        const key = (await createRes.json()) as S3AccessKey;

        const revealRes = await worker.fetch(authed(`/api/integration/keys/${key.accessKeyId}/secret`, "GET", token), ENV, CTX);
        expect(revealRes.status).toBe(200);
        const data = (await revealRes.json()) as { secretAccessKey: string };
        expect(data.secretAccessKey).toBe(key.secretAccessKey);

        const missingRes = await worker.fetch(authed("/api/integration/keys/GDSUNKNOWNKEY000000/secret", "GET", token), ENV, CTX);
        expect(missingRes.status).toBe(404);
    });

    it("returns 405 for unsupported method/path combinations", async () => {
        const res = await worker.fetch(authed("/api/integration/keys/some-id", "PATCH", token), ENV, CTX);
        expect(res.status).toBe(405);
    });
});
