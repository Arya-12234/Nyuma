import { decodeProtectedHeader, jwtVerify, type JWTVerifyGetKey } from "jose";
import { isLowercaseUuid } from "./canonical.js";

export class AssertionTokenError extends Error {
  constructor() {
    super("invalid-token");
    this.name = "AssertionTokenError";
  }
}

/**
 * Verifies a Supabase access token. The subject is taken only from the verified payload.
 * HS256 and `none` are rejected. This does not use the API's case-insensitive UUID check.
 */
export async function verifySupabaseSubject(
  token: string,
  input: { issuer: string; keys: JWTVerifyGetKey },
): Promise<string> {
  let algorithm: string | undefined;
  try {
    algorithm = decodeProtectedHeader(token).alg;
  } catch {
    throw new AssertionTokenError();
  }
  if (algorithm !== "ES256" && algorithm !== "RS256") throw new AssertionTokenError();
  let payload: { sub?: unknown; role?: unknown; aud?: unknown };
  try {
    const verified = await jwtVerify(token, input.keys, {
      issuer: input.issuer,
      audience: "authenticated",
      algorithms: [algorithm],
      clockTolerance: 0,
      requiredClaims: ["exp", "sub"],
    });
    payload = verified.payload;
  } catch {
    throw new AssertionTokenError();
  }
  if (!exactAudience(payload.aud) || payload.role !== "authenticated") throw new AssertionTokenError();
  if (typeof payload.sub !== "string" || !isLowercaseUuid(payload.sub)) throw new AssertionTokenError();
  return payload.sub;
}

function exactAudience(audience: unknown): boolean {
  if (audience === "authenticated") return true;
  return Array.isArray(audience) && audience.length === 1 && audience[0] === "authenticated";
}
