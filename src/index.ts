import { AUTH_PATH_PREFIX, handleAuth } from "./auth-api";
import { verifySignature } from "./aws-signature";
import { findBucketRecord } from "./bucket-registry";
import { preflightResponse, withCors } from "./cors";
import * as docs from "./docs";
import { getAccessToken } from "./google-drive";
import { MultipartUploadDO } from "./multipart-do";
import { dispatch } from "./router";
import { S3Exception, s3Error } from "./s3-errors";
import { API_PATH_PREFIX, handleApi } from "./status-api";
import type { Env } from "./types";

export { MultipartUploadDO };

export default {
    async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
        const startedAt = Date.now();
        if (request.method === "OPTIONS") return preflightResponse(request, env);

        const url = new URL(request.url);
        if (env.ENABLE_DOCS !== "false") {
            if (request.method === "GET" && url.pathname === docs.OPENAPI_PATH) return withCors(docs.openApiResponse(), request, env);
            if (request.method === "GET" && url.pathname === docs.DOCS_PATH) return withCors(docs.docsResponse(), request, env);
        }

        const pathParts = url.pathname.split("/").filter(Boolean);
        if (pathParts[0] === AUTH_PATH_PREFIX) {
            return withCors(await handleAuth(request, env, pathParts.slice(1).join("/")), request, env);
        }
        if (pathParts[0] === API_PATH_PREFIX) {
            const subPath = pathParts.slice(1).join("/");
            const response = await handleApi(request, env, subPath);
            if (env.ENABLE_TIMING_LOGS === "true") {
                const route = ["objects", "objects/content", "objects/metadata", "buckets", "status"].includes(subPath) ? subPath : "other";
                console.info(JSON.stringify({ type: "api-timing", method: request.method, route, status: response.status, durationMs: Date.now() - startedAt }));
            }
            return withCors(response, request, env);
        }

        const bucket = pathParts[0] || "";
        const objectKey = pathParts.slice(1).join("/");
        const resource = url.pathname || "/";
        const stages: Partial<Record<"registry" | "auth" | "token" | "dispatch", number>> = {};
        const measure = async <Result>(stage: keyof typeof stages, action: () => Promise<Result>): Promise<Result> => {
            if (env.ENABLE_TIMING_LOGS !== "true") return action();
            const stageStartedAt = performance.now();
            try {
                return await action();
            } finally {
                stages[stage] = Number((performance.now() - stageStartedAt).toFixed(1));
            }
        };
        const respond = (response: Response): Response => {
            if (env.ENABLE_TIMING_LOGS === "true") {
                console.info(JSON.stringify({ type: "s3-timing", method: request.method, hasKey: Boolean(objectKey), hasRange: request.headers.has("Range"), status: response.status, durationMs: Date.now() - startedAt, stages, serverTiming: response.headers.get("Server-Timing") }));
            }
            return withCors(response, request, env);
        };

        try {
            const record = await measure("registry", () => findBucketRecord(env, bucket));
            if (!record) return respond(s3Error("AccessDenied", 403, undefined, resource, request.method === "HEAD"));

            const isPublicRead = record.publicRead && (request.method === "GET" || request.method === "HEAD");
            const signature = isPublicRead ? { ok: true as const } : await measure("auth", () => verifySignature(request, env));
            if (!signature.ok) {
                return respond(s3Error(signature.code, 403, signature.message, resource, request.method === "HEAD"));
            }

            const accessToken = await measure("token", () => getAccessToken(env));
            const response = await measure("dispatch", () => dispatch(request, env, accessToken, bucket, objectKey, record.folderId));
            return respond(response);
        } catch (error) {
            if (error instanceof S3Exception) return respond(s3Error(error.code, error.status, error.message, resource, request.method === "HEAD", error.headers));
            if (error instanceof Error && error.message === "Storage root folder is not configured") {
                return respond(s3Error("AccessDenied", 403, "Access Denied", resource, request.method === "HEAD"));
            }
            console.error(JSON.stringify({ message: "request failed", error: error instanceof Error ? error.message : String(error), method: request.method, path: url.pathname }));
            return respond(s3Error("InternalError", 500, undefined, resource, request.method === "HEAD"));
        }
    },
} satisfies ExportedHandler<Env>;
