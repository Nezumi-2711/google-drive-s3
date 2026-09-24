import { AwsClient } from "aws4fetch";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { decodedBodyChunks } from "../src/aws-chunked";
import worker from "../src/index";
import { completeMultipartUpload, encodeUploadId, uploadPartCore } from "../src/multipart-core";
import type { Env } from "../src/types";
import { bytes, FAKE_MODIFIED_TIME, FakeDrive, fakeMd5 } from "./fake-drive";

import { env } from "cloudflare:test";

const ENV = env as unknown as Env;
const ENDPOINT = "https://s3-api.example.com";
const CTX = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;

async function signed(path: string, init: RequestInit): Promise<Request> {
    const aws = new AwsClient({ accessKeyId: ENV.ACCESS_KEY, secretAccessKey: ENV.SECRET_KEY, region: ENV.REGION, service: "s3" });
    const bodyLength = typeof init.body === "string" ? new TextEncoder().encode(init.body).byteLength : init.body instanceof Uint8Array ? init.body.byteLength : undefined;
    return aws.sign(`${ENDPOINT}${path}`, {
        ...init,
        headers: { "x-amz-content-sha256": "UNSIGNED-PAYLOAD", ...(bodyLength === undefined ? {} : { "x-amz-decoded-content-length": String(bodyLength) }), ...init.headers },
    });
}

async function presigned(path: string, init: RequestInit, options: { datetime?: string; accessKeyId?: string; expires?: string } = {}): Promise<Request> {
    const url = new URL(`${ENDPOINT}${path}`);
    url.searchParams.set("X-Amz-Expires", options.expires ?? "60");
    const aws = new AwsClient({ accessKeyId: options.accessKeyId ?? ENV.ACCESS_KEY, secretAccessKey: ENV.SECRET_KEY, region: ENV.REGION, service: "s3" });
    const bodyLength = typeof init.body === "string" ? new TextEncoder().encode(init.body).byteLength : init.body instanceof Uint8Array ? init.body.byteLength : undefined;
    return aws.sign(url.toString(), {
        ...init,
        headers: { "x-amz-content-sha256": "UNSIGNED-PAYLOAD", ...(bodyLength === undefined ? {} : { "x-amz-decoded-content-length": String(bodyLength) }), ...init.headers },
        aws: { signQuery: true, ...(options.datetime ? { datetime: options.datetime } : {}) },
    });
}

let drive: FakeDrive;

beforeEach(async () => {
    drive = new FakeDrive();
    // Pre-create root folder "s3-storage" under "root" and bucket folders under root folder
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
});

describe("S3 compatibility", () => {
    it("warms a deep path on HEAD and uses only media calls for subsequent ranges", async () => {
        const path = "/test-bucket/actions_log/owner/repo/03/job.log.zst";
        const uploaded = await worker.fetch(await signed(path, { method: "PUT", body: "0123456789" }), ENV, CTX);
        expect(uploaded.status).toBe(200);
        for (const { name } of (await ENV.FOLDER_CACHE.list({ prefix: "drive-lookup:" })).keys) await ENV.FOLDER_CACHE.delete(name);
        vi.mocked(fetch).mockClear();

        const firstHead = await worker.fetch(await signed(path, { method: "HEAD" }), ENV, CTX);
        expect(firstHead.status).toBe(200);
        expect(firstHead.headers.get("Content-Length")).toBe("10");
        expect(fetch).toHaveBeenCalledTimes(5);
        vi.mocked(fetch).mockClear();
        const secondHead = await worker.fetch(await signed(path, { method: "HEAD" }), ENV, CTX);
        expect(secondHead.status).toBe(200);
        expect(secondHead.headers.get("ETag")).toBe(firstHead.headers.get("ETag"));
        expect(fetch).not.toHaveBeenCalled();

        for (const [range, expected] of [
            ["bytes=8-", "89"],
            ["bytes=6-", "6789"],
            ["bytes=0-5", "012345"],
        ]) {
            vi.mocked(fetch).mockClear();
            const response = await worker.fetch(await signed(path, { method: "GET", headers: { Range: range } }), ENV, CTX);
            expect(response.status).toBe(206);
            expect(response.headers.get("Content-Length")).toBe(String(expected.length));
            expect(await response.text()).toBe(expected);
            expect(fetch).toHaveBeenCalledTimes(1);
            const input = vi.mocked(fetch).mock.calls[0][0];
            expect(new URL(input instanceof Request ? input.url : String(input)).searchParams.get("alt")).toBe("media");
        }
    });

    it("invalidates warm metadata and stats on S3 overwrite, delete and recreate", async () => {
        const path = "/test-bucket/nested/mutable.txt";
        expect((await worker.fetch(await signed(path, { method: "PUT", body: "old" }), ENV, CTX)).status).toBe(200);
        const oldHead = await worker.fetch(await signed(path, { method: "HEAD" }), ENV, CTX);
        expect(oldHead.headers.get("Content-Length")).toBe("3");
        await ENV.FOLDER_CACHE.put("bucket-stats:test-bucket", "stale");

        const put = await worker.fetch(await signed(path, { method: "PUT", body: "new contents", headers: { "Content-Type": "text/plain" } }), ENV, CTX);
        expect(put.status).toBe(200);
        expect(await ENV.FOLDER_CACHE.get("bucket-stats:test-bucket")).toBeNull();
        const updatedHead = await worker.fetch(await signed(path, { method: "HEAD" }), ENV, CTX);
        expect(updatedHead.headers.get("Content-Length")).toBe("12");
        expect(updatedHead.headers.get("Content-Type")).toBe("text/plain");
        expect(updatedHead.headers.get("ETag")).toBe(put.headers.get("ETag"));
        expect(updatedHead.headers.get("ETag")).not.toBe(oldHead.headers.get("ETag"));
        const ranged = await worker.fetch(await signed(path, { method: "GET", headers: { Range: "bytes=4-" } }), ENV, CTX);
        expect(await ranged.text()).toBe("contents");

        expect((await worker.fetch(await signed(path, { method: "DELETE" }), ENV, CTX)).status).toBe(204);
        expect((await worker.fetch(await signed(path, { method: "HEAD" }), ENV, CTX)).status).toBe(404);
        const missing = await worker.fetch(await signed(path, { method: "GET" }), ENV, CTX);
        expect(missing.status).toBe(404);
        await missing.text();
        expect((await worker.fetch(await signed(path, { method: "PUT", body: "reborn" }), ENV, CTX)).status).toBe(200);
        const recreated = await worker.fetch(await signed(path, { method: "GET" }), ENV, CTX);
        expect(recreated.status).toBe(200);
        expect(await recreated.text()).toBe("reborn");
    });

    it("bypasses warm read caches when disabled and authenticates cached objects", async () => {
        const path = "/test-bucket/nested/private.txt";
        await worker.fetch(await signed(path, { method: "PUT", body: "secret" }), ENV, CTX);
        await worker.fetch(await signed(path, { method: "HEAD" }), ENV, CTX);
        vi.mocked(fetch).mockClear();
        const denied = await worker.fetch(new Request(`${ENDPOINT}${path}`), ENV, CTX);
        expect(denied.status).toBe(403);
        await denied.text();
        expect(fetch).not.toHaveBeenCalled();

        const response = await worker.fetch(await signed(path, { method: "GET" }), { ...ENV, ENABLE_READ_CACHE: "false" }, CTX);
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("secret");
        expect(fetch).toHaveBeenCalledTimes(3);
    });

    it.each(["corrupt", "expired", "invalid"])("refetches %s lookup cache entries", async (mode) => {
        const path = "/test-bucket/nested/fresh.txt";
        await worker.fetch(await signed(path, { method: "PUT", body: "fresh" }), ENV, CTX);
        await worker.fetch(await signed(path, { method: "HEAD" }), ENV, CTX);
        for (const { name } of (await ENV.FOLDER_CACHE.list({ prefix: "drive-lookup:" })).keys) {
            const value = mode === "corrupt" ? "{" : JSON.stringify({ expiresAt: Date.now() + (mode === "expired" ? -1 : 60_000), value: { id: 123 } });
            await ENV.FOLDER_CACHE.put(name, value);
        }
        vi.mocked(fetch).mockClear();
        const response = await worker.fetch(await signed(path, { method: "HEAD" }), ENV, CTX);
        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Length")).toBe("5");
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("re-resolves an externally replaced file once when cached media returns 404", async () => {
        const path = "/test-bucket/file.txt";
        await worker.fetch(await signed(path, { method: "PUT", body: "old" }), ENV, CTX);
        await worker.fetch(await signed(path, { method: "HEAD" }), ENV, CTX);
        const stored = [...drive.files.values()].find((file) => file.name === "file.txt");
        if (!stored) throw new Error("Uploaded file missing");
        drive.files.delete(stored.id);
        const data = new TextEncoder().encode("replacement");
        drive.files.set("external-replacement", { ...stored, id: "external-replacement", data, md5Checksum: fakeMd5(data) });
        vi.mocked(fetch).mockClear();

        const response = await worker.fetch(await signed(path, { method: "GET", headers: { Range: "bytes=0-2" } }), ENV, CTX);
        expect(response.status).toBe(206);
        expect(await response.text()).toBe("rep");
        expect(fetch).toHaveBeenCalledTimes(3);
    });

    it("keeps cached metadata scoped to parent folder IDs", async () => {
        for (const [folder, value] of [
            ["first", "one"],
            ["second", "different"],
        ]) {
            const path = `/test-bucket/${folder}/same.txt`;
            await worker.fetch(await signed(path, { method: "PUT", body: value }), ENV, CTX);
            const head = await worker.fetch(await signed(path, { method: "HEAD" }), ENV, CTX);
            expect(head.headers.get("Content-Length")).toBe(String(value.length));
        }
        vi.mocked(fetch).mockClear();
        const response = await worker.fetch(await signed("/test-bucket/first/same.txt", { method: "HEAD" }), ENV, CTX);
        expect(response.headers.get("Content-Length")).toBe("3");
        expect(fetch).not.toHaveBeenCalled();
    });

    it.each([
        { code: "NoSuchUpload", status: 404 },
        { code: "InvalidPart", status: 400 },
        { code: "InternalError", status: 500 },
    ])("maps multipart part error $code to HTTP $status", async ({ code, status }) => {
        const beginPart = vi.fn().mockResolvedValue({ kind: "error", code, message: "Part admission failed" });
        const testEnv = { ...ENV, MPU: { getByName: () => ({ beginPart }) } as unknown as Env["MPU"] };
        const uploadId = encodeUploadId("test-bucket", "file.bin");
        const request = new Request(`${ENDPOINT}/test-bucket/file.bin`, { method: "PUT", headers: { "Content-Length": "1" }, body: "x" });

        const result = await uploadPartCore(request, testEnv, "token", "test-bucket", "file.bin", uploadId, 1);

        expect(beginPart).toHaveBeenCalledWith(expect.any(String), 1, 1);
        expect(result).toEqual({ kind: "error", code, status, message: "Part admission failed" });
    });

    it.each([
        { code: "NoSuchUpload", status: 404 },
        { code: "InvalidPart", status: 400 },
        { code: "InvalidPartOrder", status: 400 },
        { code: "InternalError", status: 500 },
    ])("maps multipart completion error $code to HTTP $status", async ({ code, status }) => {
        const complete = vi.fn().mockResolvedValue({ kind: "error", code, message: "Completion failed" });
        const testEnv = { ...ENV, MPU: { getByName: () => ({ complete }) } as unknown as Env["MPU"] };
        const uploadId = encodeUploadId("test-bucket", "file.bin");
        const parts = [{ partNumber: 1, etag: "part-etag" }];

        const result = await completeMultipartUpload(testEnv, "test-bucket", "file.bin", uploadId, parts, 1);

        expect(complete).toHaveBeenCalledWith(parts, 1);
        expect(result).toEqual({ kind: "error", code, status, message: "Completion failed" });
    });

    it.each([undefined, "false"])("keeps timing logs disabled with ENABLE_TIMING_LOGS=%s", async (flag) => {
        const info = vi.spyOn(console, "info").mockImplementation(() => {});
        try {
            const response = await worker.fetch(await signed("/test-bucket?delimiter=/", { method: "GET" }), { ...ENV, ENABLE_TIMING_LOGS: flag }, CTX);
            expect(response.status).toBe(200);
            await response.text();
            expect(info).not.toHaveBeenCalled();
        } finally {
            info.mockRestore();
        }
    });

    it.each([
        { path: "/test-bucket?delimiter=/", method: "GET", hasKey: false, hasRange: false, status: 200 },
        { path: "/test-bucket/private.txt", method: "GET", hasKey: true, hasRange: false, status: 200 },
        { path: "/test-bucket/private.txt", method: "GET", hasKey: true, hasRange: true, status: 206 },
        { path: "/test-bucket/private.txt", method: "HEAD", hasKey: true, hasRange: false, status: 200 },
        { path: "/test-bucket/missing.txt", method: "GET", hasKey: true, hasRange: false, status: 404 },
        { path: "/missing-bucket/private.txt", method: "GET", hasKey: true, hasRange: false, status: 403 },
    ])("logs opt-in S3 timing without signed URL data for $method $path (Range=$hasRange)", async ({ path, method, hasKey, hasRange, status }) => {
        await worker.fetch(await signed("/test-bucket/private.txt", { method: "PUT", body: "private content" }), ENV, CTX);
        const info = vi.spyOn(console, "info").mockImplementation(() => {});
        try {
            const response = await worker.fetch(await presigned(path, { method, headers: hasRange ? { Range: "bytes=0-6" } : {} }), { ...ENV, ENABLE_TIMING_LOGS: "true" }, CTX);
            expect(response.status).toBe(status);
            expect(info).toHaveBeenCalledTimes(1);
            const entry = JSON.parse(String(info.mock.calls[0][0]));
            const timingPattern = method === "HEAD" ? /^path;dur=\d+\.\d, file;dur=\d+\.\d$/ : /^path;dur=\d+\.\d, file;dur=\d+\.\d, media;dur=\d+\.\d$/;
            const expectedStages = status === 403 ? { registry: expect.any(Number) } : { registry: expect.any(Number), auth: expect.any(Number), token: expect.any(Number), dispatch: expect.any(Number) };
            expect(entry).toEqual({ type: "s3-timing", method, hasKey, hasRange, status, durationMs: expect.any(Number), stages: expectedStages, serverTiming: (status === 200 || status === 206) && hasKey ? expect.stringMatching(timingPattern) : null });
            expect(entry.durationMs).toBeGreaterThanOrEqual(0);
            for (const duration of Object.values(entry.stages)) expect(duration).toBeGreaterThanOrEqual(0);
            expect(entry.serverTiming).toBe(response.headers.get("Server-Timing"));
            if (hasRange) {
                expect(response.headers.get("Content-Range")).toBe("bytes 0-6/15");
                expect(response.headers.get("Content-Length")).toBe("7");
                expect(await response.text()).toBe("private");
            } else if (method === "GET" && path.endsWith("/private.txt") && status === 200) {
                expect(await response.text()).toBe("private content");
            } else {
                await response.text();
            }
        } finally {
            info.mockRestore();
        }
    });

    it.each([
        { method: "GET", path: "/test-bucket/read.txt", calls: 2, expected: "payload" },
        { method: "HEAD", path: "/test-bucket/read.txt", calls: 1, expected: "" },
        { method: "GET", path: "/test-bucket?delimiter=/", calls: 1, expected: "<Key>read.txt</Key>" },
        { method: "GET", path: "/test-bucket/nested/read.txt", calls: 2, expected: "nested payload" },
        { method: "HEAD", path: "/test-bucket/nested/read.txt", calls: 1, expected: "" },
        { method: "GET", path: "/test-bucket?prefix=nested/&delimiter=/", calls: 2, expected: "<Key>nested/read.txt</Key>" },
        { method: "GET", path: "/test-bucket", calls: 2, expected: "<Key>nested/read.txt</Key>" },
    ])("reuses the registered bucket folder for $method $path", async ({ method, path, calls, expected }) => {
        await worker.fetch(await signed("/test-bucket/read.txt", { method: "PUT", body: "payload" }), ENV, CTX);
        await worker.fetch(await signed("/test-bucket/nested/read.txt", { method: "PUT", body: "nested payload" }), ENV, CTX);
        vi.mocked(fetch).mockClear();

        const response = await worker.fetch(await signed(path, { method }), ENV, CTX);

        expect(response.status).toBe(200);
        expect(await response.text()).toContain(expected);
        expect(fetch).toHaveBeenCalledTimes(calls);
        const queries = vi.mocked(fetch).mock.calls.map(([input]) => new URL(input instanceof Request ? input.url : String(input)).searchParams.get("q"));
        expect(queries.some((query) => query?.includes("name='test-bucket'"))).toBe(false);
    });

    it("returns an empty PutObject response and overwrites the same Drive file", async () => {
        const first = await worker.fetch(await signed("/test-bucket/file.txt", { method: "PUT", body: "first" }), ENV, CTX);
        expect(first.status).toBe(200);
        expect(await first.text()).toBe("");
        expect(first.headers.get("ETag")).toMatch(/^"[0-9a-f]{32}"$/);

        const second = await worker.fetch(await signed("/test-bucket/file.txt", { method: "PUT", body: "second" }), ENV, CTX);
        expect(second.status).toBe(200);
        expect([...drive.files.values()].filter((file) => file.name === "file.txt")).toHaveLength(1);
        const stored = [...drive.files.values()].find((file) => file.name === "file.txt");
        expect(stored).toBeDefined();
        if (!stored) throw new Error("Overwritten object was not stored");
        expect(new TextDecoder().decode(stored.data)).toBe("second");
    });

    it("sets Last-Modified on GET and HEAD from Drive's modifiedTime", async () => {
        await worker.fetch(await signed("/test-bucket/dated.txt", { method: "PUT", body: "hi" }), ENV, CTX);

        const expected = new Date(FAKE_MODIFIED_TIME).toUTCString();

        const get = await worker.fetch(await signed("/test-bucket/dated.txt", { method: "GET" }), ENV, CTX);
        expect(get.headers.get("Last-Modified")).toBe(expected);

        const head = await worker.fetch(await signed("/test-bucket/dated.txt", { method: "HEAD" }), ENV, CTX);
        expect(head.headers.get("Last-Modified")).toBe(expected);
    });

    it("forwards Range and returns a standard XML NoSuchKey", async () => {
        await worker.fetch(await signed("/test-bucket/range.bin", { method: "PUT", body: "0123456789" }), ENV, CTX);
        const response = await worker.fetch(await signed("/test-bucket/range.bin", { method: "GET", headers: { Range: "bytes=2-5" } }), ENV, CTX);
        expect(response.status).toBe(206);
        expect(response.headers.get("Content-Range")).toBe("bytes 2-5/10");
        expect(response.headers.get("Accept-Ranges")).toBe("bytes");
        expect(await response.text()).toBe("2345");

        const missing = await worker.fetch(await signed("/test-bucket/missing", { method: "GET" }), ENV, CTX);
        expect(missing.status).toBe(404);
        expect(await missing.text()).toContain("<Code>NoSuchKey</Code>");
    });

    describe("large downloads", () => {
        const MiB = 1024 * 1024;
        const data = bytes(4 * MiB + 123);

        function storeLarge(): void {
            drive.files.set("file-large", { id: "file-large", name: "large.bin", parent: "folder-test-bucket", mimeType: "application/octet-stream", data, md5Checksum: fakeMd5(data), modifiedTime: FAKE_MODIFIED_TIME });
        }

        async function expectBody(response: Response, expected: Uint8Array): Promise<void> {
            const actual = new Uint8Array(await response.arrayBuffer());
            expect(actual.byteLength).toBe(expected.byteLength);
            expect(actual.findIndex((byte, index) => byte !== expected[index])).toBe(-1);
        }

        function mediaRanges(): Array<string | null> {
            return vi
                .mocked(fetch)
                .mock.calls.filter(([input]) => new URL(input instanceof Request ? input.url : String(input)).searchParams.get("alt") === "media")
                .map(([input, init]) => (input instanceof Request ? input.headers : new Headers(init?.headers)).get("Range"));
        }

        it("streams a full download as growing Drive ranges", async () => {
            storeLarge();
            vi.mocked(fetch).mockClear();

            const response = await worker.fetch(await signed("/test-bucket/large.bin", { method: "GET" }), ENV, CTX);

            expect(response.status).toBe(200);
            expect(response.headers.get("Content-Length")).toBe(String(data.byteLength));
            expect(response.headers.get("Content-Range")).toBeNull();
            await expectBody(response, data);
            expect(mediaRanges()).toEqual([`bytes=0-${MiB - 1}`, `bytes=${MiB}-${3 * MiB - 1}`, `bytes=${3 * MiB}-${data.byteLength - 1}`]);
        });

        it("stops reading Drive when the client closes early and serves the next request", async () => {
            storeLarge();
            const first = await worker.fetch(await signed("/test-bucket/large.bin", { method: "GET" }), ENV, CTX);
            const reader = first.body?.getReader();
            if (!reader) throw new Error("Download had no body");
            expect((await reader.read()).done).toBe(false);
            await reader.cancel();

            const second = await worker.fetch(await signed("/test-bucket/large.bin", { method: "GET" }), ENV, CTX);
            await expectBody(second, data);
        });

        it.each([
            { range: "bytes=1000-2500000", start: 1000, end: 2_500_000 },
            { range: "bytes=-10", start: 4 * MiB + 113, end: 4 * MiB + 122 },
            { range: `bytes=${MiB}-`, start: MiB, end: 4 * MiB + 122 },
            { range: "bytes=10-99999999", start: 10, end: 4 * MiB + 122 },
        ])("serves $range across Drive ranges", async ({ range, start, end }) => {
            storeLarge();
            const response = await worker.fetch(await signed("/test-bucket/large.bin", { method: "GET", headers: { Range: range } }), ENV, CTX);
            expect(response.status).toBe(206);
            expect(response.headers.get("Content-Range")).toBe(`bytes ${start}-${end}/${data.byteLength}`);
            expect(response.headers.get("Content-Length")).toBe(String(end - start + 1));
            await expectBody(response, data.slice(start, end + 1));
        });

        it.each(["bytes=0-1,5-6", "bytes=9-2", "items=0-1"])("ignores unsupported Range %s like S3", async (range) => {
            await worker.fetch(await signed("/test-bucket/small.txt", { method: "PUT", body: "0123456789" }), ENV, CTX);
            const response = await worker.fetch(await signed("/test-bucket/small.txt", { method: "GET", headers: { Range: range } }), ENV, CTX);
            expect(response.status).toBe(200);
            expect(await response.text()).toBe("0123456789");
        });

        it.each(["bytes=10-", "bytes=-0"])("returns InvalidRange for unsatisfiable %s", async (range) => {
            await worker.fetch(await signed("/test-bucket/small.txt", { method: "PUT", body: "0123456789" }), ENV, CTX);
            const response = await worker.fetch(await signed("/test-bucket/small.txt", { method: "GET", headers: { Range: range } }), ENV, CTX);
            expect(response.status).toBe(416);
            expect(response.headers.get("Content-Range")).toBe("bytes */10");
            expect(await response.text()).toContain("<Code>InvalidRange</Code>");
        });

        it("retries a later range after a transient error and an expired token", async () => {
            storeLarge();
            const failures = [503, 401];
            vi.mocked(fetch).mockImplementation(async (input, init) => {
                const range = new Headers(init?.headers).get("Range");
                const status = range === `bytes=${MiB}-${3 * MiB - 1}` ? failures.shift() : undefined;
                return status ? new Response("unavailable", { status }) : drive.handle(input, init);
            });

            const response = await worker.fetch(await signed("/test-bucket/large.bin", { method: "GET" }), ENV, CTX);

            await expectBody(response, data);
            expect(failures).toEqual([]);
            expect(mediaRanges().filter((range) => range === `bytes=${MiB}-${3 * MiB - 1}`)).toHaveLength(3);
        });

        it("errors the body instead of truncating silently when a later range fails", async () => {
            storeLarge();
            const error = vi.spyOn(console, "error").mockImplementation(() => {});
            vi.mocked(fetch).mockImplementation(async (input, init) => {
                const range = new Headers(init?.headers).get("Range");
                return range?.startsWith(`bytes=${MiB}-`) ? new Response("forbidden", { status: 403 }) : drive.handle(input, init);
            });

            try {
                const response = await worker.fetch(await signed("/test-bucket/large.bin", { method: "GET" }), ENV, CTX);
                expect(response.status).toBe(200);
                await expect(response.arrayBuffer()).rejects.toThrow();
                expect(error).toHaveBeenCalledWith(JSON.stringify({ message: "drive range read failed", status: 403, attempt: 1 }));
            } finally {
                error.mockRestore();
            }
        });

        it("re-resolves cached metadata when the live file size changed under the same ID", async () => {
            await worker.fetch(await signed("/test-bucket/grown.txt", { method: "PUT", body: "old" }), ENV, CTX);
            expect((await worker.fetch(await signed("/test-bucket/grown.txt", { method: "HEAD" }), ENV, CTX)).headers.get("Content-Length")).toBe("3");
            const stored = [...drive.files.values()].find((file) => file.name === "grown.txt");
            if (!stored) throw new Error("Uploaded file missing");
            stored.data = new TextEncoder().encode("a longer replacement");

            const response = await worker.fetch(await signed("/test-bucket/grown.txt", { method: "GET" }), ENV, CTX);
            expect(response.headers.get("Content-Length")).toBe("20");
            expect(await response.text()).toBe("a longer replacement");
        });
    });

    it("verifies PUT signatures with Accept-Encoding: identity even when Cloudflare rewrites the delivered value", async () => {
        const original = await signed("/test-bucket/ae.txt", { method: "PUT", body: "hello", headers: { "accept-encoding": "identity" } });
        const rewrittenHeaders = new Headers(original.headers);
        rewrittenHeaders.set("accept-encoding", "gzip, deflate, br");
        const mutated = new Request(original, { headers: rewrittenHeaders });

        const response = await worker.fetch(mutated, ENV, CTX);
        expect(response.status).toBe(200);
    });

    it("verifies GetObject signatures with Accept-Encoding: gzip (aws-sdk-go-v2/rclone signs gzip only for GetObject, identity elsewhere)", async () => {
        await worker.fetch(await signed("/test-bucket/ae-get.txt", { method: "PUT", body: "hello" }), ENV, CTX);
        const original = await signed("/test-bucket/ae-get.txt", { method: "GET", headers: { "accept-encoding": "gzip" } });
        const rewrittenHeaders = new Headers(original.headers);
        rewrittenHeaders.set("accept-encoding", "gzip, br");
        const mutated = new Request(original, { headers: rewrittenHeaders });

        const response = await worker.fetch(mutated, ENV, CTX);
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("hello");
    });

    it("verifies GetObject signatures with Accept-Encoding: identity (aws-sdk-go-v2 signs identity on every operation)", async () => {
        await worker.fetch(await signed("/test-bucket/ae-get-identity.txt", { method: "PUT", body: "hello", headers: { "accept-encoding": "identity" } }), ENV, CTX);
        const original = await signed("/test-bucket/ae-get-identity.txt?x-id=GetObject", { method: "GET", headers: { "accept-encoding": "identity" } });
        const rewrittenHeaders = new Headers(original.headers);
        rewrittenHeaders.set("accept-encoding", "gzip, br");
        const mutated = new Request(original, { headers: rewrittenHeaders });

        const response = await worker.fetch(mutated, ENV, CTX);
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("hello");
    });

    it("verifies GetObject signatures against an unusual Accept-Encoding recovered from request.cf.clientAcceptEncoding", async () => {
        await worker.fetch(await signed("/test-bucket/ae-get-cf.txt", { method: "PUT", body: "hello" }), ENV, CTX);
        const original = await signed("/test-bucket/ae-get-cf.txt", { method: "GET", headers: { "accept-encoding": "deflate" } });
        const rewrittenHeaders = new Headers(original.headers);
        rewrittenHeaders.set("accept-encoding", "gzip, br");
        const mutated = new Request(original, { headers: rewrittenHeaders, cf: { clientAcceptEncoding: "deflate" } } as RequestInit);

        const response = await worker.fetch(mutated, ENV, CTX);
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("hello");
    });

    it("still rejects a GET whose signature matches no plausible Accept-Encoding value", async () => {
        await worker.fetch(await signed("/test-bucket/ae-get-bad.txt", { method: "PUT", body: "hello" }), ENV, CTX);
        const original = await signed("/test-bucket/ae-get-bad.txt", { method: "GET", headers: { "accept-encoding": "identity" } });
        const tampered = new Headers(original.headers);
        tampered.set("accept-encoding", "gzip, br");
        tampered.set("x-amz-content-sha256", "UNSIGNED-PAYLOAD-TAMPERED");
        const mutated = new Request(original, { headers: tampered });

        const response = await worker.fetch(mutated, ENV, CTX);
        expect(response.status).toBe(403);
        expect(await response.text()).toContain("<Code>SignatureDoesNotMatch</Code>");
    });

    it("verifies signatures for requests carrying the aws-sdk-go x-id tracing param (rclone/AWS CLI v2 GetObject)", async () => {
        // aws-sdk-go-v2 (used by rclone) signs the x-id param as part of the request by default
        // (opt.UseXID defaults to true) — it's part of the canonical query string, not appended
        // afterward. Confirmed against rclone's own request dumps.
        await worker.fetch(await signed("/test-bucket/getid.txt", { method: "PUT", body: "hello" }), ENV, CTX);
        const response = await worker.fetch(await signed("/test-bucket/getid.txt?x-id=GetObject", { method: "GET" }), ENV, CTX);
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("hello");
    });

    it("rejects expired presigned URLs and accepts unexpired ones", async () => {
        const expired = await worker.fetch(await presigned("/test-bucket/file.txt", { method: "GET" }, { datetime: "20200101T000000Z", expires: "60" }), ENV, CTX);
        expect(expired.status).toBe(403);
        expect(await expired.text()).toContain("<Code>AccessDenied</Code>");
    });

    it("accepts an unexpired presigned URL", async () => {
        await worker.fetch(await signed("/test-bucket/presigned.txt", { method: "PUT", body: "hello" }), ENV, CTX);
        const response = await worker.fetch(await presigned("/test-bucket/presigned.txt", { method: "GET" }), ENV, CTX);
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("hello");
    });

    it("rejects a Credential access key that does not match ACCESS_KEY", async () => {
        const response = await worker.fetch(await presigned("/test-bucket/file.txt", { method: "GET" }, { accessKeyId: "unexpected-access-key" }), ENV, CTX);
        expect(response.status).toBe(403);
        expect(await response.text()).toContain("<Code>AccessDenied</Code>");
    });

    it("rejects header-authenticated requests outside the 15-minute clock skew", async () => {
        const aws = new AwsClient({ accessKeyId: ENV.ACCESS_KEY, secretAccessKey: ENV.SECRET_KEY, region: ENV.REGION, service: "s3" });
        const request = await aws.sign(`${ENDPOINT}/test-bucket/file.txt`, { method: "GET", aws: { datetime: "20200101T000000Z" } });
        const response = await worker.fetch(request, ENV, CTX);
        expect(response.status).toBe(403);
        expect(await response.text()).toContain("<Code>RequestTimeTooSkewed</Code>");
    });

    it("decodes both aws-chunked framing variants across arbitrary boundaries", async () => {
        const payload = bytes(70_013);
        for (const trailer of [true, false]) {
            const framed = encodeAwsChunked(payload, trailer);
            for (const split of [1, 7, 127, 8191]) {
                const chunks: Uint8Array[] = [];
                for (let offset = 0; offset < framed.byteLength; offset += split) chunks.push(framed.slice(offset, offset + split));
                const decoded: Uint8Array[] = [];
                for await (const chunk of decodedBodyChunks(streamOf(chunks), true)) decoded.push(chunk);
                expect(concatAll(decoded)).toEqual(payload);
            }
        }
    });

    it("round-trips non-aligned multipart parts byte-exact", async () => {
        const source = bytes(1_500_123);
        const create = await worker.fetch(await signed("/test-bucket/big.bin?uploads", { method: "POST", headers: { "Content-Type": "application/octet-stream" } }), ENV, CTX);
        expect(create.status).toBe(200);
        const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(await create.text())?.[1];
        expect(uploadId).toBeDefined();
        if (!uploadId) throw new Error("Multipart initiation did not return an upload ID");
        const completed: Array<{ partNumber: number; etag: string }> = [];
        for (let index = 0, offset = 0; offset < source.byteLength; index++) {
            const end = Math.min(source.byteLength, offset + 500_000);
            const part = await worker.fetch(await signed(`/test-bucket/big.bin?partNumber=${index + 1}&uploadId=${encodeURIComponent(uploadId)}`, { method: "PUT", body: source.slice(offset, end) }), ENV, CTX);
            expect(part.status).toBe(200);
            const partEtag = part.headers.get("ETag");
            expect(partEtag).toBeDefined();
            if (!partEtag) throw new Error(`Multipart part ${index + 1} did not return an ETag`);
            completed.push({ partNumber: index + 1, etag: partEtag.replaceAll('"', "") });
            offset = end;
        }
        const xml = `<CompleteMultipartUpload>${completed.map((part) => `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>"${part.etag}"</ETag></Part>`).join("")}</CompleteMultipartUpload>`;
        const result = await worker.fetch(await signed(`/test-bucket/big.bin?uploadId=${encodeURIComponent(uploadId)}`, { method: "POST", body: xml }), ENV, CTX);
        expect(result.status).toBe(200);
        expect(await result.text()).toMatch(/<ETag>"[0-9a-f]{32}"<\/ETag>/);
        const storedFile = [...drive.files.values()].find((file) => file.name === "big.bin");
        expect(storedFile).toBeDefined();
        if (!storedFile) throw new Error("Completed multipart object was not stored");
        const stored = storedFile.data;
        expect(stored.byteLength).toBe(source.byteLength);
        expect(fakeMd5(stored)).toBe(fakeMd5(source));
    });

    it("accepts aws-chunked PutObject without storing framing", async () => {
        const source = bytes(1_000_003);
        const framed = encodeAwsChunked(source, true);
        const response = await worker.fetch(
            await signed("/test-bucket/chunked.bin", {
                method: "PUT",
                body: framed,
                headers: {
                    "content-encoding": "aws-chunked",
                    "x-amz-decoded-content-length": String(source.byteLength),
                    "x-amz-content-sha256": "STREAMING-UNSIGNED-PAYLOAD-TRAILER",
                },
            }),
            ENV,
            CTX,
        );
        expect(response.status).toBe(200);
        expect([...drive.files.values()].find((file) => file.name === "chunked.bin")?.data).toEqual(source);
    });

    it("detects aws-chunked framing from x-amz-content-sha256 alone when Content-Encoding is absent (minio-go v7 UploadPart with a streaming-signed payload omits Content-Encoding)", async () => {
        const source = bytes(4_264);
        const framed = encodeAwsChunked(source, false);
        const response = await worker.fetch(
            await signed("/test-bucket/chunked-no-header.bin", {
                method: "PUT",
                body: framed,
                headers: {
                    "x-amz-decoded-content-length": String(source.byteLength),
                    "x-amz-content-sha256": "STREAMING-AWS4-HMAC-SHA256-PAYLOAD",
                },
            }),
            ENV,
            CTX,
        );
        expect(response.status).toBe(200);
        expect([...drive.files.values()].find((file) => file.name === "chunked-no-header.bin")?.data).toEqual(source);
    });

    it("supports an empty PutObject", async () => {
        const response = await worker.fetch(await signed("/test-bucket/empty", { method: "PUT", body: new Uint8Array() }), ENV, CTX);
        expect(response.status).toBe(200);
        expect([...drive.files.values()].find((file) => file.name === "empty")?.data.byteLength).toBe(0);
    });

    it("lists nested keys under a prefix, as CommonPrefixes with a delimiter and recursively without one", async () => {
        await worker.fetch(await signed("/test-bucket/dir1/a.txt", { method: "PUT", body: "a" }), ENV, CTX);
        await worker.fetch(await signed("/test-bucket/dir1/sub/b.txt", { method: "PUT", body: "b" }), ENV, CTX);
        await worker.fetch(await signed("/test-bucket/dir2/c.txt", { method: "PUT", body: "c" }), ENV, CTX);

        const root = await worker.fetch(await signed(`/test-bucket?prefix=&delimiter=${encodeURIComponent("/")}`, { method: "GET" }), ENV, CTX);
        expect(root.status).toBe(200);
        const rootXml = await root.text();
        expect(rootXml).toContain("<CommonPrefixes><Prefix>dir1/</Prefix></CommonPrefixes>");
        expect(rootXml).toContain("<CommonPrefixes><Prefix>dir2/</Prefix></CommonPrefixes>");
        expect(rootXml).not.toContain("<Contents>");

        const dir1Delimited = await worker.fetch(await signed(`/test-bucket?prefix=${encodeURIComponent("dir1/")}&delimiter=${encodeURIComponent("/")}`, { method: "GET" }), ENV, CTX);
        const dir1Xml = await dir1Delimited.text();
        expect(dir1Xml).toContain("<Key>dir1/a.txt</Key>");
        expect(dir1Xml).toContain("<CommonPrefixes><Prefix>dir1/sub/</Prefix></CommonPrefixes>");
        expect(dir1Xml).not.toContain("dir1/sub/b.txt");

        const dir1Recursive = await worker.fetch(await signed(`/test-bucket?prefix=${encodeURIComponent("dir1/")}`, { method: "GET" }), ENV, CTX);
        const dir1RecursiveXml = await dir1Recursive.text();
        expect(dir1RecursiveXml).toContain("<Key>dir1/a.txt</Key>");
        expect(dir1RecursiveXml).toContain("<Key>dir1/sub/b.txt</Key>");
        expect(dir1RecursiveXml).not.toContain("<CommonPrefixes>");
    });

    it("reports bucket versioning as never-enabled instead of falling through to ListBucketResult (minio-go's GetBucketVersioning, used by Forgejo/Gitea storage init, rejects the latter)", async () => {
        const response = await worker.fetch(await signed("/test-bucket?versioning", { method: "GET" }), ENV, CTX);
        expect(response.status).toBe(200);
        const xml = await response.text();
        expect(xml).toContain("<VersioningConfiguration");
        expect(xml).not.toContain("<ListBucketResult");
        expect(xml).not.toContain("<Status>");
    });
});

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
        },
    });
}

function concatAll(chunks: Uint8Array[]): Uint8Array {
    const output = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return output;
}

function encodeAwsChunked(payload: Uint8Array, trailer: boolean): Uint8Array {
    const chunks: Uint8Array[] = [];
    const encoder = new TextEncoder();
    for (let offset = 0; offset < payload.byteLength; offset += 65_537) {
        const data = payload.subarray(offset, Math.min(payload.byteLength, offset + 65_537));
        const extension = trailer ? "" : `;chunk-signature=${"0".repeat(64)}`;
        chunks.push(encoder.encode(`${data.byteLength.toString(16)}${extension}\r\n`), data, encoder.encode("\r\n"));
    }
    const extension = trailer ? "" : `;chunk-signature=${"0".repeat(64)}`;
    chunks.push(encoder.encode(`0${extension}\r\n${trailer ? "x-amz-checksum-crc32:AAAAAA==\r\n" : ""}\r\n`));
    return concatAll(chunks);
}
