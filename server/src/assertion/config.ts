import { createRemoteJWKSet, type JWTVerifyGetKey } from "jose";
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAssertionKeyId } from "./canonical.js";
import { assertKeyFileRestricted, KeyFileAccessError } from "./keyFileAccess.js";

export interface SignerSettings {
  port: number;
  keyId: string;
  hmacKey: Buffer;
  credentials: readonly string[];
  issuer: string;
  keys: JWTVerifyGetKey;
}

const MIN_CREDENTIAL_BYTES = 32;

export function loadSignerSettings(
  env: Record<string, string | undefined>,
  keys?: JWTVerifyGetKey,
): SignerSettings {
  for (const name of Object.keys(env)) {
    if (name.includes("DATABASE_URL") && env[name]) {
      throw new Error("The signer does not accept a database connection.");
    }
  }
  if (env.SIGNER_HOST !== undefined && env.SIGNER_HOST !== "127.0.0.1") {
    throw new Error("The signer listens only on 127.0.0.1.");
  }
  const port = env.SIGNER_PORT === undefined ? 8791 : Number(env.SIGNER_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 8787) {
    throw new Error("The signer port is invalid.");
  }
  const keyId = env.ASSERTION_KEY_ID ?? "";
  if (!isAssertionKeyId(keyId)) throw new Error("The assertion key id is invalid.");
  const hmacKey = loadHmacKey(env);
  const credentials = loadCredentials(env, hmacKey);
  const supabaseUrl = env.SUPABASE_URL ?? "";
  let issuer: URL;
  try {
    issuer = new URL(supabaseUrl);
  } catch {
    throw new Error("The Supabase URL is invalid.");
  }
  if (issuer.protocol !== "https:" || issuer.username || issuer.password || issuer.search || issuer.hash) {
    throw new Error("The Supabase URL is invalid.");
  }
  if (!/^[a-z0-9-]+\.supabase\.co$/.test(issuer.hostname) || issuer.hostname.includes("your-project-ref")) {
    throw new Error("The Supabase URL is invalid.");
  }
  const resolvedKeys = keys ?? createRemoteJWKSet(new URL(`${issuer.origin}/auth/v1/.well-known/jwks.json`));
  return {
    port,
    keyId,
    hmacKey,
    credentials,
    issuer: `${issuer.origin}/auth/v1`,
    keys: resolvedKeys,
  };
}

function loadHmacKey(env: Record<string, string | undefined>): Buffer {
  const inline = env.ASSERTION_HMAC_KEY;
  const file = env.ASSERTION_HMAC_KEY_FILE;
  if ((inline ? 1 : 0) + (file ? 1 : 0) !== 1) {
    throw new Error("The assertion signing key must be configured once.");
  }
  const encoded = inline ?? readKeyFile(file!);
  const key = decodeKey(encoded.trim());
  if (key.length !== 32) throw new Error("The assertion signing key must be exactly 32 bytes.");
  return key;
}

function readKeyFile(path: string): string {
  try {
    assertKeyFileRestricted(path);
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof KeyFileAccessError) throw error;
    throw new Error("The assertion signing key could not be read.");
  }
}

function decodeKey(encoded: string): Buffer {
  if (/^[0-9a-fA-F]+$/.test(encoded) && encoded.length % 2 === 0) return Buffer.from(encoded, "hex");
  const urlDecoded = Buffer.from(encoded, "base64url");
  if (urlDecoded.length > 0 && urlDecoded.toString("base64url") === encoded.replace(/=+$/, "")) return urlDecoded;
  const standard = Buffer.from(encoded, "base64");
  if (standard.length > 0 && standard.toString("base64").replace(/=+$/, "") === encoded.replace(/=+$/, "")) return standard;
  throw new Error("The assertion signing key is invalid.");
}

function loadCredentials(env: Record<string, string | undefined>, hmacKey: Buffer): string[] {
  const credentials = [env.SIGNER_CLIENT_CREDENTIAL, env.SIGNER_CLIENT_CREDENTIAL_NEXT]
    .filter((value): value is string => Boolean(value));
  if (credentials.length === 0) throw new Error("The signer client credential is missing.");
  for (const credential of credentials) {
    if (Buffer.byteLength(credential, "utf8") < MIN_CREDENTIAL_BYTES) {
      throw new Error("The signer client credential must be at least 32 bytes.");
    }
    if (credentialOverlapsKey(credential, hmacKey)) {
      throw new Error("The signer client credential must be distinct from the assertion signing key.");
    }
  }
  return credentials;
}

function credentialOverlapsKey(credential: string, key: Buffer): boolean {
  const trimmed = credential.trim();
  if (trimmed === key.toString("hex") || trimmed === key.toString("base64url") || trimmed === key.toString("base64")) return true;
  const raw = Buffer.from(credential, "utf8");
  return raw.length === key.length && timingSafeEqual(raw, key);
}
