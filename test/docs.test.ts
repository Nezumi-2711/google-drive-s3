import { describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import type { Env } from "../src/types";

import { env } from "cloudflare:test";

const ENV = env as unknown as Env;
const ENDPOINT = "https://s3-api.example.com";
const CTX = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;

describe("API documentation routes", () => {
    it("serves the Scalar shell and raw OpenAPI document", async () => {
        const docs = await worker.fetch(new Request(`${ENDPOINT}/docs`), ENV, CTX);
        expect(docs.status).toBe(200);
        expect(docs.headers.get("Content-Type")).toContain("text/html");
        expect(await docs.text()).toContain("@scalar/api-reference");

        const spec = await worker.fetch(new Request(`${ENDPOINT}/openapi.yaml`), ENV, CTX);
        expect(spec.status).toBe(200);
        expect(spec.headers.get("Content-Type")).toContain("application/yaml");
        expect(new TextDecoder().decode(await spec.arrayBuffer())).toContain("openapi: 3.1.0");
    });

    it("bypasses documentation routes when disabled", async () => {
        const disabled = { ...ENV, ENABLE_DOCS: "false" };
        const fakeFetch = vi.fn(async (input: RequestInfo | URL) => {
            const url = new URL(typeof input === "string" ? input : input instanceof Request ? input.url : input.toString());
            if (url.origin === "https://oauth2.googleapis.com") return Response.json({ access_token: "token", expires_in: 3600 });
            const q = url.searchParams.get("q") ?? "";
            if (q.includes("name='s3-storage'") && q.includes("'root' in parents")) {
                return Response.json({ files: [{ id: "root-folder-id", name: "s3-storage" }] });
            }
            return Response.json({ files: [] });
        });
        vi.stubGlobal("fetch", fakeFetch);
        try {
            for (const path of ["/docs", "/openapi.yaml"]) {
                const response = await worker.fetch(new Request(`${ENDPOINT}${path}`), disabled, CTX);
                expect(response.status).toBe(403);
            }
        } finally {
            vi.unstubAllGlobals();
        }
    });
});
