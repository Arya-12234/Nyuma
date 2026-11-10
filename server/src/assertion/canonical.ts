import { createHmac } from "node:crypto";

/** Issuer fixed by the assertion format. It is not the Supabase issuer. */
export const ASSERTION_ISSUER = "nyuma-assertion";
/** Audience fixed by the assertion format. It is not the Supabase audience. */
export const ASSERTION_AUDIENCE = "nyuma-db";
/** Internal assertion lifetime. It is not the Supabase access-token lifetime. */
export const ASSERTION_LIFETIME_SECONDS = 120;

const lowercaseUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const keyIdPattern = /^[A-Za-z0-9_-]{1,64}$/;

export function isLowercaseUuid(value: string): boolean {
  return lowercaseUuid.test(value);
}

export function isAssertionKeyId(value: string): boolean {
  return keyIdPattern.test(value);
}

export interface CanonicalFields {
  kid: string;
  sub: string;
  iat: number;
  exp: number;
  nbf?: number | null;
  jti?: string | null;
}

/**
 * Length-prefixed `nya1` payload. `exp` is not required to be `iat + 120` here so the
 * published five-second HMAC fixture can be reproduced. Minting enforces the lifetime.
 */
export function encodeCanonicalPayload(fields: CanonicalFields): Buffer {
  if (!isAssertionKeyId(fields.kid)) throw new Error("The assertion key id is invalid.");
  if (!isLowercaseUuid(fields.sub)) throw new Error("The assertion subject is invalid.");
  if (fields.jti != null && fields.jti !== "" && !isLowercaseUuid(fields.jti)) {
    throw new Error("The assertion id is invalid.");
  }
  const parts = [
    Buffer.from(fields.kid, "ascii"),
    Buffer.from(ASSERTION_ISSUER, "ascii"),
    Buffer.from(ASSERTION_AUDIENCE, "ascii"),
    Buffer.from(fields.sub, "ascii"),
    Buffer.from(decimalSeconds(fields.iat), "ascii"),
    Buffer.from(decimalSeconds(fields.exp), "ascii"),
    fields.nbf == null ? Buffer.alloc(0) : Buffer.from(decimalSeconds(fields.nbf), "ascii"),
    fields.jti == null || fields.jti === "" ? Buffer.alloc(0) : Buffer.from(fields.jti, "ascii"),
  ];
  return Buffer.concat([Buffer.from("nya1", "ascii"), ...parts.map(lengthPrefix)]);
}

export function macCanonicalPayload(key: Buffer, payload: Buffer): Buffer {
  if (key.length !== 32) throw new Error("The assertion signing key must be exactly 32 bytes.");
  return createHmac("sha256", key).update(payload).digest();
}

export function wireAssertion(payload: Buffer, mac: Buffer): string {
  if (mac.length !== 32) throw new Error("The assertion MAC must be exactly 32 bytes.");
  return `nya1.${payload.toString("base64url")}.${mac.toString("base64url")}`;
}

/**
 * A signer response the API may store. The MAC is not recomputed here.
 * `exp` must be `iat + 120`. The five-second HMAC fixture is not a minted assertion.
 */
export function isMintedAssertionWire(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "nya1") return false;
  if (!/^[A-Za-z0-9_-]+$/.test(parts[1]!) || !/^[A-Za-z0-9_-]+$/.test(parts[2]!)) return false;
  const payload = Buffer.from(parts[1]!, "base64url");
  const mac = Buffer.from(parts[2]!, "base64url");
  if (payload.toString("base64url") !== parts[1] || mac.toString("base64url") !== parts[2] || mac.length !== 32) return false;
  const fields = readCanonicalFields(payload);
  if (!fields) return false;
  return fields.exp === fields.iat + ASSERTION_LIFETIME_SECONDS;
}

/** Mint a 120-second assertion. The subject and timestamps are not taken from the caller of the HTTP API. */
export function mintAssertion(input: { key: Buffer; kid: string; sub: string; iat: number }): string {
  if (!Number.isSafeInteger(input.iat) || input.iat < 0) throw new Error("The assertion time is invalid.");
  const exp = input.iat + ASSERTION_LIFETIME_SECONDS;
  const payload = encodeCanonicalPayload({ kid: input.kid, sub: input.sub, iat: input.iat, exp });
  return wireAssertion(payload, macCanonicalPayload(input.key, payload));
}

function decimalSeconds(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("The assertion time is invalid.");
  return String(value);
}

function readCanonicalFields(payload: Buffer): { iat: number; exp: number } | null {
  if (payload.length < 4 || payload.subarray(0, 4).toString("ascii") !== "nya1") return null;
  let offset = 4;
  const fields: Buffer[] = [];
  for (let index = 0; index < 8; index += 1) {
    if (offset + 2 > payload.length) return null;
    const length = payload.readUInt16BE(offset);
    offset += 2;
    if (offset + length > payload.length) return null;
    fields.push(payload.subarray(offset, offset + length));
    offset += length;
  }
  if (offset !== payload.length) return null;
  const [kid, issuer, audience, subject, issued, expires, notBefore, assertionId] = fields;
  if (!kid || !issuer || !audience || !subject || !issued || !expires || !notBefore || !assertionId) return null;
  if (!isAssertionKeyId(kid.toString("ascii"))) return null;
  if (issuer.toString("ascii") !== ASSERTION_ISSUER || audience.toString("ascii") !== ASSERTION_AUDIENCE) return null;
  if (!isLowercaseUuid(subject.toString("ascii"))) return null;
  const iat = readSeconds(issued);
  const exp = readSeconds(expires);
  if (iat === null || exp === null) return null;
  if (notBefore.length !== 0 && readSeconds(notBefore) === null) return null;
  if (assertionId.length !== 0 && !isLowercaseUuid(assertionId.toString("ascii"))) return null;
  return { iat, exp };
}

function readSeconds(value: Buffer): number | null {
  const text = value.toString("ascii");
  if (!/^(0|[1-9][0-9]*)$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function lengthPrefix(value: Buffer): Buffer {
  const encoded = Buffer.alloc(2 + value.length);
  encoded.writeUInt16BE(value.length, 0);
  value.copy(encoded, 2);
  return encoded;
}
