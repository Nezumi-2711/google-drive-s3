import { describe, expect, it, vi } from "vitest";

import { sha256 } from "../src/aws-signature";
import worker from "../src/index";
import type { Env } from "../src/types";

import { env } from "cloudflare:test";

const ENV = env as unknown as Env;
const ENDPOINT = "https://s3-api.example.com";
const CTX = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;

describe("Dashboard authentication API routes", () => {
    it("returns 503 when DASHBOARD_PASSWORD is not configured", async () => {
        const withoutPassword = { ...ENV, DASHBOARD_PASSWORD: undefined };
        const res = await worker.fetch(
            new Request(`${ENDPOINT}/auth/login`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ passwordHash: "any" }),
            }),
            withoutPassword,
            CTX,
        );
        expect(res.status).toBe(503);
        const data = (await res.json()) as { message: string };
        expect(data.message).toBe("Dashboard authentication is not configured");
    });

    it("handles login with invalid body or missing passwordHash", async () => {
        const res1 = await worker.fetch(
            new Request(`${ENDPOINT}/auth/login`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: "not-json",
            }),
            ENV,
            CTX,
        );
        expect(res1.status).toBe(400);

        const res2 = await worker.fetch(
            new Request(`${ENDPOINT}/auth/login`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({}),
            }),
            ENV,
            CTX,
        );
        expect(res2.status).toBe(400);
    });

    it("rejects invalid password and succeeds with valid password hash", async () => {
        const correctHash = await sha256("test-dashboard-password");
        const wrongHash = await sha256("wrong-password");

        // Wrong password
        const wrongRes = await worker.fetch(
            new Request(`${ENDPOINT}/auth/login`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "CF-Connecting-IP": "192.168.1.1" },
                body: JSON.stringify({ passwordHash: wrongHash }),
            }),
            ENV,
            CTX,
        );
        expect(wrongRes.status).toBe(401);
        const wrongData = (await wrongRes.json()) as { message: string };
        expect(wrongData.message).toBe("Invalid password");

        // Correct password
        const correctRes = await worker.fetch(
            new Request(`${ENDPOINT}/auth/login`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "CF-Connecting-IP": "192.168.1.1" },
                body: JSON.stringify({ passwordHash: correctHash.toUpperCase() }), // test case-insensitivity
            }),
            ENV,
            CTX,
        );
        expect(correctRes.status).toBe(200);
        const correctData = (await correctRes.json()) as { token: string; expiresIn: number };
        expect(correctData.token).toBeTruthy();
        expect(correctData.expiresIn).toBe(43200);
    });

    it("verifies valid session and rejects invalid/expired token", async () => {
        const correctHash = await sha256("test-dashboard-password");

        const loginRes = await worker.fetch(
            new Request(`${ENDPOINT}/auth/login`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "CF-Connecting-IP": "192.168.1.2" },
                body: JSON.stringify({ passwordHash: correctHash }),
            }),
            ENV,
            CTX,
        );
        expect(loginRes.status).toBe(200);
        const { token } = (await loginRes.json()) as { token: string };

        // Valid session check
        const validRes = await worker.fetch(
            new Request(`${ENDPOINT}/auth/session`, {
                headers: { Authorization: `Bearer ${token}` },
            }),
            ENV,
            CTX,
        );
        expect(validRes.status).toBe(200);
        const validData = (await validRes.json()) as { valid: boolean };
        expect(validData.valid).toBe(true);

        // Invalid token
        const invalidRes = await worker.fetch(
            new Request(`${ENDPOINT}/auth/session`, {
                headers: { Authorization: "Bearer bogus-token" },
            }),
            ENV,
            CTX,
        );
        expect(invalidRes.status).toBe(401);

        // Missing header
        const missingRes = await worker.fetch(new Request(`${ENDPOINT}/auth/session`), ENV, CTX);
        expect(missingRes.status).toBe(401);
    });

    it("supports logout and revokes session", async () => {
        const correctHash = await sha256("test-dashboard-password");

        const loginRes = await worker.fetch(
            new Request(`${ENDPOINT}/auth/login`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "CF-Connecting-IP": "192.168.1.3" },
                body: JSON.stringify({ passwordHash: correctHash }),
            }),
            ENV,
            CTX,
        );
        const { token } = (await loginRes.json()) as { token: string };

        // Logout
        const logoutRes = await worker.fetch(
            new Request(`${ENDPOINT}/auth/logout`, {
                method: "POST",
                headers: { Authorization: `Bearer ${token}` },
            }),
            ENV,
            CTX,
        );
        expect(logoutRes.status).toBe(204);

        // Session check should now fail
        const sessionRes = await worker.fetch(
            new Request(`${ENDPOINT}/auth/session`, {
                headers: { Authorization: `Bearer ${token}` },
            }),
            ENV,
            CTX,
        );
        expect(sessionRes.status).toBe(401);
    });

    it("rate-limits after MAX_FAILED_ATTEMPTS", async () => {
        const testIp = "10.0.0.99";
        const wrongHash = await sha256("wrong-password");

        for (let i = 0; i < 5; i++) {
            const res = await worker.fetch(
                new Request(`${ENDPOINT}/auth/login`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "CF-Connecting-IP": testIp },
                    body: JSON.stringify({ passwordHash: wrongHash }),
                }),
                ENV,
                CTX,
            );
            expect(res.status).toBe(401);
        }

        // 6th attempt should be blocked
        const blockedRes = await worker.fetch(
            new Request(`${ENDPOINT}/auth/login`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "CF-Connecting-IP": testIp },
                body: JSON.stringify({ passwordHash: wrongHash }),
            }),
            ENV,
            CTX,
        );
        expect(blockedRes.status).toBe(429);
        expect(blockedRes.headers.get("Retry-After")).toBe("900");
    });

    it("does not claim /auth when auth is a configured bucket", async () => {
        const withAuthBucket = { ...ENV, ALLOWED_BUCKETS: "test-bucket,auth" };
        const response = await worker.fetch(new Request(`${ENDPOINT}/auth/login`), withAuthBucket, CTX);
        expect(response.status).toBe(403);
        expect(await response.text()).toContain("<Code>SignatureDoesNotMatch</Code>");
    });

    it("emits CORS headers for allowed origin", async () => {
        const res = await worker.fetch(
            new Request(`${ENDPOINT}/auth/session`, {
                headers: { Origin: "http://localhost:5173" },
            }),
            ENV,
            CTX,
        );
        expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
    });
});
