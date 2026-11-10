# Nyuma short-lived assertion — implementation plan

Planning only. This document does not implement the assertion. No source file, migration, function, grant, or configuration was changed. No live Supabase project is contacted. Row-level security stays off.

The security rules in this plan match `docs/NYUMA_ALTERNATIVE_IDENTITY_ARCHITECTURE.md`. That document is the source of truth for lifetime, expiry, clock tolerance, replay, retries, and key rotation. This plan is the source of truth for implementation order, files, and tests. Implementation is a conditional GO for a later local milestone. Stage E remains NO-GO.

## Outcome of this later milestone

Local PostgreSQL 18.4 can check a `nya1` assertion with `pgcrypto`. A separate signer mints that assertion only after it has verified a Supabase-shaped ES256 or RS256 token. `nyuma_api` still cannot read the key. The current local HS256 verifier remains in place until a reviewed follow-up removes it.

PostgreSQL still does not verify ES256 or RS256. `nyuma_identity_verification_mode()` stays `local-hs256-test; production-es256-rs256-disabled`. Stage B's exact-string test continues to pass.

## Implementation order

1. Canonical bytes in the signer language, locked to the published test vector. No database.
2. Signer process, with a local generated JWKS in tests. No database client.
3. Migration `011` adds key storage and teaches `nyuma_verified_sub()` to accept `nya1` beside the existing HS256 path.
4. Pool and retry call the signer once per transaction attempt.
5. Local integration tests, including forgery, rollback, retry, expiry, and temporary-object shadowing.
6. Operator rotation procedure, exercised on the local cluster with test keys.
7. Stop. Do not enable RLS. Do not delete the HS256 path in this milestone.

## 1. Signer service

### Process boundary

New process, started separately from the API. The listen address is exactly `127.0.0.1`. A port other than `8787` is chosen. Binding `0.0.0.0`, `::`, or a LAN address fails startup. The process has no route on a public interface.

The API is the only intended client. Loopback binding is not the authorization check. Every request must also present a signer client credential that is distinct from the HMAC key, from `SUPABASE_JWT_SECRET`, and from every user access token.

The API sends `Authorization: Bearer <credential>`. The signer keeps one or two current credentials. It compares the presented value with `timingSafeEqual` against each stored credential's digest, using equal-length inputs so a short guess does not exit early. A missing header, a wrong scheme, or a mismatch returns `401` with the body `unauthorized`. The response does not echo the header. The signer then closes the request and does not verify the JWT and does not mint.

An untrusted local process can open a TCP connection to `127.0.0.1`. Without the credential it receives `401` and no assertion. With a stolen credential it can call `POST /assertions`, and the signer will still mint only for a Supabase token that verifies. The credential does not let that process choose `sub`.

The credential lives only in the API process environment and the signer process environment. It is not stored in PostgreSQL, not written to a migration, and not committed. `.env.example` may name `SIGNER_CLIENT_CREDENTIAL` and leave it empty. The signer has no database client and no database password.

Rotation overlaps, and it does not use the 180-second HMAC wait. Install the new credential on the signer as a second accepted value. Roll API instances onto it. Remove the old value from the signer. During the overlap either value authenticates. After removal the old value fails closed.

Compromise of the credential is immediate. Remove it from the signer's accepted set before deploying the replacement. Calls fail closed until the API receives the new value. Do not leave the stolen credential accepted during a slow API rollout. Restarting the signer is enough to drop a credential that existed only in its memory, once the new process starts without that value.

Logs, error messages, and diagnostics must not contain the credential, the `Authorization` header, the bearer token, the HMAC key, or the assertion. A test scans captured signer output for the fixture credential and fails if it appears.

Any failure of authentication, JSON parsing, JWT verification, JWKS retrieval, or HMAC computation returns an error and mints nothing. The signer does not return a partial assertion, a decoded subject, or an unsigned payload.

The signer process environment has:

- the assertion key id and the raw 32-octet key
- the signer client credential
- `SUPABASE_URL`, used only to build the JWKS URL and the expected issuer
- no `DATABASE_URL`, no `APP_DATABASE_URL`, and no other Postgres connection string

The process image does not import `pg`. A startup check fails if any environment name contains `DATABASE_URL`. The dependency list for this process does not include a database driver.

The API process does not receive the assertion key. Its new settings are the signer URL and the signer client credential only.

### Protocol

`POST /assertions`

Request `Content-Type` is `application/json`. The body is an object with exactly one property, `token`, whose value is a non-empty string. The parser rejects:

- a second property, including `sub`, `accountId`, `users.id`, `payload`, or `kid`
- a duplicate `token` key
- a JSON array, a JSON null, or a non-object body
- a `token` that is not a string, or is empty
- a body larger than 16 KiB

Rejection is `400` and happens before JWT verification. The response body is a short code such as `invalid-request`. It does not quote the submitted body.

Success is `200` with `Content-Type: text/plain; charset=utf-8` and the `nya1` wire string. No JSON wrapper. Failure of verification is `401` with `invalid-token`. The signer does not mint an assertion for a token it did not verify.

### Supabase token verification

The signer uses `jose`, the library the API already uses. It verifies the signature itself. It does not trust a subject, a role, or an expiry that the API already parsed. The claim rules match `verifyAccessToken` in `server/src/auth/tokens.ts`:

- the protected header `alg` is exactly `ES256` or exactly `RS256`
- `none`, `HS256`, and every other `alg` fail before the payload is trusted
- the signature is checked with the JWK selected by `kid`
- issuer is exactly `{SUPABASE_URL}/auth/v1`
- audience contains exactly `authenticated`
- `exp` is present and is strictly after the signer's current time; no leeway is added
- `nbf`, when present, is not after the signer's current time
- `role` is the string `authenticated`; `anon`, `service_role`, a missing role, and any other value fail
- `sub` is a lowercase UUID of the shape the API already requires

The subject written into the assertion is that verified `sub`. There is no function argument that can replace it. A token that fails any check produces no assertion.

Local tests do not call a hosted JWKS. They generate an ES256 key pair, publish the public JWK from memory, and sign a fixture token. A second fixture signed by a different key must fail.

### JWKS

Production configuration points `jose` `createRemoteJWKSet` at `{SUPABASE_URL}/auth/v1/.well-known/jwks.json`. The token header `kid` selects the key. `alg` on the token must match the key's algorithm. A `kid` that is absent from the cached set causes one refresh. After that refresh, a still-unknown `kid`, a key whose `alg` does not match, or a failed signature fails closed. A network error, a non-200 response, or a malformed JWKS fails the request closed. The signer does not accept the token on a stale key after Supabase has removed that `kid` from a successful refresh. It does not keep using a set that failed to refresh when the current `kid` was never cached.

JWKS rotation is Supabase's rotation. The signer does not mint with those public keys. It only uses them to verify. When Supabase publishes a new signing key and later retires the old one, the next cache miss or refresh picks up the document. The signer does not pin one `kid` forever and does not require a process restart to see a new public key.

The database never fetches JWKS. The API may keep its own verifier for HTTP authorization. That verifier is not allowed to supply `sub` to the signer; the API still sends the raw bearer token, and the signer verifies it again.

For this local milestone, the signer tests inject `jose`'s local key argument instead of `createRemoteJWKSet`. No test opens a socket to `supabase.co`.

### Key protection

The key is 32 random octets, loaded once at process start from the signer environment or from a file mode `0600` outside the API source tree. It is not written to a repository, a migration, or `.env.example`. The example file may name the variable and leave it empty.

The key stays in process memory. The signer does not return it, log it, or send it to PostgreSQL. The API never sees it. There is no SQL function that mints a MAC.

### Logging

The signer logger may record the time, the status code, and the failure code. It must not record the bearer token, the `Authorization` header, the assertion wire string, the MAC, the HMAC key, or the request body. Error objects are replaced with the fixed codes above before they are logged. Tests scan captured logs for the fixture token, the fixture assertion, and the HMAC key and fail if any appears.

## 2. Canonical `nya1` bytes

Implement the encoder in `server/src/assertion/canonical.ts`. PostgreSQL does not call this module. SQL rebuilds the same bytes from the rules below. The shared proof is the test vector, not a shared library.

### Payload

HMAC input is the canonical payload, not the wire string.

The payload starts with the four octets `6e 79 61 31` (`nya1`). That magic is the domain separator. An HS256 JWT MAC is computed over a different string and a different key, so a JWT cannot satisfy this check.

Then exactly eight fields, in this order: `kid`, `iss`, `aud`, `sub`, `iat`, `exp`, `nbf`, `jti`.

Each field is a 16-bit unsigned length in big-endian order, then that many value octets. The length does not include its own two octets. The payload ends after `jti`. Leftover octets fail.

Values are ASCII, which is the UTF-8 encoding of these strings. There is no BOM and no trailing NUL.

| Field | Octets |
| --- | --- |
| `kid` | 1 to 64 bytes, each in `A-Za-z0-9_-` |
| `iss` | the 15 bytes `nyuma-assertion` |
| `aud` | the 8 bytes `nyuma-db` |
| `sub` | 36 bytes, lowercase UUID, version nibble `1`–`8`, variant nibble `8`, `9`, `a`, or `b` |
| `iat` | decimal integer Unix seconds, no sign, no fraction, no leading zero except the value `0` |
| `exp` | same encoding; the integer must equal `iat + 120` |
| `nbf` | same encoding, or a zero length when absent; a present value must be `<= iat` |
| `jti` | 36-byte lowercase UUID, or a zero length when absent |

Zero length is the two octets `00 00`. It is not a hyphen and not an omitted prefix. All eight prefixes are always written.

Uppercase UUID hex is rejected rather than folded. `jti` is checked for shape only. It is not stored.

### Wire string and Base64URL

```text
nya1.<payload-base64url>.<mac-base64url>
```

Exactly two dots and three non-empty segments. The first segment is the characters `nya1`. Base64URL is RFC 4648 section 5: alphabet `A-Za-z0-9_-`, no `=` padding, no whitespace, and no line breaks. The MAC segment decodes to exactly 32 octets.

The existing `nyuma_private.base64url_decode` rejects characters outside that alphabet, including `=`, and then adds padding only inside the decoder so PostgreSQL `decode(..., 'base64')` can run. The assertion path may call that function only after the segment matches `^[A-Za-z0-9_-]+$`. It must then re-encode the decoded bytes to unpadded base64url and require the result to equal the input segment. That rejects non-canonical encodings. A mismatch returns null. It does not raise `22023` to the client. The current decoder raises on bad input; the assertion branch catches that and returns null.

The verifier does not trim `nyuma.access_token`. If trimming would change the value, the assertion branch returns null.

### HMAC

The MAC is HMAC-SHA256 over the canonical payload bytes. The key is the raw 32-octet secret, passed to PostgreSQL as `bytea`, not as text. The SQL call is schema-qualified `nyuma_private.hmac(payload, secret, 'sha256')`.

### Test vectors

Two fixtures share the key, `kid`, `sub`, and `iat`. They differ only in `exp`. Node and PostgreSQL each compute the MAC themselves. Neither imports the other's encoder.

Published domain vector, from the architecture document. `exp` is `1762684205`, which is `iat + 5`. This proves the HMAC bytes. The verifier must reject it, because the lifetime rule is `exp = iat + 120`.

Canonical hex, 107 octets:

```text
6e7961310008746573742d6b6579000f6e79756d612d617373657274696f6e00086e79756d612d6462002435383036306530362d326632612d343634352d613864652d623463633030343134353333000a31373632363834323030000a3137363236383432303500000000
```

MAC hex:

```text
677e169c3cd410b0ea2ec76ca3d85d63d76be9e000dc04691102c6107de6b441
```

Wire:

```text
nya1.bnlhMQAIdGVzdC1rZXkAD255dW1hLWFzc2VydGlvbgAIbnl1bWEtZGIAJDU4MDYwZTA2LTJmMmEtNDY0NS1hOGRlLWI0Y2MwMDQxNDUzMwAKMTc2MjY4NDIwMAAKMTc2MjY4NDIwNQAAAAA.Z34WnDzUELDqLsdso9hdY9dr6eAA3ARpEQLGEH3mtEE
```

Acceptance vector. Same key `32 * 0x01`, `kid` `test-key`, `sub` `58060e06-2f2a-4645-a8de-b4cc00414533`, `iat` `1762684200`, `exp` `1762684320` (`iat + 120`). `nbf` and `jti` absent.

Canonical hex, 107 octets:

```text
6e7961310008746573742d6b6579000f6e79756d612d617373657274696f6e00086e79756d612d6462002435383036306530362d326632612d343634352d613864652d623463633030343134353333000a31373632363834323030000a3137363236383433323000000000
```

MAC hex:

```text
d58a97bfbc03607a180c4a501f7efb63d936cfafc6c59edc4b11c9e787bf82ca
```

Wire:

```text
nya1.bnlhMQAIdGVzdC1rZXkAD255dW1hLWFzc2VydGlvbgAIbnl1bWEtZGIAJDU4MDYwZTA2LTJmMmEtNDY0NS1hOGRlLWI0Y2MwMDQxNDUzMwAKMTc2MjY4NDIwMAAKMTc2MjY4NDMyMAAAAAA.1YqXv7wDYHoYDEpQH377Y9k2z6_GxZ7cSxHJ54e_gso
```

Proof they match:

- A Node test computes both MACs with `node:crypto` and compares them with the hex above. It does not open a database connection.
- A PostgreSQL test computes `nyuma_private.hmac` over the same canonical `bytea` values and compares them with the same hex. It does not import the Node encoder.
- `nyuma_verified_sub()` accepts the 120-second wire string only while the database clock is inside that window, and rejects the five-second wire string even when the MAC is correct.

## 3. PostgreSQL verifier

### Migration

Add `server/migrations/011_assertion_verifier.sql`. Next number after `010_stage_d_search_path.sql`. It runs in one transaction. It does not enable RLS, does not insert a production key, and does not grant anything to `nyuma_api` or `nyuma_app`.

```text
nyuma_private.assertion_keys (
  kid text primary key,
  secret bytea,
  state text not null,
  check (state in ('active', 'retiring', 'retired')),
  check (kid ~ '^[A-Za-z0-9_-]{1,64}$'),
  check (
    (state in ('active', 'retiring') and octet_length(secret) = 32)
    or (state = 'retired' and secret is null)
  )
)
```

Owner is `nyuma_fn_identity`. `REVOKE ALL` from `PUBLIC`, `nyuma_api`, and `nyuma_app`. No policy. This table is not `local_test_hmac_keys`. The HS256 test secrets stay where they are.

`CREATE OR REPLACE` of `public.nyuma_verified_sub()` must restate `SECURITY DEFINER` and `SET search_path = pg_catalog, nyuma_private, pg_temp`. Replacement otherwise resets the path that migration `010` set. The body schema-qualifies `nyuma_private.assertion_keys`, `nyuma_private.hmac`, `nyuma_private.base64url_decode`, and the existing HS256 tables. Owner remains `nyuma_fn_identity`. Existing `EXECUTE` for `nyuma_app` is preserved and not widened.

The function becomes `VOLATILE`. It is `STABLE` today. A stable result would keep a successful check for the rest of a statement after `exp`. Volatility applies to the HS256 branch as well for that one function. That is a tighter cache rule, not a new acceptance rule.

Dispatch inside the function:

1. Read `current_setting('nyuma.access_token', true)` and do not trim it.
2. Null, empty, or longer than 8192 returns null.
3. If the value starts with `nya1`, it is only the assertion branch. A malformed `nya1` value returns null and is not passed to the HS256 parser.
4. Otherwise keep the current HS256 local-test body, including its trim and its rejection of ES256, RS256, and `none`.

Assertion branch, all failures return null:

- wire shape and canonical base64url, as section 2
- parse eight fields and reject leftovers
- `iss`, `aud`, UUID shape, and the integer equality `exp = iat + 120`
- `iat` may be at most one second ahead of the database clock: `iat <= floor(extract(epoch from clock_timestamp())) + 1`
- reject when `clock_timestamp() >= to_timestamp(exp)`
- a present `nbf` must be `<= iat` and `clock_timestamp() >= to_timestamp(nbf)`
- use `clock_timestamp()`, not `transaction_timestamp()`, so an open transaction does not freeze the clock
- look up `kid` in `nyuma_private.assertion_keys`
- `active` and `retiring` with a 32-octet secret are eligible
- `retired` and unknown return null
- recompute HMAC and compare all 32 octets

The 120 seconds are the lifetime of this internal assertion. They are not the user's login session and they are not the Supabase access-token lifetime. The signer still rejects an expired Supabase token before it mints. Reusing an assertion does not move `iat` or `exp`. A retry does not refresh the old assertion; it mints a different one.

`nyuma_verified_account_id()` and `nyuma_account_status()` stay SQL wrappers. They do not read the key table. Both become `VOLATILE` so they do not cache `nyuma_verified_sub()` for a whole statement. Their `search_path` is restated as `pg_catalog, public, pg_temp`. Their bodies stay schema-qualified. Their owner stays `nyuma_fn_identity`. Their meaning is unchanged: account id only for an active row, status for the same subject.

Do not drop `nyuma_private.local_test_hmac_keys`, `nyuma_private.jwt_public_keys`, or the HS256 branch in this migration.

### Rollback

`server/migrations/rollback/011_assertion_verifier_rollback.sql` is not a forward migration. It refuses to run when a later version is recorded. It restores the previous `STABLE` bodies and search paths of the three functions from migration `007` as later adjusted by `010` (`pg_temp` last). It drops `nyuma_private.assertion_keys`. It deletes only the `011_assertion_verifier.sql` row from `schema_migrations`. It does not enable RLS, drop coordination tables, or grant `nyuma_api` a new privilege.

### When identity is checked

Four different clocks are easy to mix up. They are not the same event.

| Event | What it is |
| --- | --- |
| Assertion verification | `nyuma_verified_sub()` checks the MAC, the key state, and `clock_timestamp()` against `exp`. It returns a subject or null. |
| Authorization | A later check uses that subject: the account is active, the caller owns the row, or the caller holds the role. A null subject fails that check. |
| Transaction duration | `BEGIN` through `COMMIT` or `ROLLBACK`. It can contain many statements. `statement_timeout` is 15 seconds per statement, not per transaction. |
| Expiry while a transaction is open | The setting remains in place. The next call that verifies the assertion sees null. A statement that already copied the account id into a local variable does not automatically stop. |

Expiry does not cancel an operation that has already passed its identity and authorization checks. PostgreSQL does not abort a running function because wall time crossed `exp`. Making `nyuma_verified_sub()` `VOLATILE` only changes the result of a later call. It does not rewind an `INSERT` that already used a saved `uuid`.

There is no 120-second cap on how long a transaction may stay open. `statement_timeout` remains 15 seconds per statement. Assertion expiry only changes the result of a later verification. It does not roll back a statement that already passed verification and authorization.

Reviewed functions, from the current migration bodies. All of them run in the caller's transaction. Locks they take are held until that transaction commits or rolls back.

`nyuma_set_commitment_status`. Identity is verified once, at the start, by `nyuma_verified_account_id()` into `v_account`. A null result raises `42501` before any lock. Authorization is the party check: the account owns the listing and holds farmer or trader, or owns the demand and holds buyer. That check runs twice, both times with `v_account`. The first is before the locks. The second is after `nyuma_lock_listing`, `nyuma_lock_demand`, and `SELECT ... FROM commitments FOR UPDATE`. Those locks cover the listing, the demand, and the commitment, and they happen before the status update. A concurrent status change waits on the commitment row. Listing owner and demand buyer cannot be changed by the guards, so the party decision is not invalidated by an owner swap. The function uses `v_account` for every later check and does not read the verifier again. A later statement that calls an identity-dependent function can fail after `exp`. This call does not fail itself for that reason. Concurrency protection for the status write is sufficient.

`nyuma_insert_purchase`. Identity is verified once, into `v_account`, before the commitment is read. Authorization is the same party check, run before `nyuma_lock_for_purchase` and again after it, both with `v_account`. The lock function locks the listing, the demand, and then the commitment row before the insert. The second party check is in the same transaction and after those locks. Owner and buyer ids are immutable, so a concurrent session cannot change who is authorized. The insert still passes through the purchase guard and quantity triggers. The function never substitutes the caller's commitment argument for the account id. A later statement can fail after `exp`. This function's authorization and lock order are sufficient.

`nyuma_insert_commitment`. Identity is verified once, into `v_account`, after the status argument is checked and before the loop. Authorization is the visibility and party check inside the loop, using `v_account` on both passes. Pass 1 does not lock. Pass 2 calls `nyuma_lock_for_commitment`, which locks the listing and the demand, and then repeats the check. The insert follows that second check. There is no commitment row to lock yet. Another commitment racing for the same quantity is caught by the commitment guard and `nyuma_assert_listing_quantities` or `nyuma_assert_demand_hold` on insert, under those listing and demand locks. The stored account id is the only account id used. A later statement can fail after `exp`. Authorization and concurrency protection are sufficient.

`nyuma_insert_outcome`. Identity is verified once, into `v_account`. Authorization is listing ownership plus a farmer or trader role, checked in the loop with that variable. Pass 2 locks the listing through `nyuma_lock_listing` and then repeats the owner and role check. The purchase row is not locked in this function. The insert trigger calls `nyuma_lock_for_outcome`, which locks the listing again and locks the purchase before the quantity checks. The account id is not read a second time from the verifier, including inside that trigger. A role cannot be removed while the account still owns the listing, because `nyuma_guard_role_removal` refuses that removal. The purchase link is re-read under the trigger's purchase lock. Authorization of the account is sufficient. The purchase lock sits in the trigger rather than in this function, which is consistent with the other quantity backstops and is not a missing account check. A later statement can fail after `exp`.

`nyuma_set_active_role`. Identity is verified once, into `verified`. Authorization is two checks: `p_user_id` must equal `verified`, and `p_role` must be an assigned role for `verified`. The `UPDATE` uses `WHERE id = verified`, not the caller-supplied id. The function does not lock `users` or `user_roles` before that decision. `nyuma_users_guard`, on the same `UPDATE`, rejects an `active_role` that is no longer in `user_roles`. It does not call the verifier. A role removed before the update fails the statement. Two authorized changes to the same account serialize on the user row update. The function uses `verified` throughout. A later statement can fail after `exp`. Authorization is sufficient only while `nyuma_users_guard` remains on `users`. This milestone does not drop that trigger. The missing `FOR UPDATE` in the function itself is not treated as a hole because the trigger repeats the role check in the same statement.

`nyuma_submit_role_requests`. Identity is verified at the start: `p_auth_user_id` must equal `nyuma_verified_sub()`, and `nyuma_account_status()` must be `active`. Authorization of the requested roles is the allow-list `farmer`, `trader`, and `buyer`. After that, the function loads `users.id` for that subject and calls `nyuma_lock_user`. That lock verifies `nyuma_verified_account_id()` again and takes `FOR UPDATE` on the user row before any insert. The status is read again after the lock. Pending uniqueness is the partial unique index and `ON CONFLICT`. All of this is one transaction. This is the only reviewed function that can fail a later identity check inside the same call: if the assertion expires before `nyuma_lock_user`, the lock raises and the inserts have not run. Inserts after a successful lock use `v_user_id` and do not call the verifier again. A following statement can still fail after `exp`. Authorization and the user-row lock are sufficient.

None of the six is missing an account check or a same-transaction party check. The residual, accepted on purpose, is that five of them do not call the verifier again after the first successful sample. `nyuma_set_active_role` depends on `nyuma_users_guard` for the final role-exists check. `nyuma_insert_outcome` depends on the outcome trigger for the purchase row lock. Those dependencies are already in the schema. This milestone does not add a second identity sample and does not put a 120-second limit on the transaction.

This milestone does not rewrite those bodies to sample the assertion a second time. A call that already stored the account id finishes under that id if its own statement is still running. `nyuma_submit_role_requests` is the exception already in the code: `nyuma_lock_user` verifies again, so that later check can fail after expiry and abort that call.

These privileged functions do not read the assertion. They lock rows, sum quantities, claim ids, or serve an operator workflow. They are not an identity boundary: `nyuma_lock_listing`, `nyuma_lock_demand`, `nyuma_lock_for_commitment`, `nyuma_lock_for_purchase`, `nyuma_lock_for_outcome`, the gram and assert helpers, the commitment, purchase, and outcome guards and check triggers, `nyuma_claim_coordination_id`, `nyuma_clear_active_role`, `nyuma_approve_role_request`, `nyuma_reject_role_request`, `nyuma_revoke_ordinary_role`, `nyuma_guard_role_removal`, and `nyuma_identity_verification_mode`.

If a transaction makes another identity-dependent call after `clock_timestamp() >= exp`, that call verifies again and gets null. `nyuma_lock_user`, the insert and status functions, the role functions, and the update and delete guards then fail closed. A direct `SELECT` that never calls the verifier is unchanged by expiry. Row-level security is off, so those reads are still not account-scoped. This milestone does not add policies to close that gap.

A fresh assertion lasts 120 seconds, and `statement_timeout` is 15 seconds. One statement that starts with more than 15 seconds left on the assertion cannot still be running when `exp` arrives. Expiry during a transaction shows up on a later statement, or on a statement that started with less than its own timeout remaining. The test for "expiry during a longer transaction" sleeps past `exp` and then issues a new identity-dependent statement. It does not expect the earlier successful statement to roll itself back.

### Replay inside 120 seconds

There is no nonce and no single-use `jti`. That is an accepted trade-off. It is not complete replay protection.

A captured wire string can be placed in `nyuma.access_token` on any `nyuma_api` session until `clock_timestamp() >= exp`. The effect is the original subject and no other. Changing `sub`, `exp`, `kid`, or any other payload byte breaks the MAC. Setting `exp` to a later instant, or asking the database to refresh `iat`, does not verify. After `exp`, the same bytes return null. The pool does not extend an assertion that it is about to reuse; a retry mints a new one instead.

The accepted exposure is that anyone who can both capture the wire string and run SQL as `nyuma_api` can act as that subject for the remainder of the 120 seconds. Capturing the string still requires reading it from the transaction, from process memory, or from a log. The signer and the pool must not log it.

## 4. Transaction and pooling

Inspected behavior today:

- `bindRequestToken` in `server/src/http/dispatch.ts` stores the raw bearer token in `AsyncLocalStorage` for one request.
- `withPooledSession` in `server/src/db/session.ts` copies that token onto the checked-out client, clears `nyuma.access_token`, checks the role, runs `SET statement_timeout = '15s'`, starts a transaction, and sets the token with `set_config(..., true)`.
- `clearAccessToken` writes an empty value and then `RESET`s the setting before the client returns to the pool.
- `runTransaction` in `server/src/db/transaction.ts` retries only SQLSTATE `40P01` and `40001`, at most three attempts. On a joined transaction it rolls back, starts a new transaction, and calls `applyLocalAccessToken` again with the same stored bearer string.
- Coordination writes and identity bootstrap call `runTransaction` inside `withPooledSession`. Reads use `withPooledSession` without `runTransaction`.

Planned change:

The value stored for the request remains the raw bearer token. The value written to `nyuma.access_token` becomes a `nya1` assertion, or empty when the request has no bearer token. The pool never writes `users.id`.

`applyLocalAccessToken` is no longer a pure copy of the stored bearer string.

For a request with no bearer token, it sets an empty transaction-local value and does not call the signer.

For a request with a bearer token, the mint happens outside an open transaction when this code controls the boundary:

1. Call `POST /assertions` with that bearer token.
2. If the signer fails, abort. Do not write the Supabase token into the setting, and do not retry the SQL with the previous assertion.
3. `BEGIN`.
4. `set_config('nyuma.access_token', <new wire string>, true)`.

`withPooledSession` mints before its `BEGIN`, then sets the assertion. `runTransaction` on its first joined attempt does not mint again and does not replace that assertion. A second mint on the happy path would not extend the lifetime, but it would hold HTTP inside the transaction. Avoid that.

On `40P01` or `40001`:

1. `ROLLBACK`. That drops the transaction-local assertion.
2. Call the signer again with the same bearer token. This is a newly minted assertion. `iat` is the time of this call. `exp` is `iat + 120`. The previous wire string is not written back and its `exp` is not changed.
3. `BEGIN` and set the new assertion.
4. Repeat up to the existing three attempts.

A validation error, a permission error, or a signer failure is not retried. The 120-second lifetime is not multiplied by the attempt count, added to the 15-second statement timeout, or applied to the Supabase token.

`statement_timeout` stays 15 seconds. It limits one statement. It is not the assertion lifetime and it does not refresh `exp`. A later statement in the same transaction calls the verifier again. If the assertion has expired, that later call gets null and an identity-dependent function fails closed. The statement that already completed does not move.

`SET statement_timeout` is session-scoped today, so the value can remain on a pooled connection after release. That does not keep `nyuma.access_token`. The assertion is cleared by `ROLLBACK` when a transaction ends and by `clearAccessToken` before `release`. The next checkout starts from an empty setting and, if it has a bearer token, a newly minted assertion. A borrowed connection must not see the previous subject.

A test that sleeps past `exp` inside one open transaction, then calls `nyuma_verified_account_id()`, must get null even though `statement_timeout` has not fired.

## 5. Key rotation

Keys are installed by an operator as `nyuma_fn_identity` or a role that can write `nyuma_private.assertion_keys`. `nyuma_api` is not that role. The migration creates the table and inserts nothing.

Initial local installation:

1. Generate 32 octets and a key id.
2. Insert the row as `active`.
3. Start the signer with that key.
4. Only then send a request that needs an assertion.

Overlap:

1. Insert the new key as `active` while the old key is still `active`.
2. Read the row back as the operator and confirm `nyuma_verified_sub()` accepts a local fixture MAC for the new id.
3. Restart signer instances one at a time onto the new key. Instances still on the old key keep verifying.
4. When every signer mints the new id, set the old row to `retiring`. Signers must not mint a retiring key.
5. Wait 180 seconds. This wait is only for normal rotation. It starts when the operator marks the old key `retiring`, and that mark is allowed only after every signer process has been restarted onto the new key. An assertion minted with the old key in its last second has `exp = iat + 120`. `iat` may be one second ahead of the database clock, so a still-valid assertion can exist for 121 seconds after the last old mint. 180 seconds is that 121 seconds plus 59 seconds of operator margin for a slow restart to be noticed. The margin does not teach the verifier to accept `clock_timestamp() >= exp`.
6. Set the old row to `retired` and set `secret` to null.

Emergency revocation does not wait 180 seconds and does not pass through `retiring`. The operator sets the compromised id to `retired` and clears `secret` in the same update. Assertions that have not reached `exp` fail closed on the next verification. A signer process that still has the old octets in memory can keep producing wire strings. PostgreSQL rejects them because the key id is retired. The operator then restarts every signer onto a new key that is already `active` in the database, so they stop minting the retired id. Acceptance is stopped by the database row, not by the restart and not by the 180-second wait.

Unknown and retired ids return null. Tests cover both, and they cover two `active` rows being accepted while two fixture signers mint different ids.

These steps are operator SQL and a signer restart. They are not an API route.

## 6. Test plan

Run `npx tsc --noEmit` and `npx vitest run` against local PostgreSQL 18.4. Generate ES256 keys and the assertion key in the test process. Do not set a live `SUPABASE_URL` for these tests.

### In this milestone

| Test | Expected |
| --- | --- |
| Published five-second vector and the 120-second vector, Node and SQL separately | Each MAC matches its published hex |
| 120-second vector while the clock is inside its window | `nyuma_verified_account_id()` returns that account |
| Five-second vector, MAC correct, `exp <> iat + 120` | null |
| One flipped MAC bit | null |
| `sub`, `kid`, or any other payload byte changed and the MAC not recomputed | null |
| `clock_timestamp()` moved to exactly `exp` | null |
| One second before `exp` | the original subject |
| `iat` more than one second ahead of the database clock | null |
| `nbf` in the future | null |
| `iss` or `aud` changed | null |
| Truncated payload, extra canonical bytes, missing field prefix | null |
| Base64URL with `=`, `+`, `/`, or a non-canonical segment | null |
| Unknown `kid` and retired `kid` | null |
| Same unexpired wire string set again on another `nyuma_api` session | the original subject, not a caller-chosen one |
| That replay after `exp`, or with `exp` edited | null |
| `nyuma.user_id` or `request.jwt.claims` set to another UUID | verified account unchanged |
| A Supabase-shaped ES256 token written into `nyuma.access_token` | null, including when `jwt_public_keys` has that public key |
| Temporary `assertion_keys` or `users` in the same session | result unchanged |
| Checkout, commit, release, checkout with no token | second session has null identity |
| `ROLLBACK`, and a failed statement that rolls back | the setting is gone on the next checkout |
| Deadlock and serialization retry | the signer is called again; the second wire string differs; `exp - iat` is 120; the first string is not reused |
| A successful identity-dependent call, then sleep past `exp`, then `nyuma_lock_user` or `nyuma_insert_commitment` | the first call stays committed; the later call fails closed |
| Signer stopped, or loopback call without the client credential | no assertion is minted |
| Signer body `{ "token", "sub" }` | `400`, no assertion |
| Two active keys, then emergency retirement of the one just used | fixtures for the retired id become null immediately; the other active id still verifies |
| Existing listing, agreement, purchase, outcome, and role-approval tests | still pass through the HS256 path |
| Signer log fixture | token, assertion, and HMAC key absent |

### After RLS exists

Not part of this implementation and not enabled here. When Stage E is separately approved, repeat cross-account reads and writes of listings, demands, commitments, purchases, and outcomes as `nyuma_api` with account A's assertion, and expect account B's private rows to be hidden or rejected. Also repeat a stolen `nyuma_api` session with no assertion and expect no account-scoped rows. Those tests wait for policies. They are listed so the assertion milestone does not claim to have proved them.

## 7. File-by-file changes

| File | Change |
| --- | --- |
| `server/src/assertion/canonical.ts` | New. Encode the payload, MAC it, and build the wire string. |
| `server/src/assertion/signer.ts` | New. HTTP listener, strict JSON, `jose` verification, no database import. |
| `server/src/assertion/client.ts` | New. API-side caller. Sends the bearer token and returns the wire string or fails. |
| `server/src/db/session.ts` | Mint before `BEGIN`. Keep clearing the setting before release. Never store `users.id`. |
| `server/src/db/transaction.ts` | On retry, roll back, mint a new assertion, then begin. Do not reuse the previous wire string. |
| `server/src/config/env.ts` | Read signer URL and signer client credential for the API. Reject an assertion key on the API process. |
| `server/src/index.ts` | No change to HTTP routes. The signer is not mounted inside the API listener. |
| `server/migrations/011_assertion_verifier.sql` | New table and function replacements. |
| `server/migrations/rollback/011_assertion_verifier_rollback.sql` | Restore the three functions and drop the new table. |
| `server/tests/assertion.canonical.test.ts` | Vector and malformed-byte tests. No database. |
| `server/tests/assertion.signer.test.ts` | Extra `sub` field, bad token, log redaction, local ES256 fixture. |
| `server/tests/assertion.verifier.integration.test.ts` | SQL forgery, shadowing, expiry, pool reuse, rollback, retry. |
| `server/tests/schema.static.test.ts` and the migration version lists | Add `011` only. |
| `.env.example` | Empty signer URL and client credential names. No key material. |

No change to `server/src/auth/tokens.ts` production rules, coordination SQL, Stage A–D grants, or the sample workspace.

## 8. Dependencies

Already present on the local server: PostgreSQL 18.4, `pgcrypto` 1.4, `hmac`, `nyuma_private`, and `nyuma_fn_identity`. Already present in `server/package.json`: `jose` and `pg`. The signer program must not link `pg`. Node's `crypto` module is enough for HMAC in the signer. No new extension and no new package are required.

## 9. Boundaries

This implementation must not:

- enable or force RLS, or add a policy
- contact or modify live Supabase
- change production JWT configuration, or store `SUPABASE_JWT_SECRET` in PostgreSQL
- grant `nyuma_api` or `nyuma_app` access to `nyuma_private.assertion_keys` or the HS256 secrets
- grant `BYPASSRLS` or any new role membership to `nyuma_api`
- remove Stage A–D grants, search-path locks, or the quantity backstop
- remove the HS256 branch in the same change as the first assertion tests
- extend or refresh `exp` beyond `iat + 120`, including for retries or `statement_timeout`
- treat the 120-second assertion as the Supabase session lifetime

## 10. Unresolved blockers

Closed by the architecture document, which now matches this plan: signer placement, byte layout, no nonce, 120-second lifetime, rotation order, the 180-second normal-retirement wait, immediate emergency revocation, and expiry that does not cancel an already authorized statement.

Still outside this local milestone:

- Hosted `pgcrypto` schema and version are unmeasured. Migration `011` may assume `hmac` is in `nyuma_private` only because this local cluster installed it there.
- The current Node pool is not certified against Supavisor transaction mode.
- Stage E policies are not designed in this plan and must not be added at the end of it.
- Removing the HS256 branch waits for a later review after the assertion tests pass.

## 11. Local-only checklist

- [ ] ES256 fixtures are generated in the test process.
- [ ] The signer test uses an in-memory JWK, not a JWKS URL on a hosted project.
- [ ] The assertion key is a test value inserted into the local database.
- [ ] `DATABASE_URL` for the suite is `127.0.0.1:5433` / `nyuma_dev`.
- [ ] The signer environment used in tests has no database URL.
- [ ] No test reads or writes the sample-workspace browser keys.
- [ ] `pgcrypto` is the existing local extension. Nothing new is installed.
- [ ] RLS flags are still false after the suite.
- [ ] The HS256 integration tests still run.
- [ ] Rollback of `011` is present and is not executed against a hosted database.

## 12. Decision

Proceed only after this plan is reviewed. The work is local assertion support plus the signer. It is not Stage E.

**Implementation of this plan: waiting for review.**

**Stage E: NO-GO.**
