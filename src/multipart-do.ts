import { alignedSendLen, cancelSession, createEmptyFile, putFinalChunk, queryStatus } from "./drive-resumable";
import { getAccessToken } from "./google-drive";
import type { DriveUploadResult, Env } from "./types";

import { DurableObject } from "cloudflare:workers";

const WAIT_TIMEOUT_MS = 20_000;
const LEASE_MS = 120_000;
const EXPIRE_AFTER_MS = 24 * 60 * 60 * 1000;

interface PartRow extends Record<string, SqlStorageValue> {
    partNumber: number;
    size: number;
    etag: string;
    endOffset: number;
    ts: number;
}

interface InFlight {
    requestId: string;
    partNumber: number;
    driveOffsetAtStart: number;
    carryLen: number;
    partLen: number;
    sendLen: number;
    leaseExpiresAt: number;
}

export type BeginPartResult = { kind: "admit"; uploadUrl: string; driveOffset: number; carry: Uint8Array; sendLen: number; skipBytes: number } | { kind: "committed"; etag: string } | { kind: "slowdown" } | { kind: "error"; code: "NoSuchUpload" | "InvalidPart" | "InternalError"; message: string };

export type CompleteResult = { kind: "complete"; metadata: DriveUploadResult; partEtags: string[] } | { kind: "error"; code: "NoSuchUpload" | "InvalidPart" | "InvalidPartOrder" | "InternalError"; message: string };

interface Waiter {
    requestId: string;
    partNumber: number;
    partLen: number;
    resolve: (result: BeginPartResult) => void;
    timer: ReturnType<typeof setTimeout>;
}

interface StateValueRow extends Record<string, SqlStorageValue> {
    v: ArrayBuffer | string | number | null;
}

export class MultipartUploadDO extends DurableObject<Env> {
    private readonly waiters = new Map<string, Waiter>();

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);
        void ctx.blockConcurrencyWhile(async () => {
            this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS state (k TEXT PRIMARY KEY, v)");
            this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS parts (partNumber INTEGER PRIMARY KEY, size INTEGER NOT NULL, etag TEXT NOT NULL, endOffset INTEGER NOT NULL, ts INTEGER NOT NULL)");
        });
    }

    private getValue<T extends ArrayBuffer | string | number>(key: string): T | undefined {
        return this.ctx.storage.sql.exec<StateValueRow>("SELECT v FROM state WHERE k = ?", key).toArray()[0]?.v as T | undefined;
    }

    private requiredValue<T extends ArrayBuffer | string | number>(key: string): T {
        const value = this.getValue<T>(key);
        if (value === undefined) throw new Error(`Missing multipart upload state: ${key}`);
        return value;
    }

    private setValue(key: string, value: ArrayBuffer | string | number | null): void {
        this.ctx.storage.sql.exec("INSERT INTO state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", key, value);
    }

    private hasUpload(): boolean {
        return this.getValue<string>("uploadUrl") !== undefined;
    }

    private carry(): Uint8Array {
        const value = this.getValue<ArrayBuffer>("carry");
        return value ? new Uint8Array(value) : new Uint8Array();
    }

    private inFlight(): InFlight | null {
        const value = this.getValue<string>("inFlight");
        return value ? (JSON.parse(value) as InFlight) : null;
    }

    private part(partNumber: number): PartRow | undefined {
        return this.ctx.storage.sql.exec<PartRow>("SELECT partNumber, size, etag, endOffset, ts FROM parts WHERE partNumber = ?", partNumber).toArray()[0];
    }

    async init(input: { uploadUrl: string; bucket: string; key: string; mimeType: string; parentFolderId: string; fileName: string; existingFileId?: string }): Promise<boolean> {
        if (this.hasUpload()) return false;
        this.ctx.storage.sql.exec("DELETE FROM parts");
        for (const [key, value] of Object.entries(input)) {
            if (value !== undefined) this.setValue(key, value);
        }
        this.setValue("driveOffset", 0);
        this.setValue("carry", new ArrayBuffer(0));
        this.setValue("nextExpectedPart", 1);
        this.setValue("createdAt", Date.now());
        this.setValue("inFlight", null);
        await this.ctx.storage.setAlarm(Date.now() + EXPIRE_AFTER_MS);
        return true;
    }

    private async resyncExpiredLease(inFlight: InFlight, requestId: string, partLen: number): Promise<BeginPartResult | null> {
        if (partLen !== inFlight.partLen) return { kind: "error", code: "InvalidPart", message: "A retried part must have the same decoded length" };
        const accessToken = await getAccessToken(this.env);
        const actualOffset = await queryStatus(this.requiredValue<string>("uploadUrl"), accessToken);
        const partStartFileOffset = inFlight.driveOffsetAtStart + inFlight.carryLen;
        let skipBytes = 0;
        if (actualOffset === inFlight.driveOffsetAtStart) {
            // The persisted carry remains valid.
        } else if (actualOffset >= partStartFileOffset) {
            skipBytes = actualOffset - partStartFileOffset;
            if (skipBytes > inFlight.partLen) return { kind: "error", code: "InternalError", message: "Drive committed beyond the leased part" };
            this.setValue("driveOffset", actualOffset);
            this.setValue("carry", new ArrayBuffer(0));
        } else {
            return { kind: "error", code: "InternalError", message: "Drive committed only a prefix of the multipart carry" };
        }
        this.setValue("inFlight", null);
        return this.admit(requestId, inFlight.partNumber, inFlight.partLen, skipBytes);
    }

    private admit(requestId: string, partNumber: number, partLen: number, skipBytes = 0): BeginPartResult {
        const carry = this.carry();
        const driveOffset = this.getValue<number>("driveOffset") ?? 0;
        const available = carry.byteLength + partLen - skipBytes;
        const sendLen = alignedSendLen(driveOffset, available);
        const inFlight: InFlight = {
            requestId,
            partNumber,
            driveOffsetAtStart: driveOffset,
            carryLen: carry.byteLength,
            partLen,
            sendLen,
            leaseExpiresAt: Date.now() + LEASE_MS,
        };
        this.setValue("inFlight", JSON.stringify(inFlight));
        return { kind: "admit", uploadUrl: this.requiredValue<string>("uploadUrl"), driveOffset, carry, sendLen, skipBytes };
    }

    async beginPart(requestId: string, partNumber: number, partLen: number): Promise<BeginPartResult> {
        if (!this.hasUpload()) return { kind: "error", code: "NoSuchUpload", message: "Multipart upload not found" };
        if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000 || !Number.isSafeInteger(partLen) || partLen < 0) {
            return { kind: "error", code: "InvalidPart", message: "Invalid part number or length" };
        }
        const committed = this.part(partNumber);
        if (committed) return { kind: "committed", etag: committed.etag };

        const nextExpected = this.getValue<number>("nextExpectedPart") ?? 1;
        if (partNumber < nextExpected) return { kind: "error", code: "InvalidPart", message: "Part is no longer available" };
        if (partNumber > nextExpected + 64) return { kind: "slowdown" };

        const lease = this.inFlight();
        if (partNumber === nextExpected && (!lease || lease.leaseExpiresAt <= Date.now())) {
            if (lease) {
                try {
                    const result = await this.resyncExpiredLease(lease, requestId, partLen);
                    if (result) return result;
                } catch (error) {
                    return { kind: "error", code: "InternalError", message: error instanceof Error ? error.message : String(error) };
                }
            }
            return this.admit(requestId, partNumber, partLen);
        }

        return await new Promise<BeginPartResult>((resolve) => {
            const timer = setTimeout(() => {
                this.waiters.delete(requestId);
                resolve({ kind: "slowdown" });
            }, WAIT_TIMEOUT_MS);
            this.waiters.set(requestId, { requestId, partNumber, partLen, resolve, timer });
        });
    }

    async cancelWaiter(requestId: string): Promise<void> {
        const waiter = this.waiters.get(requestId);
        if (!waiter) return;
        clearTimeout(waiter.timer);
        this.waiters.delete(requestId);
        waiter.resolve({ kind: "slowdown" });
    }

    async failPart(partNumber: number): Promise<void> {
        const lease = this.inFlight();
        if (!lease || lease.partNumber !== partNumber) return;
        lease.leaseExpiresAt = 0;
        this.setValue("inFlight", JSON.stringify(lease));
        await this.wakeWaiters();
    }

    async endPart(partNumber: number, newDriveOffset: number, tail: Uint8Array, etag: string, partLen: number): Promise<boolean> {
        const lease = this.inFlight();
        if (!lease || lease.partNumber !== partNumber) return false;
        if (newDriveOffset !== lease.driveOffsetAtStart + lease.sendLen || tail.byteLength > 256 * 1024) return false;
        const tailBuffer = new Uint8Array(tail).buffer;
        this.ctx.storage.transactionSync(() => {
            this.setValue("driveOffset", newDriveOffset);
            this.setValue("carry", tailBuffer);
            this.setValue("nextExpectedPart", partNumber + 1);
            this.setValue("inFlight", null);
            this.ctx.storage.sql.exec("INSERT INTO parts (partNumber, size, etag, endOffset, ts) VALUES (?, ?, ?, ?, ?)", partNumber, partLen, etag, newDriveOffset + tail.byteLength, Date.now());
        });
        await this.wakeWaiters();
        return true;
    }

    private async wakeWaiters(): Promise<void> {
        const nextExpected = this.getValue<number>("nextExpectedPart") ?? 1;
        if (this.inFlight()) return;
        const waiter = [...this.waiters.values()].find((candidate) => candidate.partNumber === nextExpected);
        if (!waiter) return;
        clearTimeout(waiter.timer);
        this.waiters.delete(waiter.requestId);
        waiter.resolve(this.admit(waiter.requestId, waiter.partNumber, waiter.partLen));
    }

    async complete(clientParts: Array<{ partNumber: number; etag: string }>, expectedTotal?: number): Promise<CompleteResult> {
        if (!this.hasUpload()) return { kind: "error", code: "NoSuchUpload", message: "Multipart upload not found" };
        if (this.inFlight()) return { kind: "error", code: "InvalidPart", message: "A part is still being uploaded" };
        const stored = this.ctx.storage.sql.exec<PartRow>("SELECT partNumber, size, etag, endOffset, ts FROM parts ORDER BY partNumber").toArray();
        if (clientParts.length !== stored.length) return { kind: "error", code: "InvalidPart", message: "The completed part list does not match uploaded parts" };
        for (let index = 0; index < clientParts.length; index++) {
            const client = clientParts[index];
            const part = stored[index];
            if (client.partNumber !== index + 1) return { kind: "error", code: "InvalidPartOrder", message: "Parts must be consecutive starting at 1" };
            if (part.partNumber !== client.partNumber || part.etag !== client.etag) return { kind: "error", code: "InvalidPart", message: `Part ${client.partNumber} does not match` };
        }

        const driveOffset = this.getValue<number>("driveOffset") ?? 0;
        const carry = this.carry();
        const total = driveOffset + carry.byteLength;
        if (expectedTotal !== undefined && expectedTotal !== total) return { kind: "error", code: "InvalidPart", message: "x-amz-mp-object-size does not match uploaded parts" };

        try {
            const accessToken = await getAccessToken(this.env);
            let metadata: DriveUploadResult;
            if (total === 0) {
                await cancelSession(this.requiredValue<string>("uploadUrl"), accessToken);
                metadata = await createEmptyFile(accessToken, {
                    name: this.requiredValue<string>("fileName"),
                    parents: [this.requiredValue<string>("parentFolderId")],
                    mimeType: this.requiredValue<string>("mimeType"),
                    existingFileId: this.getValue<string>("existingFileId"),
                });
            } else {
                metadata = await putFinalChunk(this.requiredValue<string>("uploadUrl"), accessToken, driveOffset, total, carry);
            }
            const partEtags = stored.map((part) => part.etag);
            await this.ctx.storage.deleteAlarm();
            await this.ctx.storage.deleteAll();
            return { kind: "complete", metadata, partEtags };
        } catch (error) {
            return { kind: "error", code: "InternalError", message: error instanceof Error ? error.message : String(error) };
        }
    }

    async listParts(marker: number, maxParts: number): Promise<{ parts: PartRow[]; nextMarker: number; truncated: boolean } | null> {
        if (!this.hasUpload()) return null;
        const rows = this.ctx.storage.sql.exec<PartRow>("SELECT partNumber, size, etag, endOffset, ts FROM parts WHERE partNumber > ? ORDER BY partNumber LIMIT ?", marker, maxParts + 1).toArray();
        const truncated = rows.length > maxParts;
        const parts = rows.slice(0, maxParts);
        return { parts, nextMarker: parts.at(-1)?.partNumber ?? marker, truncated };
    }

    async abort(): Promise<boolean> {
        if (!this.hasUpload()) return false;
        const accessToken = await getAccessToken(this.env);
        await cancelSession(this.requiredValue<string>("uploadUrl"), accessToken);
        await this.ctx.storage.deleteAlarm();
        await this.ctx.storage.deleteAll();
        for (const waiter of this.waiters.values()) {
            clearTimeout(waiter.timer);
            waiter.resolve({ kind: "error", code: "NoSuchUpload", message: "Multipart upload was aborted" });
        }
        this.waiters.clear();
        return true;
    }

    async alarm(): Promise<void> {
        if (!this.hasUpload()) return;
        try {
            await this.abort();
        } catch (error) {
            console.error(JSON.stringify({ message: "multipart cleanup failed", error: error instanceof Error ? error.message : String(error) }));
            await this.ctx.storage.setAlarm(Date.now() + 60 * 60 * 1000);
        }
    }
}
