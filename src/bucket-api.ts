import { jsonResponse } from "./auth-api";
import { createBucket, deleteBucket, importBuckets, listImportCandidates, updateBucket } from "./bucket-registry";
import type { Env } from "./types";

interface CreateBucketBody {
    name?: string;
    publicRead?: boolean;
}

interface UpdateBucketBody {
    publicRead?: boolean;
    name?: string;
}

interface ImportBucketsBody {
    names?: string[];
}

export async function handleBucketRoutes(request: Request, env: Env, subSegments: string[]): Promise<Response> {
    const method = request.method;
    const bucketName = subSegments[0];

    // POST /api/buckets
    if (method === "POST" && !bucketName) {
        let body: CreateBucketBody;
        try {
            body = (await request.json()) as CreateBucketBody;
        } catch {
            return jsonResponse({ message: "Invalid JSON body" }, 400);
        }

        if (!body.name) {
            return jsonResponse({ message: "Bucket name is required" }, 400);
        }

        try {
            const record = await createBucket(env, body.name, Boolean(body.publicRead));
            return jsonResponse(record, 201);
        } catch (err: unknown) {
            const status = (err as { status?: number }).status || 500;
            const message = err instanceof Error ? err.message : String(err);
            return jsonResponse({ message }, status);
        }
    }

    // PATCH /api/buckets/:name
    if (method === "PATCH" && bucketName) {
        let body: UpdateBucketBody;
        try {
            body = (await request.json()) as UpdateBucketBody;
        } catch {
            return jsonResponse({ message: "Invalid JSON body" }, 400);
        }

        try {
            const record = await updateBucket(env, bucketName, body);
            return jsonResponse(record, 200);
        } catch (err: unknown) {
            const status = (err as { status?: number }).status || 500;
            const message = err instanceof Error ? err.message : String(err);
            return jsonResponse({ message }, status);
        }
    }

    // DELETE /api/buckets/:name
    if (method === "DELETE" && bucketName) {
        try {
            await deleteBucket(env, bucketName);
            return new Response(null, { status: 204 });
        } catch (err: unknown) {
            const status = (err as { status?: number }).status || 500;
            const message = err instanceof Error ? err.message : String(err);
            return jsonResponse({ message }, status);
        }
    }

    return jsonResponse({ message: "Method Not Allowed" }, 405);
}

export async function handleImportCandidatesRoute(request: Request, env: Env): Promise<Response> {
    if (request.method !== "GET") {
        return jsonResponse({ message: "Method Not Allowed" }, 405);
    }
    try {
        const candidates = await listImportCandidates(env);
        return jsonResponse({ candidates }, 200);
    } catch (err: unknown) {
        const status = (err as { status?: number }).status || 500;
        const message = err instanceof Error ? err.message : String(err);
        return jsonResponse({ message }, status);
    }
}

export async function handleImportRoute(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
        return jsonResponse({ message: "Method Not Allowed" }, 405);
    }
    let body: ImportBucketsBody;
    try {
        body = (await request.json()) as ImportBucketsBody;
    } catch {
        return jsonResponse({ message: "Invalid JSON body" }, 400);
    }

    if (!Array.isArray(body.names)) {
        return jsonResponse({ message: "'names' array is required" }, 400);
    }

    try {
        const result = await importBuckets(env, body.names);
        return jsonResponse(result, 200);
    } catch (err: unknown) {
        const status = (err as { status?: number }).status || 500;
        const message = err instanceof Error ? err.message : String(err);
        return jsonResponse({ message }, status);
    }
}
