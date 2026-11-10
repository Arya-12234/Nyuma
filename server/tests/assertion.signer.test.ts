import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK, type JWTVerifyGetKey } from "jose";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { credentialsMatch } from "../src/assertion/credential.js";
import { loadSignerSettings } from "../src/assertion/config.js";
import { createSigner, listenOnLoopback, type SignerLogEvent } from "../src/assertion/main.js";

const subject = "58060e06-2f2a-4645-a8de-b4cc00414533";
const credential = "local-test-client-credential-32b";
const nextCredential = "local-test-next-credential-32bytes";
const hmacKey = Buffer.alloc(32, 0x01);
const issuer = "https://example.supabase.co/auth/v1";
const acceptanceWire = "nya1.bnlhMQAIdGVzdC1rZXkAD255dW1hLWFzc2VydGlvbgAIbnl1bWEtZGIAJDU4MDYwZTA2LTJmMmEtNDY0NS1hOGRlLWI0Y2MwMDQxNDUzMwAKMTc2MjY4NDIwMAAKMTc2MjY4NDMyMAAAAAA.1YqXv7wDYHoYDEpQH377Y9k2z6_GxZ7cSxHJ54e_gso";

interface Started {
  server: Server;
  url: string;
  logs: SignerLogEvent[];
}

const started: Server[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("assertion signer", () => {
  it("mints an assertion for a valid ES256 token and a valid RS256 token", async () => {
    const es = await algorithm("ES256");
    const rs = await algorithm("RS256");
    const esSigner = await start(es.keys);
    const rsSigner = await start(rs.keys);
    const esToken = await token(es.privateKey, "ES256", es.kid);
    const rsToken = await token(rs.privateKey, "RS256", rs.kid);
    expect(await post(esSigner, esToken)).toEqual({ status: 200, body: acceptanceWire });
    expect(await post(rsSigner, rsToken)).toEqual({ status: 200, body: acceptanceWire });
  });

  it("rejects bad signatures, tampered payloads, unsupported algorithms, and mismatched keys", async () => {
    const es = await algorithm("ES256");
    const rs = await algorithm("RS256");
    const signer = await start(es.keys);
    const valid = await token(es.privateKey, "ES256", es.kid);
    const [header, payload, signature] = valid.split(".");
    const tampered = `${header}.${Buffer.from("{\"role\":\"authenticated\"}").toString("base64url")}.${signature}`;
    const signatureBytes = Buffer.from(signature!, "base64url");
    signatureBytes[0] ^= 0xff;
    const badSignature = `${header}.${payload}.${signatureBytes.toString("base64url")}`;
    const noneHeader = Buffer.from(JSON.stringify({ alg: "none", kid: es.kid })).toString("base64url");
    const none = `${noneHeader}.${payload}.`;
    const hs = await new SignJWT({ role: "authenticated" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(subject)
      .setIssuer(issuer)
      .setAudience("authenticated")
      .setExpirationTime("2m")
      .sign(new TextEncoder().encode("test-only-hmac-secret-32-bytes!!"));
    const mismatched = await start(rs.keys);
    expect((await post(signer, badSignature)).status).toBe(401);
    expect((await post(signer, tampered)).status).toBe(401);
    expect((await post(signer, none)).status).toBe(401);
    expect((await post(signer, hs)).status).toBe(401);
    expect((await post(mismatched, valid)).status).toBe(401);
  });

  it("rejects the wrong issuer, audience, role, subject, expiry, and not-before time", async () => {
    const es = await algorithm("ES256");
    const signer = await start(es.keys);
    const claims = [
      { issuer: "https://wrong.example/auth/v1" },
      { audience: "anon" },
      { role: "service_role" },
      { omitRole: true },
      { subject: "not-a-uuid" },
      { subject: "58060E06-2F2A-4645-A8DE-B4CC00414533" },
      { omitSubject: true },
      { expirationTime: Math.floor(Date.now() / 1000) - 10 },
      { notBefore: Math.floor(Date.now() / 1000) + 3600 },
    ];
    for (const claim of claims) {
      const accessToken = await token(es.privateKey, "ES256", es.kid, claim);
      const result = await post(signer, accessToken);
      expect(result.status).toBe(401);
      expect(result.body).toBe("invalid-token");
    }
  });

  it("rejects a bad client credential before it inspects the token", async () => {
    const signer = await start((await algorithm("ES256")).keys);
    const result = await fetch(signer.url, {
      method: "POST",
      headers: { authorization: "Bearer not-the-credential", "content-type": "application/json" },
      body: "{",
    });
    expect(result.status).toBe(401);
    expect(await result.text()).toBe("unauthorized");
    expect(credentialsMatch("short", [credential])).toBe(false);
    expect(credentialsMatch(nextCredential, [credential, nextCredential])).toBe(true);
  });

  it("rejects extra properties, duplicate keys, and malformed bodies", async () => {
    const es = await algorithm("ES256");
    const signer = await start(es.keys);
    const accessToken = await token(es.privateKey, "ES256", es.kid);
    const bodies = [
      "",
      "{",
      "[]",
      "null",
      "{}",
      JSON.stringify({ token: "" }),
      JSON.stringify({ token: 1 }),
      JSON.stringify({ sub: subject }),
      JSON.stringify({ token: accessToken, sub: subject }),
      JSON.stringify({ token: accessToken, role: "authenticated" }),
      `{"token":${JSON.stringify(accessToken)},"token":${JSON.stringify(accessToken)}}`,
    ];
    for (const body of bodies) {
      const result = await fetch(signer.url, {
        method: "POST",
        headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
        body,
      });
      expect(result.status).toBe(400);
      expect(await result.text()).toBe("invalid-request");
    }
    const untyped = await fetch(signer.url, {
      method: "POST",
      headers: { authorization: `Bearer ${credential}` },
      body: JSON.stringify({ token: accessToken }),
    });
    expect(untyped.status).toBe(400);
    expect(await untyped.text()).toBe("invalid-request");
  });

  it("fails closed when the HMAC key or client credential is missing or too short", () => {
    const base = settings();
    expect(() => loadSignerSettings({ ...base, ASSERTION_HMAC_KEY: undefined })).toThrow(/configured once/);
    expect(() => loadSignerSettings({ ...base, ASSERTION_HMAC_KEY: Buffer.alloc(16, 1).toString("base64url") })).toThrow(/32 bytes/);
    expect(() => loadSignerSettings({ ...base, ASSERTION_HMAC_KEY: "not-a-key" })).toThrow(/invalid|32 bytes/);
    expect(() => loadSignerSettings({ ...base, SIGNER_CLIENT_CREDENTIAL: "too-short" })).toThrow(/32 bytes/);
    const missingCredential = { ...base, SIGNER_CLIENT_CREDENTIAL: undefined, SIGNER_CLIENT_CREDENTIAL_NEXT: undefined };
    expect(() => loadSignerSettings(missingCredential)).toThrow(/missing/);
    expect(() => loadSignerSettings({ ...base, DATABASE_URL: "postgres://nyuma@127.0.0.1/nyuma" })).toThrow(/database/);
    expect(() => loadSignerSettings({ ...base, SIGNER_HOST: "0.0.0.0" })).toThrow(/127\.0\.0\.1/);
    expect(() => loadSignerSettings({ ...base, SIGNER_CLIENT_CREDENTIAL: hmacKey.toString("base64url") })).toThrow(/distinct/);
    expect(() => loadSignerSettings({ ...base, SUPABASE_URL: "https://your-project-ref.supabase.co" })).toThrow(/invalid/);
  });

  it("accepts a 32-byte key from a file and rejects a short file", () => {
    const directory = mkdtempSync(join(tmpdir(), "nyuma-signer-"));
    try {
      const valid = join(directory, "key.txt");
      const short = join(directory, "short.txt");
      writeFileSync(valid, hmacKey.toString("base64url"));
      writeFileSync(short, Buffer.alloc(16, 2).toString("base64url"));
      const base = settings();
      delete base.ASSERTION_HMAC_KEY;
      expect(loadSignerSettings({ ...base, ASSERTION_HMAC_KEY_FILE: valid }).hmacKey.equals(hmacKey)).toBe(true);
      expect(() => loadSignerSettings({ ...base, ASSERTION_HMAC_KEY_FILE: short })).toThrow(/32 bytes/);
      expect(() => loadSignerSettings({ ...base, ASSERTION_HMAC_KEY: hmacKey.toString("hex"), ASSERTION_HMAC_KEY_FILE: valid })).toThrow(/configured once/);
      if (process.platform === "win32") {
        const opened = join(directory, "opened.txt");
        writeFileSync(opened, hmacKey.toString("base64url"));
        execFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"), [opened, "/grant", "*S-1-1-0:R"], {
          windowsHide: true,
        });
        expect(() => loadSignerSettings({ ...base, ASSERTION_HMAC_KEY_FILE: opened })).toThrow(/widely readable/);
        const garbage = join(directory, "garbage.txt");
        writeFileSync(garbage, "not-a-key");
        execFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"), [garbage, "/grant", "*S-1-1-0:R"], {
          windowsHide: true,
        });
        expect(() => loadSignerSettings({ ...base, ASSERTION_HMAC_KEY_FILE: garbage })).toThrow(/^The assertion signing key file is too widely readable\.$/);
        const hostile = join(directory, "key $(Remove-Item C-temp-x); & whoami.txt");
        writeFileSync(hostile, hmacKey.toString("base64url"));
        expect(loadSignerSettings({ ...base, ASSERTION_HMAC_KEY_FILE: hostile }).hmacKey.equals(hmacKey)).toBe(true);
        const savedRoot = process.env.SystemRoot;
        process.env.SystemRoot = directory;
        try {
          expect(() => loadSignerSettings({ ...base, ASSERTION_HMAC_KEY_FILE: valid })).toThrow(/could not be verified/);
        } finally {
          process.env.SystemRoot = savedRoot;
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not log the token, credential, signing key, or assertion", async () => {
    const es = await algorithm("ES256");
    const signer = await start(es.keys);
    const accessToken = await token(es.privateKey, "ES256", es.kid);
    const result = await post(signer, accessToken);
    const recorded = JSON.stringify(signer.logs);
    expect(result.status).toBe(200);
    expect(recorded).not.toContain(accessToken);
    expect(recorded).not.toContain(credential);
    expect(recorded).not.toContain(hmacKey.toString("hex"));
    expect(recorded).not.toContain(result.body);
    expect(recorded).toContain("\"code\":\"ok\"");
  });

  it("fails closed when verification cannot be completed", async () => {
    const signer = await start(async () => {
      throw new Error("jwks unavailable");
    });
    const es = await algorithm("ES256");
    const result = await post(signer, await token(es.privateKey, "ES256", es.kid));
    expect(result).toEqual({ status: 401, body: "invalid-token" });
  });

  it("binds only to loopback and does not import a database client", async () => {
    const signer = await start((await algorithm("ES256")).keys);
    const address = signer.server.address();
    expect(address && typeof address === "object" ? address.address : "").toBe("127.0.0.1");
    const directory = fileURLToPath(new URL("../src/assertion/", import.meta.url));
    const source = readdirSync(directory).map((file) => readFileSync(join(directory, file), "utf8")).join("\n");
    expect(source).not.toMatch(/from ["']pg["']/);
    expect(source).not.toContain("SUPABASE_JWT_SECRET");
  });
});

async function start(keys: JWTVerifyGetKey): Promise<Started> {
  const logs: SignerLogEvent[] = [];
  const server = createSigner(loadSignerSettings(settings(), keys), {
    nowSeconds: () => 1762684200,
    log: (event) => logs.push(event),
  });
  const port = await listenOnLoopback(server, 0);
  started.push(server);
  return { server, url: `http://127.0.0.1:${port}/assertions`, logs };
}

function settings(): Record<string, string | undefined> {
  return {
    SIGNER_HOST: "127.0.0.1",
    SIGNER_PORT: "8791",
    ASSERTION_KEY_ID: "test-key",
    ASSERTION_HMAC_KEY: hmacKey.toString("base64url"),
    SIGNER_CLIENT_CREDENTIAL: credential,
    SIGNER_CLIENT_CREDENTIAL_NEXT: nextCredential,
    SUPABASE_URL: "https://example.supabase.co",
  };
}

async function algorithm(alg: "ES256" | "RS256"): Promise<{ privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"]; keys: JWTVerifyGetKey; kid: string }> {
  const pair = await generateKeyPair(alg, { extractable: true });
  const jwk = await exportJWK(pair.publicKey) as JWK;
  const kid = alg === "ES256" ? "es-test" : "rs-test";
  jwk.alg = alg;
  jwk.kid = kid;
  return { privateKey: pair.privateKey, keys: createLocalJWKSet({ keys: [jwk] }), kid };
}

async function token(
  privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"],
  alg: "ES256" | "RS256",
  kid: string,
  overrides: {
    issuer?: string;
    audience?: string;
    role?: string;
    subject?: string;
    omitRole?: boolean;
    omitSubject?: boolean;
    expirationTime?: number | string;
    notBefore?: number;
  } = {},
): Promise<string> {
  let builder = new SignJWT(overrides.omitRole ? {} : { role: overrides.role ?? "authenticated" })
    .setProtectedHeader({ alg, kid })
    .setIssuer(overrides.issuer ?? issuer)
    .setAudience(overrides.audience ?? "authenticated")
    .setExpirationTime(overrides.expirationTime ?? "2m");
  if (!overrides.omitSubject) builder = builder.setSubject(overrides.subject ?? subject);
  if (overrides.notBefore !== undefined) builder = builder.setNotBefore(overrides.notBefore);
  return builder.sign(privateKey);
}

async function post(signer: Started, accessToken: string): Promise<{ status: number; body: string }> {
  const response = await fetch(signer.url, {
    method: "POST",
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    body: JSON.stringify({ token: accessToken }),
  });
  return { status: response.status, body: await response.text() };
}
