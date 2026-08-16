interface PresignResponse {
    url: string;
    method: string;
    headers?: Record<string, string>;
    body?: string;
}

async function presign(body: Record<string, unknown>): Promise<PresignResponse> {
    const response = await fetch("/presign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json<PresignResponse>();
}

function uploadIdFromXml(xml: string): string {
    const value = /<UploadId>([^<]+)<\/UploadId>/.exec(xml)?.[1];
    if (!value) throw new Error("CreateMultipartUpload did not return UploadId");
    return value;
}

/** Uploads parts in order. The Worker does not allow parallel or out-of-order part uploads. */
export async function uploadLargeFile(file: File, key: string, partSize = 16 * 1024 * 1024): Promise<void> {
    const contentType = file.type || "application/octet-stream";
    const create = await presign({ key, contentType, operation: "createMultipart" });
    const createResponse = await fetch(create.url, { method: create.method, headers: create.headers });
    if (!createResponse.ok) throw new Error(await createResponse.text());
    const uploadId = uploadIdFromXml(await createResponse.text());

    const parts: Array<{ ETag: string; PartNumber: number }> = [];
    for (let index = 0, offset = 0; offset < file.size; index++, offset += partSize) {
        const partNumber = index + 1;
        const body = file.slice(offset, Math.min(offset + partSize, file.size));
        const signed = await presign({ key, uploadId, partNumber, operation: "uploadPart" });
        const response = await fetch(signed.url, { method: signed.method, body });
        if (!response.ok) throw new Error(`Part ${partNumber} failed: ${await response.text()}`);
        const etag = response.headers.get("ETag");
        if (!etag) throw new Error(`Part ${partNumber} did not return ETag; check CORS_ALLOWED_ORIGINS`);
        parts.push({ ETag: etag, PartNumber: partNumber });
    }

    const complete = await presign({ key, uploadId, parts, operation: "completeMultipart" });
    if (!complete.body) throw new Error("BFF did not return the completion XML body");
    const completeResponse = await fetch(complete.url, { method: complete.method, headers: complete.headers, body: complete.body });
    if (!completeResponse.ok) throw new Error(await completeResponse.text());
}
