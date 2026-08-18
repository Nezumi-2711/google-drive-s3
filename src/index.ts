import { AUTH_PATH_PREFIX, handleAuth } from "./auth-api";
import { verifySignature } from "./aws-signature";
import { isAllowedBucket, isPublicReadBucket } from "./bucket-access";
import { preflightResponse, withCors } from "./cors";
import * as docs from "./docs";
import { getAccessToken } from "./google-drive";
import { MultipartUploadDO } from "./multipart-do";
import { dispatch } from "./router";
import { S3Exception, s3Error } from "./s3-errors";
import type { Env } from "./types";

export { MultipartUploadDO };

export default {
    async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
        if (request.method === "OPTIONS") return preflightResponse(request, env);

        const url = new URL(request.url);
        if (env.ENABLE_DOCS !== "false") {
            if (request.method === "GET" && url.pathname === docs.OPENAPI_PATH) return withCors(docs.openApiResponse(), request, env);
            if (request.method === "GET" && url.pathname === docs.DOCS_PATH && !isAllowedBucket("docs", env)) return withCors(docs.docsResponse(), request, env);
        }

        const pathParts = url.pathname.split("/").filter(Boolean);
        if (pathParts[0] === AUTH_PATH_PREFIX && !isAllowedBucket(AUTH_PATH_PREFIX, env)) {
            return withCors(await handleAuth(request, env, pathParts.slice(1).join("/")), request, env);
        }

        const bucket = pathParts[0] || "";
        const objectKey = pathParts.slice(1).join("/");
        const resource = url.pathname || "/";

        try {
            if (!isAllowedBucket(bucket, env)) return withCors(s3Error("AccessDenied", 403, undefined, resource, request.method === "HEAD"), request, env);

            const isPublicRead = isPublicReadBucket(bucket, env) && (request.method === "GET" || request.method === "HEAD");
            const signature = isPublicRead ? { ok: true as const } : await verifySignature(request, env);
            if (!signature.ok) {
                return withCors(s3Error(signature.code, 403, signature.message, resource, request.method === "HEAD"), request, env);
            }

            return withCors(await dispatch(request, env, await getAccessToken(env), bucket, objectKey), request, env);
        } catch (error) {
            if (error instanceof S3Exception) return withCors(s3Error(error.code, error.status, error.message, resource, request.method === "HEAD", error.headers), request, env);
            console.error(JSON.stringify({ message: "request failed", error: error instanceof Error ? error.message : String(error), method: request.method, path: url.pathname }));
            return withCors(s3Error("InternalError", 500, undefined, resource, request.method === "HEAD"), request, env);
        }
    },
} satisfies ExportedHandler<Env>;
