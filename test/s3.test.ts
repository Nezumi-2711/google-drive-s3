import { AwsClient } from "aws4fetch";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { decodedBodyChunks } from "../src/aws-chunked";
import worker from "../src/index";
import type { Env } from "../src/types";

import { env } from "cloudflare:test";

const ENV = env as unknown as Env;
const ENDPOINT = "https://s3-api.example.com";
const CTX = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;

interface StoredFile {
    id: string;
    name: string;
    parent: string;
    mimeType: string;
    data: Uint8Array;
    md5Checksum: string;
}

interface UploadSession {
    id: string;
    fileId?: string;
    name: string;
    parent: string;
    mimeType: string;
    committed: Uint8Array;
}

class FakeDrive {
    readonly files = new Map<string, StoredFile>();
    readonly sessions = new Map<string, UploadSession>();
    private nextId = 1;

    async handle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);
        if (url.hostname === "oauth2.googleapis.com") return Response.json({ access_token: "token", expires_in: 3600 });
        if (url.hostname !== "www.googleapis.com") return new Response("Not Found", { status: 404 });

        if (url.pathname === "/drive/v3/files" && request.method === "GET") return this.search(url);
        if (url.pathname === "/drive/v3/files" && request.method === "POST") return this.createMetadata(await request.json<Record<string, unknown>>());
        if (url.pathname.startsWith("/drive/v3/files/") && url.searchParams.get("alt") === "media") return this.download(url, request);
        if (url.pathname.startsWith("/drive/v3/files/") && request.method === "DELETE") {
            this.files.delete(url.pathname.split("/").at(-1)!);
            return new Response(null, { status: 204 });
        }
        if (url.pathname.startsWith("/upload/drive/v3/files") && url.searchParams.get("uploadType") === "resumable") return this.initialize(url, request);
        if (url.pathname.startsWith("/upload/session/")) return this.upload(url, request);
        return new Response("Not Found", { status: 404 });
    }

    private search(url: URL): Response {
        const q = url.searchParams.get("q") ?? "";
        const name = /name='((?:\\.|[^'])*)'/.exec(q)?.[1]?.replace(/\\'/g, "'").replace(/\\\\/g, "\\");
        const parent = /'([^']+)' in parents/.exec(q)?.[1];
        if (q.includes("application/vnd.google-apps.folder")) {
            const id = parent ? `folder:${parent}:${name}` : `folder:${name}`;
            return Response.json({ files: [{ id, name, mimeType: "application/vnd.google-apps.folder" }] });
        }
        const files = [...this.files.values()].filter((file) => file.name === name && file.parent === parent);
        return Response.json({ files: files.map((file) => ({ ...file, size: String(file.data.byteLength), data: undefined })) });
    }

    private createMetadata(metadata: Record<string, unknown>): Response {
        const id = `file-${this.nextId++}`;
        const file: StoredFile = {
            id,
            name: String(metadata.name),
            parent: String((metadata.parents as string[] | undefined)?.[0] ?? ""),
            mimeType: String(metadata.mimeType ?? "application/octet-stream"),
            data: new Uint8Array(),
            md5Checksum: "d41d8cd98f00b204e9800998ecf8427e",
        };
        this.files.set(id, file);
        return Response.json({ ...file, size: "0", data: undefined });
    }

    private async initialize(url: URL, request: Request): Promise<Response> {
        const metadata = await request.json<{ name: string; parents?: string[] }>();
        const pathId = url.pathname.split("/").at(-1);
        const fileId = pathId === "files" ? undefined : pathId;
        const id = `session-${this.nextId++}`;
        this.sessions.set(id, {
            id,
            fileId,
            name: metadata.name,
            parent: metadata.parents?.[0] ?? (fileId ? this.files.get(fileId)?.parent : "") ?? "",
            mimeType: request.headers.get("X-Upload-Content-Type") ?? "application/octet-stream",
            committed: new Uint8Array(),
        });
        return new Response(null, { status: 200, headers: { Location: `https://www.googleapis.com/upload/session/${id}` } });
    }

    private async upload(url: URL, request: Request): Promise<Response> {
        const id = url.pathname.split("/").at(-1)!;
        const session = this.sessions.get(id);
        if (!session) return new Response(null, { status: 404 });
        if (request.method === "DELETE") {
            this.sessions.delete(id);
            return new Response(null, { status: 499 });
        }
        const range = request.headers.get("Content-Range");
        if (range === "bytes */*") return new Response(null, { status: 308, headers: this.rangeHeaders(session.committed.byteLength) });
        const body = new Uint8Array(await request.arrayBuffer());
        if (!range) return this.finalize(session, body);
        const match = /^bytes (\d+)-(\d+)\/(\*|\d+)$/.exec(range);
        if (!match) return new Response("Bad range", { status: 400 });
        const start = Number(match[1]);
        const end = Number(match[2]);
        const total = match[3] === "*" ? null : Number(match[3]);
        expect(start).toBe(session.committed.byteLength);
        expect(end - start + 1).toBe(body.byteLength);
        if (total === null) expect(body.byteLength % (256 * 1024)).toBe(0);
        session.committed = concat(session.committed, body);
        if (total === null) return new Response(null, { status: 308, headers: this.rangeHeaders(session.committed.byteLength) });
        expect(session.committed.byteLength).toBe(total);
        return this.finalize(session, session.committed);
    }

    private rangeHeaders(length: number): HeadersInit {
        return length === 0 ? {} : { Range: `bytes=0-${length - 1}` };
    }

    private finalize(session: UploadSession, data: Uint8Array): Response {
        const id = session.fileId ?? `file-${this.nextId++}`;
        const file: StoredFile = { id, name: session.name, parent: session.parent, mimeType: session.mimeType, data, md5Checksum: fakeMd5(data) };
        this.files.set(id, file);
        this.sessions.delete(session.id);
        return Response.json({ ...file, size: String(data.byteLength), data: undefined });
    }

    private download(url: URL, request: Request): Response {
        const file = this.files.get(url.pathname.split("/").at(-1)!);
        if (!file) return new Response(null, { status: 404 });
        const range = request.headers.get("Range");
        if (!range) return new Response(file.data, { headers: { "Content-Length": String(file.data.byteLength) } });
        const match = /^bytes=(\d+)-(\d+)?$/.exec(range);
        if (!match) return new Response(null, { status: 416 });
        const start = Number(match[1]);
        const end = Math.min(file.data.byteLength - 1, match[2] ? Number(match[2]) : file.data.byteLength - 1);
        const data = file.data.slice(start, end + 1);
        return new Response(data, { status: 206, headers: { "Content-Length": String(data.byteLength), "Content-Range": `bytes ${start}-${end}/${file.data.byteLength}` } });
    }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
    const output = new Uint8Array(a.byteLength + b.byteLength);
    output.set(a);
    output.set(b, a.byteLength);
    return output;
}

function fakeMd5(data: Uint8Array): string {
    let state = 0x811c9dc5;
    for (const byte of data) state = Math.imul(state ^ byte, 0x01000193);
    return (state >>> 0).toString(16).padStart(8, "0").repeat(4);
}

function bytes(length: number, seed = 17): Uint8Array {
    const output = new Uint8Array(length);
    let state = seed;
    for (let index = 0; index < length; index++) {
        state = (Math.imul(state, 1664525) + 1013904223) | 0;
        output[index] = state >>> 24;
    }
    return output;
}

async function signed(path: string, init: RequestInit): Promise<Request> {
    const aws = new AwsClient({ accessKeyId: ENV.ACCESS_KEY, secretAccessKey: ENV.SECRET_KEY, region: ENV.REGION, service: "s3" });
    const bodyLength = typeof init.body === "string" ? new TextEncoder().encode(init.body).byteLength : init.body instanceof Uint8Array ? init.body.byteLength : undefined;
    return aws.sign(`${ENDPOINT}${path}`, {
        ...init,
        headers: { "x-amz-content-sha256": "UNSIGNED-PAYLOAD", ...(bodyLength === undefined ? {} : { "x-amz-decoded-content-length": String(bodyLength) }), ...init.headers },
    });
}

let drive: FakeDrive;

beforeEach(async () => {
    drive = new FakeDrive();
    vi.stubGlobal(
        "fetch",
        vi.fn((input, init) => drive.handle(input, init)),
    );
    await ENV.AUTH_KV.delete("google_access_token");
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
        expect(new TextDecoder().decode([...drive.files.values()].find((file) => file.name === "file.txt")!.data)).toBe("second");
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

    it("verifies signatures that include Accept-Encoding even when the delivered value differs (Cloudflare rewrites it in transit)", async () => {
        const original = await signed("/test-bucket/ae.txt", { method: "PUT", body: "hello", headers: { "accept-encoding": "identity" } });
        const rewrittenHeaders = new Headers(original.headers);
        rewrittenHeaders.set("accept-encoding", "gzip, deflate, br");
        const mutated = new Request(original, { headers: rewrittenHeaders });

        const response = await worker.fetch(mutated, ENV, CTX);
        expect(response.status).toBe(200);
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
        const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(await create.text())![1];
        const completed: Array<{ partNumber: number; etag: string }> = [];
        for (let index = 0, offset = 0; offset < source.byteLength; index++) {
            const end = Math.min(source.byteLength, offset + 500_000);
            const part = await worker.fetch(await signed(`/test-bucket/big.bin?partNumber=${index + 1}&uploadId=${encodeURIComponent(uploadId)}`, { method: "PUT", body: source.slice(offset, end) }), ENV, CTX);
            expect(part.status).toBe(200);
            completed.push({ partNumber: index + 1, etag: part.headers.get("ETag")!.replaceAll('"', "") });
            offset = end;
        }
        const xml = `<CompleteMultipartUpload>${completed.map((part) => `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>"${part.etag}"</ETag></Part>`).join("")}</CompleteMultipartUpload>`;
        const result = await worker.fetch(await signed(`/test-bucket/big.bin?uploadId=${encodeURIComponent(uploadId)}`, { method: "POST", body: xml }), ENV, CTX);
        expect(result.status).toBe(200);
        expect(await result.text()).toMatch(/<ETag>"[0-9a-f]{32}"<\/ETag>/);
        const stored = [...drive.files.values()].find((file) => file.name === "big.bin")!.data;
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
        expect([...drive.files.values()].find((file) => file.name === "chunked.bin")!.data).toEqual(source);
    });

    it("supports an empty PutObject", async () => {
        const response = await worker.fetch(await signed("/test-bucket/empty", { method: "PUT", body: new Uint8Array() }), ENV, CTX);
        expect(response.status).toBe(200);
        expect([...drive.files.values()].find((file) => file.name === "empty")!.data.byteLength).toBe(0);
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
