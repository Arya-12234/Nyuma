import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { mintAssertion } from "../src/assertion/canonical.js";
import { requestAssertion } from "../src/assertion/client.js";

const credential = "local-test-client-credential-32b";
const accessToken = "supabase-access-token-for-the-client-test";
const assertion = mintAssertion({
  key: Buffer.alloc(32, 3),
  kid: "test-key",
  sub: "58060e06-2f2a-4645-a8de-b4cc00414533",
  iat: 1762684200,
});

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("assertion signer client", () => {
  it("posts the original token and accepts only the wire string", async () => {
    let recorded: { method: string; url: string; authorization: string; type: string; body: string } | undefined;
    const endpoint = await listen((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        recorded = {
          method: request.method ?? "",
          url: request.url ?? "",
          authorization: request.headers.authorization ?? "",
          type: request.headers["content-type"] ?? "",
          body: Buffer.concat(chunks).toString("utf8"),
        };
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        response.end(assertion);
      });
    });
    const logs: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => logs.push(args);
    try {
      await expect(requestAssertion(accessToken, credential, { endpoint, timeoutMs: 1000 })).resolves.toBe(assertion);
    } finally {
      console.error = original;
    }
    expect(recorded).toEqual({
      method: "POST",
      url: "/assertions",
      authorization: `Bearer ${credential}`,
      type: "application/json",
      body: JSON.stringify({ token: accessToken }),
    });
    expect(Object.keys(JSON.parse(recorded!.body) as object)).toEqual(["token"]);
    expect(JSON.stringify(logs)).not.toContain(accessToken);
    expect(JSON.stringify(logs)).not.toContain(credential);
    expect(JSON.stringify(logs)).not.toContain(assertion);
  });

  it("fails closed for signer errors, bad bodies, and an oversized response", async () => {
    const failures = [
      { status: 401, body: "unauthorized" },
      { status: 404, body: "not-found" },
      { status: 500, body: "nope" },
      { status: 200, body: "{" },
      { status: 200, body: "" },
      { status: 200, body: "nya1.not-a-payload.not-a-mac" },
      { status: 200, body: JSON.stringify({ assertion, sub: "58060e06-2f2a-4645-a8de-b4cc00414533" }), type: "application/json" },
      { status: 200, body: "x".repeat(5000) },
    ];
    for (const failure of failures) {
      const endpoint = await listen((_request, response) => {
        response.writeHead(failure.status, { "content-type": failure.type ?? "text/plain" });
        response.end(failure.body);
      });
      await expect(requestAssertion(accessToken, credential, { endpoint, timeoutMs: 1000 })).rejects.toThrow(
        "The assertion signer request failed.",
      );
    }
  });

  it("does not include secrets when the signer times out or refuses the connection", async () => {
    const hanging = await listen(() => undefined);
    await expect(requestAssertion(accessToken, credential, { endpoint: hanging, timeoutMs: 50 })).rejects.toThrow(
      "The assertion signer request failed.",
    );
    const refused = await listen((_request, response) => response.end());
    const closed = new URL(refused);
    await new Promise<void>((resolve) => servers[servers.length - 1]?.close(() => resolve()));
    servers.pop();
    try {
      await requestAssertion(accessToken, credential, { endpoint: closed.toString(), timeoutMs: 500 });
      throw new Error("expected refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("The assertion signer request failed.");
      expect((error as Error).message).not.toContain(accessToken);
      expect((error as Error).message).not.toContain(credential);
      expect((error as Error).message).not.toContain(assertion);
    }
  });
});

function listen(
  handle: (request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => void,
): Promise<string> {
  const server = createServer(handle);
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      resolve(`http://127.0.0.1:${port}/assertions`);
    });
  });
}
