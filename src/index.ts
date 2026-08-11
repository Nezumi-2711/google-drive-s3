import { verifySignature } from "./aws-signature";
import { isAllowedBucket, isPublicReadBucket } from "./bucket-access";
import { getAccessToken } from "./google-drive";
import { MultipartUploadDO } from "./multipart-do";
import { dispatch } from "./router";
import { S3Exception, s3Error } from "./s3-errors";
import type { Env } from "./types";

export { MultipartUploadDO };

export default {
    async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
        if (request.method === "OPTIONS") return new Response(null, { status: 204 });

        const url = new URL(request.url);
        const pathParts = url.pathname.split("/").filter(Boolean);
        const bucket = pathParts[0] || "";
        const objectKey = pathParts.slice(1).join("/");
        const resource = url.pathname || "/";

        try {
            if (!isAllowedBucket(bucket, env)) return s3Error("AccessDenied", 403, undefined, resource, request.method === "HEAD");

            const isPublicRead = isPublicReadBucket(bucket, env) && (request.method === "GET" || request.method === "HEAD");
            if (!isPublicRead && !(await verifySignature(request, env))) {
                return s3Error("SignatureDoesNotMatch", 403, undefined, resource, request.method === "HEAD");
            }

            return await dispatch(request, env, await getAccessToken(env), bucket, objectKey);
        } catch (error) {
            if (error instanceof S3Exception) return s3Error(error.code, error.status, error.message, resource, request.method === "HEAD", error.headers);
            console.error(JSON.stringify({ message: "request failed", error: error instanceof Error ? error.message : String(error), method: request.method, path: url.pathname }));
            return s3Error("InternalError", 500, undefined, resource, request.method === "HEAD");
        }
    },
} satisfies ExportedHandler<Env>;
