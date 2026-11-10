# Nyuma production JWT verification — feasibility investigation

Investigation only. No migration, function, role, grant, or row-level security setting was changed. The local cluster was queried for installed and available extensions. No request was sent to a live Supabase project, and no production JWT secret or private key was stored.

**Decision: NO-GO for Stage E.** PostgreSQL 18.4 on this machine, and the extensions Supabase documents for hosted Postgres, cannot verify an ES256 or RS256 signature. Stage E must not start until the prerequisites in section 10 are true.

Facts below are labeled. Recommendations are labeled separately.

## 1. Current architecture and the unresolved trust boundary

### What already verifies a token

Fact. The API verifier in `server/src/auth/tokens.ts` checks the bearer token with `jose` before `users.id` is used. It requires issuer `{SUPABASE_URL}/auth/v1`, audience `authenticated`, a UUID `sub`, and `role` equal to the string `authenticated`. `none`, `anon`, and `service_role` fail. HS256 is used only when `SUPABASE_JWT_SECRET` is configured. Otherwise the header `alg` selects ES256 or RS256 and the key comes from `{SUPABASE_URL}/auth/v1/.well-known/jwks.json`. That check lives in the Node process. It is not visible to a SQL session that connects with the `nyuma_api` password.

Fact. The database identity functions are in `server/migrations/007_stage_b_identity.sql`, owned by `nyuma_fn_identity`. `nyuma_verified_sub()` reads only the transaction-local setting `nyuma.access_token`. `nyuma_verified_account_id()` returns `users.id` only when that subject matches `users.auth_user_id` and `users.status` is `active`. `nyuma_account_status()` returns the status for the same subject. None of them take an account id argument. `nyuma.user_id` is not read.

Fact. The database implementation verifies HMAC-SHA256 only, and only against a local test key in `nyuma_private.local_test_hmac_keys`. The function returns null for every other `alg`, including `ES256`, `RS256`, and `none`. `nyuma_identity_verification_mode()` returns `local-hs256-test; production-es256-rs256-disabled`. The table `nyuma_private.jwt_public_keys` can store a public JWK for `ES256` or `RS256`, and its comment says those algorithms are not accepted yet. `nyuma_app` and `nyuma_api` have no privilege on `nyuma_private`.

Fact. `pgcrypto` 1.4 is installed in `nyuma_private`. On this PostgreSQL 18.4 cluster its cryptographic functions are `digest`, `hmac`, and the OpenPGP helpers (`pgp_pub_encrypt`, `pgp_pub_decrypt`, `pgp_sym_encrypt`, `pgp_sym_decrypt`, `pgp_key_id`, `pgp_armor_headers`). There is no ECDSA or RSA-PKCS1 verify function that can check a JWS signature.

### The trust boundary Stage E would cross

`docs/NYUMA_DATABASE_SECURITY_IMPLEMENTATION_PLAN.md` requires PostgreSQL to derive `users.id` from a bearer token it verifies itself. The API may pass the token. It must not pass `users.id`, `auth_user_id`, or a role as the value a policy trusts. The plan states there is no third option: a reviewed asymmetric verifier on both this server and the future host, or a different production signing setup that still keeps the signing secret out of the database and out of `nyuma_app`. `set_config('nyuma.user_id', ...)` is not that verifier.

Until the database can check an ES256 or RS256 signature, enabling RLS would lock rows to an identity the database cannot establish. Two unsafe substitutes are available and rejected:

- Trust the subject the API already resolved and write it into a setting. Anyone who can connect as `nyuma_api` can set that value to another account.
- Treat a decoded payload as identity without checking the signature. A forged token with `alg` of `none`, or a payload signed by the attacker's key, would select another person's rows.

The local HS256 path is a test of the SQL, the pool reset, and the function contracts. It is not a production verifier. Production HS256 would also require the Supabase shared secret inside the database, which this investigation does not allow.

## 2. Candidate approaches and evidence

### Candidate A — stock `pgcrypto` and pure SQL

Mechanism. `hmac()` and `digest()` in `pgcrypto`, already installed.

Maintainer and source. PostgreSQL Global Development Group, shipped in PostgreSQL contrib. This cluster reports `pgcrypto` 1.4.

PostgreSQL versions. Present on this PostgreSQL 18.4 Windows build.

Algorithms. HMAC-SHA256, SHA-384, and SHA-512 can be built in SQL. ES256 and RS256 cannot. OpenPGP encrypt and decrypt are a different message format from a JWS.

Signature behaviour. An HMAC check compares the token's third segment with `hmac(header || '.' || payload, secret, 'sha256')`. That is a real signature check for HS256 only. It accepts the token when the secret matches. It does not validate `exp`, `nbf`, `iss`, `aud`, or `role` by itself; `nyuma_verified_sub()` adds those checks for the local HS256 path.

Key rotation and JWKS. HMAC has no public key and no `kid` discovery. Rotation means replacing the shared secret. The plan forbids storing that secret for production.

Supabase hosted. `pgcrypto` is a standard contrib module and is expected on hosted Postgres. Using it for production HS256 is still rejected here.

Installation. Already installed locally in `nyuma_private`. No new extension.

Security and limits. The secret that verifies a token can also mint one. A copy in `nyuma_private` is a second copy of the Supabase legacy JWT secret, readable by `nyuma_fn_identity` and by every superuser. That is the risk Supabase documents for HS256: there is no public half, and a leaked secret forges every user. See [JWT Signing Keys](https://supabase.com/docs/guides/auth/signing-keys).

Local test without Supabase. Already done for HS256 with a test secret. It does not exercise ES256 or RS256.

Verdict. Not a production candidate.

### Candidate B — `pgjwt` (the extension Supabase documents)

Mechanism. `pgjwt`, SQL functions `sign` and `verify` over `pgcrypto`.

Maintainer and source. [michelp/pgjwt](https://github.com/michelp/pgjwt). Supabase documents it at [pgjwt](https://supabase.com/docs/guides/database/extensions/pgjwt).

PostgreSQL versions. Historically packaged by Supabase for Postgres 15. Supabase's Postgres 17 changelog removes it: projects must drop `pgjwt` before upgrading, and the Postgres 17 bundle does not include it. Source: [Forthcoming Postgres 17 release notes](https://supabase.com/changelog/35851-forthcoming-postgres-17-release-notes). It is not in `pg_available_extensions` on this PostgreSQL 18.4 cluster.

Algorithms. `HS256`, `HS384`, and `HS512` only. The README does not implement ES256 or RS256.

Signature behaviour. `verify(token, secret, algorithm)` checks an HMAC. The documented example uses a shared secret. Claim checks such as `exp` are not part of that function; a caller that ignores the `valid` column, or that only decodes the payload, accepts a forged token.

Key rotation and JWKS. None. One secret argument.

Supabase hosted. Deprecated, and absent from the Postgres 17 bundle. Supabase's own note says the platform creates and checks JWTs outside this extension. New projects use asymmetric signing at the Auth server and the Data API, not `pgjwt`. Source: [JSON Web Token (JWT)](https://supabase.com/docs/guides/auth/jwts) and the signing-keys guide above.

Installation. `CREATE EXTENSION` only where the package is installed. It is not installed here, and it would not verify a current project's ES256 token even if it were.

Security and limits. Same shared-secret problem as candidate A. Algorithm confusion is a further limit: a verifier that accepts HMAC must refuse a token whose `alg` is not the one agreed, or an attacker substitutes `HS256` and a secret they know. Nyuma's production rule is to refuse HS256 entirely.

Local test without Supabase. Not useful for the production algorithm. Not installed locally.

Verdict. Not a production candidate.

### Candidate C — `pgjwt_rs` (Rust, RS256 and Ed25519)

Mechanism. Native extension `pgjwt_rs`. Functions `jwt_verify_rs256`, `jwt_verify_ed25519`, and `jwt_verify(token, public_key, algorithm)`.

Maintainer and source. Vish Vishvanath, [github.com/vishvish/pgjwt](https://github.com/vishvish/pgjwt). Package name `pgjwt_rs`. PGEXT.CLOUD records version 0.1.2, last release noted there as 2026-03-18. The repository `Cargo.toml` on the default branch shows version 0.1.3, `pgrx` 0.18.0, and default feature `pg18`. This is not a Supabase or PostgreSQL core project.

PostgreSQL versions. The author documents PostgreSQL 18, and 13–17 behind feature flags. No Windows binary was found in the PGEXT.CLOUD package record ("No binary artifacts recorded"). It is not in `pg_available_extensions` here.

Algorithms. RS256 and Ed25519 (`EdDSA`). ES256 is not listed. Supabase's recommended production algorithm is ES256 (P-256). EdDSA for Supabase Auth is documented as "Coming soon" in the signing-keys guide. An extension that cannot check ES256 does not verify the tokens new Supabase projects issue.

Signature behaviour. The author states that signature validation is enforced and that `exp`, `nbf`, and `aud` are deliberately not enforced. `jwt_decode_payload` returns a payload marked unverified and does not check a signature. A SQL wrapper that reads the payload before testing `valid` would accept a forgery. Those claim checks can be added in SQL, but only after a real signature check, and only for algorithms the extension implements.

Key rotation and JWKS. The function takes a PEM public key argument. It does not fetch or cache JWKS. A Nyuma wrapper could select `nyuma_private.jwt_public_keys` by `kid`. That design is sound only for RS256 or EdDSA keys. It does not cover the ES256 keys Supabase publishes.

Supabase hosted. Not in the Supabase-maintained extension set described for `supabase/postgres` (see candidate F). Hosted projects cannot load an arbitrary pgrx shared library.

Installation. Rust toolchain, `cargo-pgrx`, PostgreSQL development headers, and a superuser `CREATE EXTENSION`. That is native code this milestone does not install.

Security and limits. Unreviewed for Nyuma. No ES256. Decode-without-verify helper is easy to misuse. Claim checks are the caller's job. No hosted build. A local Windows build was not established.

Local test without Supabase. Would require compiling and loading an unreviewed native library. That was not done.

Verdict. Not sufficient, and not available on either target as shipped.

### Candidate D — `jwt_context` (experimental ES256)

Mechanism. Native extension `jwt_context`. OpenSSL-backed HS256 and ES256. The session setting `jwt.context` holds a token; `jwt()` returns claims only after the signature check. The verification key is a superuser setting, `jwt.pubkey` or `jwt.secret`.

Maintainer and source. Tomas Vondra, [github.com/tvondra/jwt_context](https://github.com/tvondra/jwt_context). The repository describes the work as experimental. PGEXT.CLOUD lists version 1.0.0, created 2025-08-11, and records no binary artifacts.

PostgreSQL versions. The author's reviewed CI, as summarized by PGEXT.CLOUD, covers PostgreSQL 14–17. The package index also names 18, without a recorded binary. It is not in `pg_available_extensions` on this 18.4 server, so local availability is not established.

Algorithms. HS256 and ES256. RS256 is not implemented. The README says adding algorithms should not be hard; that is a statement of intent, not a shipped verifier.

Signature behaviour. A bad signature is rejected before `jwt()` returns context. Expiration and revocation are not implemented. A leaked token is replayable until the application adds its own `exp` check, and the current prototype does not do that check. Signing helpers exist and must not be granted to `nyuma_api`.

Key rotation and JWKS. One superuser GUC holds one public key. There is no `kid`, no set of current and retired keys, and no JWKS document. Supabase rotation keeps the previous public key until outstanding access tokens expire. A single GUC cannot represent that overlap.

Supabase hosted. Not part of the curated `supabase/postgres` extension list. Cannot be installed on a hosted project by `CREATE EXTENSION` unless Supabase ships it.

Installation. Compile against OpenSSL and PostgreSQL headers, install as superuser. Native code. Not installed here.

Security and limits. Experimental. A superuser, or any role allowed to change `jwt.pubkey`, can point verification at an attacker key and then forge context. `exp` is not enforced. HS256 mode would put a secret in a GUC. Pool reuse requires `RESET jwt.context`, which Nyuma would have to add beside the existing `nyuma.access_token` reset. RS256 projects are unsupported.

Local test without Supabase. Not established on PostgreSQL 18.4 Windows. Compiling it would violate the "no unreviewed native code" boundary of this milestone.

Verdict. The closest public ES256 idea, and still not a Stage E verifier. It is experimental, incomplete on claims and rotation, silent on RS256, and absent from both this server and hosted Supabase.

### Candidate E — `pgsodium` and Vault

Mechanism. `pgsodium` exposes libsodium. `crypto_sign_verify_detached` verifies Ed25519 signatures. Supabase Vault stores secrets and does not verify JWTs.

Maintainer and source. [pgsodium](https://github.com/michelp/pgsodium), previously packaged by Supabase. Supabase now says not to use it and points operators to Vault: [pgsodium (pending deprecation)](https://supabase.com/docs/guides/database/extensions/pgsodium).

PostgreSQL versions. Supabase has shipped it on Postgres 15 and 17. It is not in `pg_available_extensions` on this Windows PostgreSQL 18.4 build.

Algorithms. Ed25519. Not P-256 ECDSA (ES256). Not RSA-SHA256 (RS256). Supabase documents Auth EdDSA as not yet available.

Signature behaviour. A detached Ed25519 verify is not a JWS implementation. JWS EdDSA needs base64url parsing, a protected header, and `alg` binding. libsodium does not parse a JWT.

Key rotation and JWKS. Not provided for Auth signing keys.

Supabase hosted. Present on older images and pending removal. Vault does not replace it as a JWT verifier.

Installation. Not available locally. Not a candidate to enable for this purpose.

Security and limits. Using a deprecated extension to verify an algorithm Supabase Auth does not yet issue would fail closed for every real ES256 token, or would encourage a private signing scheme that is not Supabase Auth.

Local test without Supabase. The extension is not installed. No test was run.

Verdict. Not a production candidate.

### Candidate F — hosted Supabase gateway verification, then `auth.uid()`

Mechanism. Supabase Auth signs the user access token. PostgREST, Storage, and Realtime verify it before the SQL session runs. PostgREST then sets `request.jwt.claims`. `auth.uid()` reads `sub` from that setting. Row-level security policies call `auth.uid()`.

Maintainer and source. Supabase Auth, PostgREST, and the `auth` schema helpers. Documented in [JSON Web Token (JWT)](https://supabase.com/docs/guides/auth/jwts), [JWT Signing Keys](https://supabase.com/docs/guides/auth/signing-keys), and [New API keys and asymmetric authentication](https://supabase.com/docs/guides/self-hosting/self-hosted-auth-keys).

PostgreSQL versions. This is platform behaviour, not a SQL verifier. The self-hosted signing-keys note says the asymmetric system needs no database change and operates at the API gateway and service configuration.

Algorithms. Legacy HS256, plus ES256 and RS256 under the signing-keys system. New projects are described as moving to asymmetric keys. ES256 is the recommended algorithm. EdDSA is not yet issued.

Signature behaviour. Verification is real, but it happens in the gateway, using the project JWKS or the gateway's configured key set. The database sees claims that the gateway asserts. `auth.uid()` does not recompute the signature. A SQL session that can `set_config('request.jwt.claims', ...)` can present another subject. Supabase's Data API does not hand end users a direct Postgres login. Nyuma does: the application pool connects as `nyuma_api` and sends SQL itself. In that design the gateway never ran.

Key rotation and JWKS. Supabase publishes `GET /auth/v1/.well-known/jwks.json`. The edge cache for that document is 10 minutes, and client libraries may cache another 10 minutes. Supabase products that sit on the request path do not depend on that cache, so their revocation is immediate. A database that copied keys from the public JWKS would be subject to the cache delay unless an operator writes keys in. The signing-keys guide asks verifiers that do not use the Supabase client to wait until caches have the new standby key before rotation, and to wait out the access-token lifetime before revocation.

Supabase hosted. This is how hosted RLS works for the Data API. It is not an in-database signature check. `pgjwt` is not the mechanism on Postgres 17.

Installation. None inside Nyuma's database. Adopting it would mean sending every user query through PostgREST as the `authenticated` role and deleting the direct `nyuma_api` pool. That is a different application architecture, and the policies would still trust a setting the gateway wrote.

Security and limits. Meets signature verification only for connections that cannot set the claim themselves. Nyuma's pool can. `auth.uid()` is not present in this database and must not be treated as a substitute for `nyuma_verified_sub()`. A stolen `nyuma_api` password plus a forged setting is the attack the plan names and rejects.

Local test without Supabase. Not applicable. Reproducing PostgREST locally would still not make the database verify the signature.

Verdict. Explains hosted RLS. Does not satisfy Nyuma's requirement that PostgreSQL verify the token. Not a Stage E path for the current pool.

### Candidate G — `pg_net` or another HTTP client, then verify outside the database

Mechanism. `pg_net` performs asynchronous HTTP from Postgres. A trigger or function could request the JWKS URL, or post the token to another service.

Maintainer and source. Supabase, [pg_net](https://supabase.com/docs/guides/database/extensions/pg_net). The API is documented as beta.

PostgreSQL versions. Shipped by Supabase on hosted Postgres. Not in `pg_available_extensions` on this Windows 18.4 build.

Algorithms. None. HTTP is not signature verification.

Signature behaviour. The response arrives later, in `net._http_response`, not in the statement that must accept or reject a row. An RLS predicate cannot wait for that response. A design that applies the result on a following statement leaves a window, and a design that calls an external verifier moves the secret-free check out of the database again. The database would trust the HTTP response, which is another supplied identity unless that response is itself a signature the database can check. That is circular: the missing piece is still the signature primitive.

Key rotation and JWKS. Fetching JWKS on the request path is the opposite of the plan. The plan says a migration or an operator job copies public keys in, and the database does not need outbound network access to verify a token. An outbound client also gives `nyuma_fn_identity` a way to reach the network if the function is ever granted to it.

Supabase hosted. `pg_net` can be enabled. That does not add ES256.

Installation. Not installed locally. Not proposed.

Security and limits. Asynchronous, networked, and unable to verify a JWS. Fail-open if a policy treats "request sent" as "token accepted".

Local test without Supabase. Would not prove signature verification.

Verdict. Not a verifier.

### Candidate H — untrusted procedural languages

Mechanism. `plpython3u` is available on this server and is not installed. A Python function could import a JWT library. `plv8` could do the same in JavaScript. Supabase removed `plv8` from the Postgres 17 bundle.

Maintainer and source. PostgreSQL (`plpython3u`), and the V8 embedding Supabase used to ship.

Algorithms. Whatever the library implements, including ES256 and RS256.

Signature behaviour. Could be complete if the library is `jose` or an equivalent and the SQL wrapper enforces `alg`. The language is untrusted: the function owner can read files, open sockets, and run code as the database operating-system user.

Key rotation and JWKS. Possible in library code, and still the wrong place to fetch JWKS per request.

Supabase hosted. `plpython3u` is not a supported hosted language. `plv8` was removed for Postgres 17. `pg_tle` is for trusted languages and cannot load this.

Installation. Rejected by the security plan and by this milestone's boundary on unreviewed native code and untrusted languages.

Verdict. Rejected.

### What this server actually has

Fact, from `pg_available_extensions` on PostgreSQL 18.4 at `127.0.0.1:5433`, database `nyuma_dev`, on the day of this investigation. Names matching crypto, JWT, sodium, Python, Perl, V8, WASM, TLE, ECDSA, JOSE, OpenSSL, or net were:

`bool_plperl`, `bool_plperlu`, `hstore_plperl`, `hstore_plperlu`, `hstore_plpython3u`, `jsonb_plperl`, `jsonb_plperlu`, `jsonb_plpython3u`, `ltree_plpython3u`, `pgcrypto`, `plperl`, `plperlu`, `plpython3u`, `sslinfo`.

`pgjwt`, `pgjwt_rs`, `jwt_context`, `pgsodium`, `pg_net`, and `plv8` are not available to `CREATE EXTENSION` here. `sslinfo` reports TLS state of the client connection. It does not verify a JWT.

## 3. Comparison

| Candidate | ES256 | RS256 | Signature check in SQL | `exp` / `role` / issuer | `kid` rotation without a shared secret | On this PostgreSQL 18.4 | On hosted Supabase | Fits Nyuma's pool |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `pgcrypto` HMAC | No | No | HS256 only, if the secret is stored | Only in Nyuma's own SQL, and only for HS256 | No | Yes, already installed | Yes as contrib | No for production |
| `pgjwt` | No | No | HS256 family only | Not in the extension | No | Not installed | Removed in the Postgres 17 bundle | No |
| `pgjwt_rs` | No | Yes | Yes, RS256 and Ed25519 | Not in the extension | Caller must pass a PEM | Not installed, no recorded Windows binary | Not in the hosted set | No |
| `jwt_context` | Yes, experimental | No | Yes, one superuser public key | Expiration not implemented | One GUC, no JWKS overlap | Not installed; CI evidence is 14–17 | Not in the hosted set | No |
| `pgsodium` | No | No | Ed25519 detached signatures, not JWS | No | No | Not installed | Pending deprecation; Auth EdDSA not issued | No |
| Gateway plus `auth.uid()` | Yes, in the gateway | Yes, in the gateway | No | Gateway checks the token; SQL reads a setting | Gateway and JWKS | Not how this database is connected | Yes for the Data API | No. `nyuma_api` can set a claim |
| `pg_net` | No | No | No | No | Could fetch a document; cannot check it in the same statement | Not installed | Available, beta | No |
| `plpython3u` or `plv8` | Possible in a library | Possible in a library | Possible | Possible | Possible | `plpython3u` is available and rejected | `plv8` removed on Postgres 17; Python untrusted languages are not the hosted model | No |

## 4. Recommended architecture

Recommendation, not an implementation. Keep the Stage B contract and do not open Stage E.

When a reviewed verifier exists, the production path should be:

1. The API continues to verify the bearer token with `jose` and the project JWKS. That remains the HTTP gate. It is not the database gate.
2. The pool keeps storing the raw bearer token in transaction-local `nyuma.access_token`, then clears it before the connection returns to the pool.
3. `nyuma_verified_sub()` stays `SECURITY DEFINER`, owned by `nyuma_fn_identity`, with a fixed `search_path`. It accepts `ES256` or `RS256` only. `HS256`, `none`, and every other `alg` return null in production. The local HS256 test path stays a test installation, not a production fallback.
4. The signature function is an extension call made by `nyuma_fn_identity`, using the public key stored for the token's `kid` and `alg`. The extension must return failure without a trusted payload. Nyuma SQL then checks `iss`, `aud` = `authenticated`, `role` = `authenticated`, `exp` strictly after `clock_timestamp()`, `nbf` when present, and a UUID `sub`. Any failure returns null.
5. `nyuma_verified_account_id()` is unchanged in meaning: `users.id` only for an active row whose `auth_user_id` is that subject.
6. Policies and views, when Stage E is eventually written, call those functions. They do not call `auth.uid()`, `request.jwt.claims`, or `nyuma.user_id`.

Do not adopt candidates A, B, E, F, G, or H as the production database verifier. Candidates C and D are evidence that native extensions can check some asymmetric signatures. Neither is the reviewed, pinned, dual-platform ES256 and RS256 verifier the plan requires.

## 5. Key management and rotation

This is the strategy to use after a verifier exists. It matches the security plan and Supabase's public-key discovery model. It is not implemented by this document.

- The private key stays inside Supabase Auth. It is never inserted into Postgres, never logged, and never given to `nyuma_fn_identity`.
- `nyuma_private.jwt_public_keys` stores `kid`, `alg` (`ES256` or `RS256` only), the public JWK, and `retired_at`. `nyuma_app` remains revoked on that schema.
- An operator or a migration copies public keys in. The database does not call the JWKS URL while verifying a request. `pg_net` is not part of the hot path.
- Before Supabase rotates a standby key into use, the new public key is inserted with `retired_at` null. Tokens for the previous `kid` still verify.
- After rotation, leave the previous public key in place until every access token it signed is past `exp`. Supabase's signing-keys guide uses the access-token lifetime plus a margin (their example is one hour plus fifteen minutes) before revocation. Nyuma's copy should not delete a key sooner than that, because a still-valid token would start failing closed for live users.
- Set `retired_at` to revoke trust. `nyuma_verified_sub()` treats a retired key as unknown and returns null. Delete the row only after that.
- Unknown `kid`, mismatched `alg` and key type, or a second header field such as `crit` returns null.
- Do not cache JWKS inside `nyuma_api` beyond what `jose` already does for the HTTP gate, and do not let that cache authorize SQL. The database decision uses the keys table.
- Supabase's edge cache of the JWKS document is about ten minutes, with client caches that can add another ten. That delay matters for a component that pulls the URL itself. An operator-pushed key is not subject to that cache. Supabase's own Data API does not use that cache; Nyuma's SQL will not either.
- Local tests generate their own P-256 and RSA keypairs. They never copy a project private key or the legacy JWT secret.

## 6. Local PostgreSQL testing plan

Run this only after a verifier is chosen and reviewed. Do not point it at a live project. This investigation did not run these steps, because no ES256 or RS256 verifier is installed.

1. Generate an ES256 P-256 keypair and an RS256 2048-bit keypair on the test machine. Record only the public JWK, each with its own `kid`.
2. Insert both into `nyuma_private.jwt_public_keys` on `127.0.0.1` as the migration owner. Do not grant the table to `nyuma_app`.
3. Sign fixtures with the private keys in the test process. Claims match the API verifier: issuer `https://example-project.supabase.co/auth/v1`, audience `authenticated`, `role` = `authenticated`, a UUID `sub`, and a short `exp`.
4. As `nyuma_api`, set `nyuma.access_token` to each fixture and call `nyuma_verified_sub()`. The matching active user returns. The following return null and do not raise a crypto error to the client: flipped signature bit, wrong key for the `kid`, swapped `kid`, `alg` `none`, `alg` `HS256`, expired `exp`, future `nbf`, wrong issuer, wrong audience, `role` `service_role` or `anon`, missing `role`, non-UUID `sub`, retired key, unknown `kid`.
5. Repeat with `set_config('nyuma.user_id', '<other uuid>', true)` and a valid token for account A. The result stays account A.
6. Omit the token. The result is null.
7. Check out a pooled connection, verify, return it, and check out again with no token and with a different token. The second checkout must not see the first token.
8. Confirm `pg_available_extensions` and the installed extension version match the pinned build used on the host. A test that passes only on a privately compiled library is not a host test.
9. Keep the existing HS256 suite, and keep its log line that production ES256 and RS256 are the subject of this new suite rather than the HMAC suite.

## 7. Hosted Supabase compatibility requirements

Fact. Hosted verification of user access tokens is a gateway feature. The signing-keys documentation and the self-hosted asymmetric-key note place ES256 and RS256 at Auth, PostgREST, Storage, and Realtime. They do not add a SQL function Nyuma can call.

Fact. Supabase Postgres 17 dropped `pgjwt` and `plv8`. The extension that remains associated with JWTs in older docs is HMAC-only and is not the production algorithm.

A future hosted deployment can use the recommended architecture only if all of the following are true:

- The hosted Postgres major accepts the same pinned extension build that was tested on PostgreSQL 18.4, from Supabase's extension distribution. A library loaded only on the Windows test server is not enough.
- The extension is created by a superuser migration in a schema `nyuma_app` cannot use, and `EXECUTE` is granted only to `nyuma_fn_identity`.
- Public keys are loaded by the operator from the project JWKS or dashboard. The database role used for requests still has no network privilege and no private key.
- Nyuma continues to use its own pool and its own policies. Hosted `auth.uid()` policies are not a drop-in replacement while the application connects as `nyuma_api`.
- Enabling hosted RLS on Supabase tables is a separate step from this investigation and is not authorized here.

If the project later moves user traffic onto the Supabase Data API exclusively, that is a new design. It still has to show that the connecting role cannot forge `request.jwt.claims`. That design is not the current Nyuma pool, and it is not approved by this document.

## 8. Failure modes and fail-closed behaviour

These are the required outcomes for any future verifier. They are how the local HS256 path already behaves, and how production must behave.

| Event | Result |
| --- | --- |
| Missing, blank, or oversized token | `nyuma_verified_sub()` returns null |
| Malformed JSON, wrong segment count, or `crit` in the header | null |
| `alg` other than the agreed production algorithm | null |
| `kid` missing, unknown, retired, or paired with the other algorithm | null |
| Signature mismatch | null, not an exception string that leaks key material |
| `exp` absent or not strictly after `clock_timestamp()` | null |
| `nbf` present and still in the future | null |
| Issuer, audience, or `role` mismatch | null |
| `sub` not a UUID, or no active `users` row | `nyuma_verified_account_id()` returns null |
| Caller sets `nyuma.user_id` or `request.jwt.claims` | ignored |
| Extension missing, key table empty, or verifier function errors | null or a controlled `42501`. The policy must not see a subject |
| Valid token for account A used to ask for account B's id | account A's id, or null. Never B's id |
| Stolen bearer token | That user until `exp`. The plan does not provide earlier revocation of one token |
| Stolen `nyuma_api` password and no token | Connection works. Account-scoped rows stay hidden once RLS exists. That protection is not turned on by this investigation |

`STABLE` may cache a verification result inside one statement. The next statement on that connection must read the token again. The pool reset already clears `nyuma.access_token` after the transaction. A future extension that stores session state, as `jwt_context` does, would need the same reset. The current code does not add that state.

## 9. GO / NO-GO for Stage E

**NO-GO.**

Stage E enables and then forces row-level security. Policies would hide rows based on the verified account. This server cannot verify the production signature, and the extensions Supabase hosts do not close that gap. Turning RLS on against the local HS256 test, or against a user id supplied by the API, would either lock the product to a non-production algorithm or accept a forged identity.

Decoding a payload, calling `auth.uid()`, or storing the JWT secret are not substitutes. They fail the acceptance rule that the database must check the cryptographic signature, the algorithm, and the claims, and must reject expired and malformed tokens.

Stage D and the search-path follow-up are unaffected. Row-level security stays disabled.

## 10. Prerequisites before Stage E can begin

All of these are required. Meeting one is not enough.

1. A reviewed extension, pinned by version and checksum, verifies ES256 and RS256 JWS signatures from a public key. EdDSA may be added later if Supabase Auth issues it. HS256 is not the production algorithm.
2. The same pinned build is loadable on the local Windows PostgreSQL 18.4 cluster and on the hosted Supabase Postgres major the project will use. It appears in that host's extension distribution. A private compile used only in development does not qualify.
3. The extension does not require the Supabase private key or the legacy JWT secret. Public JWK or PEM material is sufficient.
4. Failure does not yield a trusted payload. A helper that decodes without verifying is not granted to `nyuma_app` or `nyuma_api`.
5. `nyuma_verified_sub()` performs the claim checks in section 6 of this document and in the security plan: `alg`, `kid`, signature, `iss`, `aud`, `role`, `exp`, optional `nbf`, and UUID `sub`. Any failure returns null.
6. Keys live in `nyuma_private.jwt_public_keys`, with `retired_at`. Operators copy public keys. Requests do not fetch JWKS. Overlap during rotation follows section 5.
7. `nyuma_app` still has no privilege on `nyuma_private` and cannot execute the raw verifier except through `nyuma_verified_sub()`.
8. Local tests in section 6 pass against generated keys, with the pool-reset test, and without a network call to Supabase.
9. Existing Stage A–D behaviour still passes, including quantity checks, role requests, and the sample workspace.
10. A written decision after that evidence replaces this NO-GO. Until that decision, do not enable RLS, do not force RLS, and do not add a policy.
