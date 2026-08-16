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
        for (const path of ["/docs", "/openapi.yaml"]) {
            const response = await worker.fetch(new Request(`${ENDPOINT}${path}`), disabled, CTX);
            expect(response.status).toBe(403);
        }
    });

    it("does not claim /docs when docs is a configured bucket", async () => {
        const withDocsBucket = { ...ENV, ALLOWED_BUCKETS: "test-bucket,docs" };
        const response = await worker.fetch(new Request(`${ENDPOINT}/docs`), withDocsBucket, CTX);
        expect(response.status).toBe(403);
        expect(await response.text()).toContain("<Code>SignatureDoesNotMatch</Code>");
    });
});
