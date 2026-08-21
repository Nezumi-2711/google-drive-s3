import { expect } from "vitest";

export interface StoredFile {
    id: string;
    name: string;
    parent: string;
    mimeType: string;
    data: Uint8Array;
    md5Checksum: string;
    modifiedTime: string;
    trashed?: boolean;
}

export const FAKE_MODIFIED_TIME = "2026-08-16T08:00:00.000Z";

export interface StoredFolder {
    id: string;
    name: string;
    parent: string;
    trashed?: boolean;
}

export const FOLDER_MIME = "application/vnd.google-apps.folder";

export interface UploadSession {
    id: string;
    fileId?: string;
    name: string;
    parent: string;
    mimeType: string;
    committed: Uint8Array;
}

export class FakeDrive {
    readonly files = new Map<string, StoredFile>();
    readonly folders = new Map<string, StoredFolder>();
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
        if (url.pathname.startsWith("/drive/v3/files/") && request.method === "PATCH") {
            const fileId = url.pathname.split("/").at(-1);
            if (!fileId) return new Response("Not Found", { status: 404 });
            const body = await request.json<Record<string, unknown>>();
            return this.patchFile(fileId, body, url);
        }
        if (url.pathname.startsWith("/drive/v3/files/") && request.method === "DELETE") {
            const fileId = url.pathname.split("/").at(-1);
            if (!fileId) return new Response("Not Found", { status: 404 });
            this.files.delete(fileId);
            this.folders.delete(fileId);
            return new Response(null, { status: 204 });
        }
        if (url.pathname.startsWith("/upload/drive/v3/files") && url.searchParams.get("uploadType") === "resumable") return this.initialize(url, request);
        if (url.pathname.startsWith("/upload/session/")) return this.upload(url, request);
        return new Response("Not Found", { status: 404 });
    }

    private search(url: URL): Response {
        const q = url.searchParams.get("q") ?? "";
        const hasNameFilter = /name='/.test(q);
        const name = /name='((?:\\.|[^'])*)'/.exec(q)?.[1]?.replace(/\\'/g, "'").replace(/\\\\/g, "\\");
        const parent = /'([^']+)' in parents/.exec(q)?.[1] ?? "root";

        if (q.includes(FOLDER_MIME)) {
            const match = [...this.folders.values()].find((folder) => (!hasNameFilter || folder.name === name) && folder.parent === parent);
            return Response.json({ files: match ? [{ id: match.id, name: match.name, mimeType: FOLDER_MIME }] : [] });
        }

        const files = [...this.files.values()].filter((file) => (!hasNameFilter || file.name === name) && file.parent === parent);
        const folders = [...this.folders.values()].filter((folder) => (!hasNameFilter || folder.name === name) && folder.parent === parent);
        return Response.json({
            files: [...files.map((file) => ({ ...file, size: String(file.data.byteLength), data: undefined })), ...folders.map((folder) => ({ id: folder.id, name: folder.name, mimeType: FOLDER_MIME }))],
        });
    }

    private createMetadata(metadata: Record<string, unknown>): Response {
        const mimeType = String(metadata.mimeType ?? "application/octet-stream");
        const parent = String((metadata.parents as string[] | undefined)?.[0] ?? "root");
        if (mimeType === FOLDER_MIME) {
            const id = `folder-${this.nextId++}`;
            this.folders.set(id, { id, name: String(metadata.name), parent, trashed: false });
            return Response.json({ id, name: metadata.name, mimeType });
        }
        const id = `file-${this.nextId++}`;
        const file: StoredFile = {
            id,
            name: String(metadata.name),
            parent,
            mimeType,
            data: new Uint8Array(),
            md5Checksum: "d41d8cd98f00b204e9800998ecf8427e",
            modifiedTime: FAKE_MODIFIED_TIME,
            trashed: false,
        };
        this.files.set(id, file);
        return Response.json({ ...file, size: "0", data: undefined });
    }

    private patchFile(fileId: string, body: Record<string, unknown>, url: URL): Response {
        if (this.folders.has(fileId)) {
            const folder = this.folders.get(fileId)!;
            if (body.trashed !== undefined) folder.trashed = Boolean(body.trashed);
            if (body.name !== undefined) folder.name = String(body.name);
            return Response.json({ id: folder.id, name: folder.name, mimeType: FOLDER_MIME, trashed: folder.trashed });
        }
        if (this.files.has(fileId)) {
            const file = this.files.get(fileId)!;
            if (body.trashed !== undefined) file.trashed = Boolean(body.trashed);
            if (body.name !== undefined) file.name = String(body.name);
            return Response.json({ id: file.id, name: file.name, mimeType: file.mimeType, size: String(file.data.byteLength), trashed: file.trashed });
        }
        return new Response("Not Found", { status: 404 });
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
        const id = url.pathname.split("/").at(-1);
        if (!id) return new Response(null, { status: 404 });
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
        const file: StoredFile = { id, name: session.name, parent: session.parent, mimeType: session.mimeType, data, md5Checksum: fakeMd5(data), modifiedTime: FAKE_MODIFIED_TIME, trashed: false };
        this.files.set(id, file);
        this.sessions.delete(session.id);
        return Response.json({ ...file, size: String(data.byteLength), data: undefined });
    }

    private download(url: URL, request: Request): Response {
        const fileId = url.pathname.split("/").at(-1);
        if (!fileId) return new Response(null, { status: 404 });
        const file = this.files.get(fileId);
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

export function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
    const output = new Uint8Array(a.byteLength + b.byteLength);
    output.set(a);
    output.set(b, a.byteLength);
    return output;
}

export function fakeMd5(data: Uint8Array): string {
    let state = 0x811c9dc5;
    for (const byte of data) state = Math.imul(state ^ byte, 0x01000193);
    return (state >>> 0).toString(16).padStart(8, "0").repeat(4);
}

export function bytes(length: number, seed = 17): Uint8Array {
    const output = new Uint8Array(length);
    let state = seed;
    for (let index = 0; index < length; index++) {
        state = (Math.imul(state, 1664525) + 1013904223) | 0;
        output[index] = state >>> 24;
    }
    return output;
}
