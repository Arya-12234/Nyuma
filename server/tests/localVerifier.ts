import type { ClientBase } from "pg";
import { signTestToken } from "../src/auth/tokens.js";

export const localIssuer = "https://example-project.supabase.co/auth/v1";
export const localAudience = "authenticated";

/** Installs one local HS256 test key. Tokens without `kid` require exactly one key. */
export async function installLocalHmac(client: ClientBase, secret: Uint8Array, kid: string): Promise<void> {
  const text = new TextDecoder().decode(secret);
  await client.query("DELETE FROM nyuma_private.local_test_hmac_keys");
  await client.query(
    `INSERT INTO nyuma_private.verifier_config (id, issuer, audience, local_hs256_enabled)
     VALUES (true, $1, $2, true)
     ON CONFLICT (id) DO UPDATE
       SET issuer = EXCLUDED.issuer,
           audience = EXCLUDED.audience,
           local_hs256_enabled = true`,
    [localIssuer, localAudience],
  );
  await client.query(
    `INSERT INTO nyuma_private.local_test_hmac_keys (kid, secret)
     VALUES ($1, $2)`,
    [kid, text],
  );
}

export async function retireLocalHmac(client: ClientBase, kid: string): Promise<void> {
  await client.query("DELETE FROM nyuma_private.local_test_hmac_keys WHERE kid = $1", [kid]);
  await client.query("UPDATE nyuma_private.verifier_config SET local_hs256_enabled = false WHERE id");
}

export async function bindToken(client: ClientBase, secret: Uint8Array, subject: string): Promise<string> {
  const token = await signTestToken(secret, {
    subject,
    issuer: localIssuer,
    audience: localAudience,
    expiresIn: "30m",
  });
  await client.query("SELECT set_config('nyuma.access_token', $1, false)", [token]);
  return token;
}
