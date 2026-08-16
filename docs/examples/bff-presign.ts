import { AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, PutObjectCommand, S3Client, UploadPartCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

interface Env {
    S3_ENDPOINT: string;
    S3_ACCESS_KEY: string;
    S3_SECRET_KEY: string;
    S3_REGION: string;
    S3_BUCKET: string;
}

interface PresignRequest {
    key: string;
    contentType?: string;
    operation?: "put" | "createMultipart" | "uploadPart" | "completeMultipart" | "abortMultipart";
    uploadId?: string;
    partNumber?: number;
    parts?: Array<{ ETag: string; PartNumber: number }>;
}

function escapeXml(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function completionXml(parts: Array<{ ETag: string; PartNumber: number }> | undefined): string | null {
    if (!parts?.length || parts.some((part, index) => !Number.isInteger(part.PartNumber) || part.PartNumber !== index + 1 || typeof part.ETag !== "string" || part.ETag.length === 0)) return null;
    return `<CompleteMultipartUpload>${parts.map((part) => `<Part><PartNumber>${part.PartNumber}</PartNumber><ETag>${escapeXml(part.ETag)}</ETag></Part>`).join("")}</CompleteMultipartUpload>`;
}

function json(data: unknown, status = 200): Response {
    return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function s3(env: Env): S3Client {
    return new S3Client({
        endpoint: env.S3_ENDPOINT,
        region: env.S3_REGION,
        forcePathStyle: true,
        credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
    });
}

function validKey(key: unknown): key is string {
    return typeof key === "string" && key.length > 0 && key.length <= 1024 && !key.startsWith("/") && !key.split("/").includes("..");
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        if (request.method !== "POST" || new URL(request.url).pathname !== "/presign") return new Response("Not found", { status: 404 });

        let input: PresignRequest;
        try {
            input = await request.json<PresignRequest>();
        } catch {
            return json({ error: "Expected JSON body" }, 400);
        }
        if (!validKey(input.key)) return json({ error: "Invalid object key" }, 400);

        const client = s3(env);
        const operation = input.operation ?? "put";
        const expiresIn = 5 * 60;

        if (operation === "put") {
            const contentType = input.contentType || "application/octet-stream";
            const url = await getSignedUrl(client, new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: input.key, ContentType: contentType }), { expiresIn });
            return json({ url, method: "PUT", headers: { "Content-Type": contentType }, expiresIn });
        }

        if (operation === "createMultipart") {
            const contentType = input.contentType || "application/octet-stream";
            const url = await getSignedUrl(client, new CreateMultipartUploadCommand({ Bucket: env.S3_BUCKET, Key: input.key, ContentType: contentType }), { expiresIn });
            return json({ url, method: "POST", headers: { "Content-Type": contentType }, expiresIn });
        }

        if (!input.uploadId) return json({ error: "uploadId is required" }, 400);
        if (operation === "uploadPart") {
            const partNumber = input.partNumber;
            if (!Number.isInteger(partNumber) || partNumber === undefined || partNumber < 1 || partNumber > 10_000) return json({ error: "partNumber must be 1 through 10000" }, 400);
            const url = await getSignedUrl(client, new UploadPartCommand({ Bucket: env.S3_BUCKET, Key: input.key, UploadId: input.uploadId, PartNumber: partNumber }), { expiresIn });
            return json({ url, method: "PUT", expiresIn });
        }
        if (operation === "completeMultipart") {
            const body = completionXml(input.parts);
            if (!body) return json({ error: "parts must have sequential PartNumber values beginning at 1 and non-empty ETag values" }, 400);
            const url = await getSignedUrl(client, new CompleteMultipartUploadCommand({ Bucket: env.S3_BUCKET, Key: input.key, UploadId: input.uploadId, MultipartUpload: { Parts: input.parts } }), { expiresIn });
            return json({ url, method: "POST", headers: { "Content-Type": "application/xml" }, body, expiresIn });
        }
        if (operation === "abortMultipart") {
            const url = await getSignedUrl(client, new AbortMultipartUploadCommand({ Bucket: env.S3_BUCKET, Key: input.key, UploadId: input.uploadId }), { expiresIn });
            return json({ url, method: "DELETE", expiresIn });
        }

        return json({ error: "Unsupported operation" }, 400);
    },
} satisfies ExportedHandler<Env>;
