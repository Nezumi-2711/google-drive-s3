import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
    plugins: [
        cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: {
                bindings: {
                    ACCESS_KEY: "test-access-key",
                    SECRET_KEY: "test-secret-key",
                    REGION: "auto",
                    GOOGLE_CLIENT_ID: "test-client-id",
                    GOOGLE_CLIENT_SECRET: "test-client-secret",
                    GOOGLE_REFRESH_TOKEN: "test-refresh-token",
                    ALLOWED_BUCKETS: "test-bucket,empty-bucket,my-bucket",
                    ALLOW_MULTIPART: "true",
                    ETAG_STYLE: "md5",
                    CORS_ALLOWED_ORIGINS: "http://localhost:5173",
                    ENABLE_DOCS: "true",
                },
            },
        }),
    ],
    test: {
        exclude: [...configDefaults.exclude, ".pnpm-wrangler/**", ".pnpm-store/**", "node_modules/**"],
    },
});
