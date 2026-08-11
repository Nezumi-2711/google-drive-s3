const MAX_CONTROL_LINE = 128;

type DecoderState = "HEADER" | "DATA" | "CRLF" | "TRAILER" | "DONE";

function asBytes(value: Uint8Array | ArrayBuffer): Uint8Array {
    return value instanceof Uint8Array ? value : new Uint8Array(value);
}

/** Iterates decoded payload views without scanning or copying payload bytes. */
export async function* decodedBodyChunks(stream: ReadableStream<Uint8Array> | null, awsChunked: boolean): AsyncGenerator<Uint8Array> {
    if (!stream) return;
    const reader = stream.getReader();
    if (!awsChunked) {
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) return;
                if (value.byteLength > 0) yield asBytes(value);
            }
        } finally {
            reader.releaseLock();
        }
    }

    let state: DecoderState = "HEADER";
    let remaining = 0;
    let control: number[] = [];
    let emitted = 0;

    const consumeControlByte = (byte: number): string | null => {
        control.push(byte);
        if (control.length > MAX_CONTROL_LINE) throw new Error("Invalid aws-chunked control line");
        const length = control.length;
        if (length < 2 || control[length - 2] !== 13 || control[length - 1] !== 10) return null;
        const line = new TextDecoder().decode(new Uint8Array(control.slice(0, -2)));
        control = [];
        return line;
    };

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = asBytes(value);
            let offset = 0;
            while (offset < chunk.byteLength) {
                if (state === "DATA") {
                    const length = Math.min(remaining, chunk.byteLength - offset);
                    if (length > 0) {
                        emitted += length;
                        remaining -= length;
                        yield chunk.subarray(offset, offset + length);
                        offset += length;
                    }
                    if (remaining === 0) state = "CRLF";
                    continue;
                }

                const line = consumeControlByte(chunk[offset++]);
                if (line === null) continue;

                if (state === "HEADER") {
                    const sizeText = line.split(";", 1)[0];
                    if (!/^[0-9a-fA-F]+$/.test(sizeText)) throw new Error("Invalid aws-chunked chunk size");
                    remaining = Number.parseInt(sizeText, 16);
                    if (!Number.isSafeInteger(remaining)) throw new Error("aws-chunked chunk is too large");
                    state = remaining === 0 ? "TRAILER" : "DATA";
                } else if (state === "CRLF") {
                    if (line !== "") throw new Error("Invalid aws-chunked data terminator");
                    state = "HEADER";
                } else if (state === "TRAILER" && line === "") {
                    state = "DONE";
                    if (offset !== chunk.byteLength) throw new Error("Unexpected bytes after aws-chunked trailer");
                } else if (state === "DONE") {
                    throw new Error("Unexpected bytes after aws-chunked trailer");
                }
            }
        }
    } finally {
        reader.releaseLock();
    }

    if (state !== "DONE") throw new Error("Truncated aws-chunked body");
    return emitted;
}

export async function pumpBody(
    stream: ReadableStream<Uint8Array> | null,
    writer: WritableStreamDefaultWriter<ArrayBuffer | ArrayBufferView>,
    options: { awsChunked: boolean; expectedLength?: number; skipBytes?: number; maxBytes?: number; prefix?: Uint8Array } = { awsChunked: false },
): Promise<{ written: number; tail: Uint8Array }> {
    let decoded = 0;
    let written = 0;
    let skip = options.skipBytes ?? 0;
    const tailParts: Uint8Array[] = [];
    let tailLength = 0;

    const consume = async (input: Uint8Array): Promise<void> => {
        let chunk = input;
        if (skip >= chunk.byteLength) {
            skip -= chunk.byteLength;
            return;
        }
        if (skip > 0) {
            chunk = chunk.subarray(skip);
            skip = 0;
        }
        const remaining = options.maxBytes === undefined ? chunk.byteLength : Math.max(0, options.maxBytes - written);
        const send = chunk.subarray(0, remaining);
        if (send.byteLength > 0) {
            await writer.write(send);
            written += send.byteLength;
        }
        if (send.byteLength < chunk.byteLength) {
            const tail = chunk.subarray(send.byteLength);
            tailParts.push(tail);
            tailLength += tail.byteLength;
        }
    };

    try {
        if (options.prefix) await consume(options.prefix);
        for await (const chunk of decodedBodyChunks(stream, options.awsChunked)) {
            decoded += chunk.byteLength;
            await consume(chunk);
        }
        if (skip !== 0) throw new Error("Body is shorter than the committed Drive range");
        if (options.expectedLength !== undefined && decoded !== options.expectedLength) throw new Error(`Decoded body length ${decoded} does not match x-amz-decoded-content-length ${options.expectedLength}`);
        await writer.close();
    } catch (error) {
        await writer.abort(error).catch(() => undefined);
        throw error;
    }

    const tail = new Uint8Array(tailLength);
    let offset = 0;
    for (const part of tailParts) {
        tail.set(part, offset);
        offset += part.byteLength;
    }
    return { written, tail };
}

export function isAwsChunked(request: Request): boolean {
    return (
        request.headers
            .get("content-encoding")
            ?.split(",")
            .some((encoding) => encoding.trim().toLowerCase() === "aws-chunked") ?? false
    );
}

export function decodedContentLength(request: Request): number | undefined {
    const value = request.headers.get("x-amz-decoded-content-length") ?? request.headers.get("content-length");
    if (value === null || !/^\d+$/.test(value)) return undefined;
    const length = Number(value);
    return Number.isSafeInteger(length) ? length : undefined;
}
