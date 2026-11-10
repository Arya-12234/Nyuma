import { request } from "node:http";
import { describe, expect, it } from "vitest";
import { start } from "../src/index.js";

function get(url: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request(url, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        resolve({
          status: response.statusCode ?? 0,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

describe("API process", () => {
  it("reports process health without treating a database URL as readiness", async () => {
    const server = await start({ HOST: "127.0.0.1", PORT: "0", NODE_ENV: "test", NYUMA_IDENTITY_MODE: "local-hs256-test" });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("The test server did not bind a port.");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const health = await get(`${base}/health`);
      const missing = await get(`${base}/listings`);
      const unconfigured = await get(`${base}/ready`);
      const authHealth = await get(`${base}/auth/health`);
      expect(health).toEqual({ status: 200, body: { ok: true, service: "nyuma-api" } });
      expect(health.body).not.toHaveProperty("database");
      expect(missing.status).toBe(404);
      expect(unconfigured).toEqual({ status: 503, body: { ok: false, database: "not-configured" } });
      expect(authHealth).toEqual({ status: 200, body: { ok: true, auth: "not-configured", tokenVerification: "not-configured" } });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("reports the database unavailable when a local connection fails", async () => {
    const server = await start({
      HOST: "127.0.0.1",
      PORT: "0",
      NODE_ENV: "test", NYUMA_IDENTITY_MODE: "local-hs256-test",
      APP_DATABASE_URL: "postgres://nyuma_app_login@127.0.0.1:1/nyuma_dev",
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("The test server did not bind a port.");
    try {
      const ready = await get(`http://127.0.0.1:${address.port}/ready`);
      expect(ready).toEqual({ status: 503, body: { ok: false, database: "unavailable" } });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
