import { createHash, timingSafeEqual } from "node:crypto";

/** SHA-256 digests are equal length, so a short guess cannot skip the comparison or throw. */
export function credentialsMatch(presented: string, accepted: readonly string[]): boolean {
  const presentedDigest = createHash("sha256").update(presented, "utf8").digest();
  let matched = 0;
  for (const candidate of accepted) {
    const candidateDigest = createHash("sha256").update(candidate, "utf8").digest();
    matched |= timingSafeEqual(presentedDigest, candidateDigest) ? 1 : 0;
  }
  return matched === 1;
}

export function authorizationCredential(header: string | undefined): string | null {
  if (!header || header.length > 8192) return null;
  const separator = header.indexOf(" ");
  if (separator <= 0) return null;
  const scheme = header.slice(0, separator);
  const value = header.slice(separator + 1);
  if (scheme !== "Bearer" || value.length === 0 || value.includes(" ")) return null;
  return value;
}
