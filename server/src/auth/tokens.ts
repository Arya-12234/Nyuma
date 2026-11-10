import {
  createRemoteJWKSet,
  decodeProtectedHeader,
  errors,
  jwtVerify,
  SignJWT,
  type JWTPayload,
} from "jose";

// Lowercase hexadecimal only. The subject is returned unchanged. Do not fold it.
const authUserIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type TokenFailure = "missing" | "malformed" | "invalid" | "expired" | "issuer" | "audience";

export class TokenError extends Error {
  constructor(readonly reason: TokenFailure) {
    super(reason);
  }
}

export interface VerifiedIdentity {
  authUserId: string;
}

export interface TokenCheck {
  issuer: string;
  audience: string;
  keys: Parameters<typeof jwtVerify>[1];
  algorithms: string[];
}

/**
 * Verifies signature, issuer, audience, expiry, and `role`.
 * The payload is not trusted before this succeeds.
 * `role` must be the string `authenticated`, matching `nyuma_verified_sub()`.
 */
export async function verifyAccessToken(token: string, check: TokenCheck): Promise<VerifiedIdentity> {
  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(token, check.keys, {
      issuer: check.issuer,
      audience: check.audience,
      algorithms: check.algorithms,
    });
    payload = verified.payload;
  } catch (error) {
    throw mapTokenError(error);
  }
  if (payload.role !== "authenticated") throw new TokenError("invalid");
  if (typeof payload.sub !== "string" || !authUserIdPattern.test(payload.sub)) throw new TokenError("invalid");
  return { authUserId: payload.sub };
}

export function bearerToken(header: string | undefined): string {
  if (!header) throw new TokenError("missing");
  const [scheme, value, extra] = header.split(" ");
  if (scheme !== "Bearer" || !value || extra) throw new TokenError("malformed");
  return value;
}

/**
 * Legacy projects sign with HS256 and the JWT secret.
 * Current projects sign with ES256 or RS256 and publish the public key at
 * `{SUPABASE_URL}/auth/v1/.well-known/jwks.json`. The token header selects the key.
 * `none` and any other algorithm are rejected. The JWKS document is fetched only
 * when a token with an asymmetric algorithm is presented.
 */
export function createConfiguredVerifier(config: {
  supabaseUrl: string | null;
  supabaseJwtSecret: string | null;
}): ((token: string) => Promise<VerifiedIdentity>) | null {
  if (!config.supabaseUrl) return null;
  const issuer = `${config.supabaseUrl}/auth/v1`;
  const secret = config.supabaseJwtSecret ? new TextEncoder().encode(config.supabaseJwtSecret) : null;
  const jwks = createRemoteJWKSet(new URL(`${config.supabaseUrl}/auth/v1/.well-known/jwks.json`));
  return async (token: string) => {
    let algorithm: string | undefined;
    try {
      algorithm = decodeProtectedHeader(token).alg;
    } catch {
      throw new TokenError("malformed");
    }
    if (algorithm === "HS256" && secret) {
      return verifyAccessToken(token, { issuer, audience: "authenticated", keys: secret, algorithms: ["HS256"] });
    }
    if ((algorithm === "ES256" || algorithm === "RS256") && jwks) {
      return verifyAccessToken(token, { issuer, audience: "authenticated", keys: jwks, algorithms: [algorithm] });
    }
    throw new TokenError("invalid");
  };
}

export async function signTestToken(
  secret: Uint8Array,
  input: { subject: string; issuer: string; audience: string; expiresIn: string | number; extra?: JWTPayload },
): Promise<string> {
  let builder = new SignJWT({ role: "authenticated", ...input.extra })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(input.subject)
    .setIssuer(input.issuer)
    .setAudience(input.audience)
    .setIssuedAt();
  builder = typeof input.expiresIn === "number" ? builder.setExpirationTime(input.expiresIn) : builder.setExpirationTime(input.expiresIn);
  return builder.sign(secret);
}

function mapTokenError(error: unknown): TokenError {
  if (error instanceof TokenError) return error;
  if (error instanceof errors.JWTExpired || (error instanceof Error && "code" in error && error.code === "ERR_JWT_EXPIRED")) {
    return new TokenError("expired");
  }
  if (error instanceof errors.JWTClaimValidationFailed || (error instanceof Error && "code" in error && error.code === "ERR_JWT_CLAIM_VALIDATION_FAILED")) {
    const claim = error instanceof errors.JWTClaimValidationFailed ? error.claim : undefined;
    if (claim === "iss") return new TokenError("issuer");
    if (claim === "aud") return new TokenError("audience");
    return new TokenError("invalid");
  }
  if (error instanceof errors.JWTInvalid || (error instanceof Error && "code" in error && error.code === "ERR_JWS_INVALID")) {
    const message = error instanceof Error ? error.message : "";
    if (message.toLowerCase().includes("malformed") || message.toLowerCase().includes("invalid jwt")) {
      return new TokenError("malformed");
    }
    return new TokenError("invalid");
  }
  return new TokenError("invalid");
}
