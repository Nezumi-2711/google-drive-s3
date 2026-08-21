import { AwsClient } from "aws4fetch";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { decodedBodyChunks } from "../src/aws-chunked";
import worker from "../src/index";
import type { Env } from "../src/types";
import { bytes, FAKE_MODIFIED_TIME, fakeMd5, FakeDrive } from "./fake-drive";

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
