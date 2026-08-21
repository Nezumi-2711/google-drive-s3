import { beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import type { Env } from "../src/types";
import { bytes, FakeDrive, fakeMd5 } from "./fake-drive";

import { env } from "cloudflare:test";

const ENV = env as unknown as Env;
const ENDPOINT = "https://s3-api.example.com";
const CTX = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;

let drive: FakeDrive;
let validToken: string;

beforeEach(async () => {
    drive = new FakeDrive();
    const rootFolderId = "folder-root";
    drive.folders.set(rootFolderId, { id: rootFolderId, name: "s3-storage", parent: "root" });
    const testBucketId = "folder-test-bucket";
    drive.folders.set(testBucketId, { id: testBucketId, name: "test-bucket", parent: rootFolderId });
    const emptyBucketId = "folder-empty-bucket";
    drive.folders.set(emptyBucketId, { id: emptyBucketId, name: "empty-bucket", parent: rootFolderId });

    vi.stubGlobal(
        "fetch",
        vi.fn((input, init) => drive.handle(input, init)),
    );
    await ENV.AUTH_KV.delete("google_access_token");
    for (const { name } of (await ENV.FOLDER_CACHE.list()).keys) await ENV.FOLDER_CACHE.delete(name);

    // Create session token
    const token = "test-session-token-12345";
    const data = new TextEncoder().encode(token);
    const hash = await crypto.subtle.digest("SHA-256", data);
    const hashHex = Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
    await ENV.AUTH_KV.put(`session:${hashHex}`, JSON.stringify({ createdAt: Date.now() }), { expirationTtl: 3600 });
    validToken = token;
});

describe("Object API (/api/objects)", () => {
    it("rejects requests without valid auth", async () => {
        const res = await worker.fetch(new Request(`${ENDPOINT}/api/objects?bucket=test-bucket`), ENV, CTX);
        expect(res.status).toBe(401);
    });

    it("returns 404 for unknown bucket", async () => {
        const res = await worker.fetch(
            new Request(`${ENDPOINT}/api/objects?bucket=nonexistent`, {
                headers: { Authorization: `Bearer ${validToken}` },
            }),
            ENV,
            CTX,
        );
        expect(res.status).toBe(404);
        const data = await res.json<{ message: string }>();
        expect(data.message).toContain("not found");
    });

    it("lists objects and folders with delimiter", async () => {
        // Create files in test-bucket
        drive.files.set("file-1", {
            id: "file-1",
            name: "root-file.txt",
            parent: "folder-test-bucket",
            mimeType: "text/plain",
            data: new TextEncoder().encode("hello"),
            md5Checksum: fakeMd5(new TextEncoder().encode("hello")),
            modifiedTime: "2026-08-16T08:00:00.000Z",
            trashed: false,
        });
        drive.folders.set("folder-sub", {
            id: "folder-sub",
            name: "photos",
            parent: "folder-test-bucket",
            trashed: false,
        });
        drive.files.set("file-2", {
            id: "file-2",
            name: "pic.jpg",
            parent: "folder-sub",
            mimeType: "image/jpeg",
            data: new Uint8Array([1, 2, 3]),
            md5Checksum: fakeMd5(new Uint8Array([1, 2, 3])),
            modifiedTime: "2026-08-16T08:00:00.000Z",
            trashed: false,
        });

        const res = await worker.fetch(
            new Request(`${ENDPOINT}/api/objects?bucket=test-bucket&prefix=&delimiter=/`, {
                headers: { Authorization: `Bearer ${validToken}` },
            }),
            ENV,
            CTX,
        );
        expect(res.status).toBe(200);
        const data = await res.json<{
            bucket: string;
            prefix: string;
            delimiter: string;
            folders: Array<{ prefix: string; name: string }>;
            objects: Array<{ key: string; name: string; size: number; contentType: string }>;
            truncated: boolean;
        }>();

        expect(data.bucket).toBe("test-bucket");
        expect(data.folders).toEqual([{ prefix: "photos/", name: "photos" }]);
        expect(data.objects).toHaveLength(1);
        expect(data.objects[0].name).toBe("root-file.txt");
        expect(data.objects[0].key).toBe("root-file.txt");
        expect(data.truncated).toBe(false);

        // List nested folder
        const subRes = await worker.fetch(
            new Request(`${ENDPOINT}/api/objects?bucket=test-bucket&prefix=photos/&delimiter=/`, {
                headers: { Authorization: `Bearer ${validToken}` },
            }),
            ENV,
            CTX,
        );
        expect(subRes.status).toBe(200);
        const subData = await subRes.json<{
            folders: Array<{ prefix: string; name: string }>;
            objects: Array<{ key: string; name: string; size: number }>;
        }>();
        expect(subData.folders).toEqual([]);
        expect(subData.objects).toHaveLength(1);
        expect(subData.objects[0].name).toBe("pic.jpg");
        expect(subData.objects[0].key).toBe("photos/pic.jpg");
    });

    it("gets object metadata", async () => {
        drive.files.set("file-1", {
            id: "file-1",
            name: "test.txt",
            parent: "folder-test-bucket",
            mimeType: "text/plain",
            data: new TextEncoder().encode("content"),
            md5Checksum: fakeMd5(new TextEncoder().encode("content")),
            modifiedTime: "2026-08-16T08:00:00.000Z",
            trashed: false,
        });

        const res = await worker.fetch(
            new Request(`${ENDPOINT}/api/objects/metadata?bucket=test-bucket&key=test.txt`, {
                headers: { Authorization: `Bearer ${validToken}` },
            }),
            ENV,
            CTX,
        );
        expect(res.status).toBe(200);
        const data = await res.json<{ key: string; name: string; size: number; contentType: string }>();
        expect(data.key).toBe("test.txt");
        expect(data.name).toBe("test.txt");
        expect(data.size).toBe(7);
        expect(data.contentType).toBe("text/plain");
    });

    it("direct PUT and GET content", async () => {
        const payload = new Uint8Array([10, 20, 30, 40]);
        const putRes = await worker.fetch(
            new Request(`${ENDPOINT}/api/objects/content?bucket=test-bucket&key=binary.bin`, {
                method: "PUT",
                headers: {
                    Authorization: `Bearer ${validToken}`,
                    "Content-Type": "application/octet-stream",
                },
                body: payload,
            }),
            ENV,
            CTX,
        );
        expect(putRes.status).toBe(200);
        const putData = await putRes.json<{ key: string; etag: string; size: number }>();
        expect(putData.key).toBe("binary.bin");

        const getRes = await worker.fetch(
            new Request(`${ENDPOINT}/api/objects/content?bucket=test-bucket&key=binary.bin`, {
                headers: { Authorization: `Bearer ${validToken}` },
            }),
            ENV,
            CTX,
        );
        expect(getRes.status).toBe(200);
        expect(getRes.headers.get("Content-Disposition")).toContain("binary.bin");
        const body = new Uint8Array(await getRes.arrayBuffer());
        expect(body).toEqual(payload);
    });

    it("creates and deletes folders with empty / non-empty checks", async () => {
        // Create folder
        const createRes = await worker.fetch(
            new Request(`${ENDPOINT}/api/objects/folder`, {
                method: "POST",
                headers: { Authorization: `Bearer ${validToken}`, "Content-Type": "application/json" },
                body: JSON.stringify({ bucket: "test-bucket", prefix: "my-folder/" }),
            }),
            ENV,
            CTX,
        );
        expect(createRes.status).toBe(201);

        // Put a file inside folder
        await worker.fetch(
            new Request(`${ENDPOINT}/api/objects/content?bucket=test-bucket&key=my-folder/item.txt`, {
                method: "PUT",
                headers: { Authorization: `Bearer ${validToken}` },
                body: "hello",
            }),
            ENV,
            CTX,
        );

        // Try deleting non-empty folder without recursive=1 -> 409
        const delRes409 = await worker.fetch(
            new Request(`${ENDPOINT}/api/objects/folder?bucket=test-bucket&prefix=my-folder/`, {
                method: "DELETE",
                headers: { Authorization: `Bearer ${validToken}` },
            }),
            ENV,
            CTX,
        );
        expect(delRes409.status).toBe(409);

        // Delete with recursive=1 -> 204
        const delRes204 = await worker.fetch(
            new Request(`${ENDPOINT}/api/objects/folder?bucket=test-bucket&prefix=my-folder/&recursive=1`, {
                method: "DELETE",
                headers: { Authorization: `Bearer ${validToken}` },
            }),
            ENV,
            CTX,
        );
        expect(delRes204.status).toBe(204);
    });

    it("supports download tickets without session token", async () => {
        await worker.fetch(
            new Request(`${ENDPOINT}/api/objects/content?bucket=test-bucket&key=ticket-doc.pdf`, {
                method: "PUT",
                headers: { Authorization: `Bearer ${validToken}` },
                body: "pdf contents here",
            }),
            ENV,
            CTX,
        );

        // Create download ticket
        const ticketRes = await worker.fetch(
            new Request(`${ENDPOINT}/api/objects/download-ticket`, {
                method: "POST",
                headers: { Authorization: `Bearer ${validToken}`, "Content-Type": "application/json" },
                body: JSON.stringify({ bucket: "test-bucket", key: "ticket-doc.pdf" }),
            }),
            ENV,
            CTX,
        );
        expect(ticketRes.status).toBe(201);
        const { ticket, downloadUrl } = await ticketRes.json<{ ticket: string; downloadUrl: string }>();
        expect(ticket).toBeDefined();

        // Download without Authorization header using ticket
        const dlRes = await worker.fetch(new Request(`${ENDPOINT}${downloadUrl}`), ENV, CTX);
        expect(dlRes.status).toBe(200);
        expect(await dlRes.text()).toBe("pdf contents here");

        // Second attempt with same ticket should fail (single use)
        const dlRes2 = await worker.fetch(new Request(`${ENDPOINT}${downloadUrl}`), ENV, CTX);
        expect(dlRes2.status).toBe(403);
    });

    it("performs full multipart upload flow via JSON API with non-aligned parts", async () => {
        // 1. Initiate multipart
        const initRes = await worker.fetch(
            new Request(`${ENDPOINT}/api/objects/uploads`, {
                method: "POST",
                headers: { Authorization: `Bearer ${validToken}`, "Content-Type": "application/json" },
                body: JSON.stringify({ bucket: "test-bucket", key: "large-video.mp4", contentType: "video/mp4" }),
            }),
            ENV,
            CTX,
        );
        expect(initRes.status).toBe(201);
        const { uploadId, partSize } = await initRes.json<{ uploadId: string; partSize: number }>();
        expect(uploadId).toBeDefined();
        expect(partSize).toBe(8 * 1024 * 1024);

        // 2. Upload part 1: 300 KiB (non-aligned to 256 KiB)
        const part1Data = bytes(300 * 1024, 11);
        const part1Res = await worker.fetch(
            new Request(`${ENDPOINT}/api/objects/uploads/part?bucket=test-bucket&key=large-video.mp4&uploadId=${encodeURIComponent(uploadId)}&partNumber=1`, {
                method: "PUT",
                headers: { Authorization: `Bearer ${validToken}`, "Content-Length": String(part1Data.byteLength) },
                body: part1Data,
            }),
            ENV,
            CTX,
        );
        expect(part1Res.status).toBe(200);
        const part1Json = await part1Res.json<{ partNumber: number; etag: string }>();

        // 3. Upload part 2: 200 KiB (non-aligned)
        const part2Data = bytes(200 * 1024, 22);
        const part2Res = await worker.fetch(
            new Request(`${ENDPOINT}/api/objects/uploads/part?bucket=test-bucket&key=large-video.mp4&uploadId=${encodeURIComponent(uploadId)}&partNumber=2`, {
                method: "PUT",
                headers: { Authorization: `Bearer ${validToken}`, "Content-Length": String(part2Data.byteLength) },
                body: part2Data,
            }),
            ENV,
            CTX,
        );
        expect(part2Res.status).toBe(200);
        const part2Json = await part2Res.json<{ partNumber: number; etag: string }>();

        // 4. Complete multipart
        const completeRes = await worker.fetch(
            new Request(`${ENDPOINT}/api/objects/uploads/complete`, {
                method: "POST",
                headers: { Authorization: `Bearer ${validToken}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                    bucket: "test-bucket",
                    key: "large-video.mp4",
                    uploadId,
                    parts: [
                        { partNumber: 1, etag: part1Json.etag },
                        { partNumber: 2, etag: part2Json.etag },
                    ],
                }),
            }),
            ENV,
            CTX,
        );
        expect(completeRes.status).toBe(200);
        const completeJson = await completeRes.json<{ key: string; etag: string }>();
        expect(completeJson.key).toBe("large-video.mp4");

        // Verify stored data
        const storedFile = [...drive.files.values()].find((f) => f.name === "large-video.mp4");
        expect(storedFile).toBeDefined();
        const expectedBytes = new Uint8Array(part1Data.byteLength + part2Data.byteLength);
        expectedBytes.set(part1Data, 0);
        expectedBytes.set(part2Data, part1Data.byteLength);
        expect(storedFile!.data).toEqual(expectedBytes);
    });
});
