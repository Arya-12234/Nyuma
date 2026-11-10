# Nyuma alternative database identity architecture

Documentation only. This revision records design decisions. It does not implement them. No source file, migration, function, grant, role, or JWT setting was changed. No migration was run. No live Supabase project was contacted. Row-level security stays off. `nyuma_verified_sub()` is unchanged.

**Implementation: CONDITIONAL GO**, for a later milestone, and only after architectural approval of this document. The first implementation target is local PostgreSQL 18.4. Hosted deployment is not part of that GO.

**Stage E: NO-GO.** Policies must not be added until the assertion verifier exists and the forgery tests pass.

This document is the source of truth for the security design: assertion lifetime, expiry, clock tolerance, replay, transaction retries, and key rotation. `docs/NYUMA_ASSERTION_IMPLEMENTATION_PLAN.md` is the source of truth for implementation order, files, and tests. Where a security rule is stated in both, this document wins.

## Decision table

| Issue | Decision |
| --- | --- |
| Signer isolation | A separate signer process, not a module inside the API. It verifies the Supabase JWT itself, copies `sub` from that result, and is the only holder of the assertion key. |
| Assertion format | Version `nya1`. HMAC-SHA256 over a length-prefixed canonical payload. The wire value is `nya1.`, base64url payload, `.`, base64url MAC. |
| Replay | Design A. Lifetime is 120 integer seconds. A captured assertion may be replayed as its original subject until `exp`. A database nonce is not used. A transaction retry mints a new assertion instead of reusing the old one. |
| Key rotation | Install and accept a key in the database before any signer mints with it. Keep the previous key verifying during signer rollout. Emergency revocation may reject still-valid assertions. |
| Time | Integer Unix seconds. `exp` must equal `iat + 120`. Reject when `clock_timestamp() >= exp`. `iat` may be at most one second ahead of the database clock. Any larger skew fails closed. |

## 1. The current identity trust boundary

Fact. An HTTP request is authenticated in `server/src/auth/tokens.ts`. `jose` checks the Supabase access token: signature, issuer `{SUPABASE_URL}/auth/v1`, audience `authenticated`, expiry, a UUID `sub`, and `role` equal to `authenticated`. Production tokens are ES256 or RS256, verified with the project JWKS. HS256 is used only when a local or legacy secret is configured. `none`, `anon`, and `service_role` fail.

Fact. The database session is a shared login, `nyuma_api`. It inherits `nyuma_app` only. It is not a superuser, does not have `BYPASSRLS`, and is not a member of `nyuma_owner`, `nyuma_operator`, `nyuma_provisioner`, or any `nyuma_fn_*` role. `server/src/db/applicationRole.ts` rejects a checkout whose `current_user` fails that shape. `nyuma_api` cannot `SET ROLE` to `nyuma_fn_constraint` or `nyuma_fn_identity`.

Fact. `server/src/db/session.ts` stores the raw bearer token in the transaction-local setting `nyuma.access_token` after `BEGIN`, and clears it before the connection returns to the pool. `ROLLBACK` drops a transaction-local setting. The helper does not write `users.id` or `auth_user_id` into the session.

Fact. `nyuma_verified_sub()` is `SECURITY DEFINER`, owned by `nyuma_fn_identity`. It reads only `nyuma.access_token`. On this database it verifies HMAC-SHA256 against a local test key in `nyuma_private.local_test_hmac_keys`. Every other `alg`, including `ES256`, `RS256`, and `none`, returns null. `nyuma_verified_account_id()` returns `users.id` only when that subject matches an active `users` row. `nyuma.user_id` is not an identity input. `nyuma_app` and `nyuma_api` have no privilege on `nyuma_private`.

Fact. This PostgreSQL 18.4 server cannot verify an ES256 or RS256 signature inside SQL. `pgcrypto` 1.4, installed in `nyuma_private`, provides `hmac` and `digest`. Placeholder custom settings such as `nyuma.access_token` are writable by any session that can run SQL as `nyuma_api`.

The API's conclusion about `sub` is not evidence inside PostgreSQL. A caller who can run SQL as `nyuma_api` can replace `nyuma.access_token`. The assertion design below is what the database would check instead. It is not installed.

## 2. Signer isolation

Recommendation. Run the signer as its own process. Do not put the assertion key in the API process, and do not mint from an ordinary API module.

The signer does only this:

1. Accept a request whose body is a JSON object with exactly one property, `token`, holding the raw Supabase bearer token as a string.
2. Reject a missing `token`, a non-string `token`, an empty string, any additional property, a JSON array, or a JSON null. Rejection happens before verification.
3. Verify that token independently with `jose` and the trusted JWKS. Production algorithms are ES256 and RS256 only. `none`, HS256, and every other `alg` fail. The checks match the API: issuer `{SUPABASE_URL}/auth/v1`, audience `authenticated`, expiry, UUID `sub`, and `role` equal to `authenticated`.
4. Copy `sub` from the verified payload. There is no request field for a subject, an account id, or an assertion body.
5. Mint one `nya1` assertion for that `sub` and return the wire string. On failure, return an error that does not contain the key, the MAC, or the bearer token.

The signer has no database client, no `DATABASE_URL`, and no grant on Nyuma tables or functions. It cannot run SQL and it cannot insert, update, or delete coordination rows. Its network listener is private: loopback or an internal network, not a public route. Browsers and ordinary API callers are not given its address.

The API authenticates to the signer with a separate client credential. That credential is not the assertion key and not a user's JWT. The public HTTP API does not forward arbitrary signer requests and does not accept a subject from the body, the query string, or SQL.

An ordinary caller cannot obtain an assertion for another account. Their request carries their own bearer token. The API passes that token and nothing else. The signer ignores any other account identifier the caller may have placed in the Nyuma request, because those fields are not part of the signer call. A different subject would require a different valid Supabase token. A stolen token is the exposure already accepted until that token's `exp`.

Several API instances may call several signer instances. Every signer instance holds the same current minting key. None of the API instances do.

## 3. Assertion format

The signer and `nyuma_verified_sub()` MAC the canonical payload bytes, not the wire string and not a JSON object. PostgreSQL `hmac(data bytea, key bytea, 'sha256')` and the signer's HMAC-SHA256 must use those exact bytes and a raw 32-octet key.

### Canonical payload

The payload is binary. Character fields are ASCII, which is also their UTF-8 encoding. There is no BOM, no trailing NUL, and no newline.

It begins with the four octets `6e 79 61 31` (`nya1`). Then there are exactly eight fields, in this order:

| Order | Name | Value |
| --- | --- | --- |
| 1 | `kid` | Key id, 1 to 64 octets, each in `A-Za-z0-9_-` |
| 2 | `iss` | The 15 octets `nyuma-assertion` |
| 3 | `aud` | The 8 octets `nyuma-db` |
| 4 | `sub` | Lowercase UUID, exactly 36 octets |
| 5 | `iat` | Issued-at, integer Unix seconds |
| 6 | `exp` | Expiry, integer Unix seconds |
| 7 | `nbf` | Not-before, integer Unix seconds, or absent |
| 8 | `jti` | Assertion id, lowercase UUID, or absent |

Each field is a two-octet unsigned big-endian length `N`, then exactly `N` value octets. The length covers the value only, not itself. After field 8 the payload ends. Leftover octets are a malformed payload.

`sub` and a present `jti` use lowercase hexadecimal digits and hyphens, matching the API's UUID shape: version nibble `1` through `8`, variant nibble `8`, `9`, `a`, or `b`. Uppercase hex is rejected. The verifier does not lowercase it.

`iat`, `exp`, and a present `nbf` are ASCII decimal without a sign, a decimal point, or a leading zero. The value `0` is the single character `0`. The digit string is 1 to 20 characters and must fit in a signed 64-bit integer, and the integer must be greater than or equal to zero. These are whole seconds, not milliseconds.

Absent `nbf` and absent `jti` are length zero. They are not the character `-`, an empty JSON field, or an omitted length prefix. All eight length prefixes are always present.

The verifier also rejects:

- a length that runs past the end of the payload
- a field longer than its maximum (`kid` 64, timestamps 20, `iss` must be 15, `aud` must be 8, `sub` must be 36, `jti` must be 0 or 36)
- any byte in a text field outside that field's allowed set
- `iss` or `aud` other than the exact values above
- `exp` not equal to the integer `iat + 120`
- a present `nbf` whose integer is greater than `iat`
- a second copy of a field, which this layout cannot express; a map, JSON object, or JWT header is not this format

Unsupported versions, including a missing or different magic prefix, fail closed.

### Wire string

The value placed in `nyuma.access_token` is ASCII:

```text
nya1.<payload-base64url>.<mac-base64url>
```

There are exactly two dots and three non-empty segments. The first segment is the four characters `nya1`. Base64url is RFC 4648 section 5: alphabet `A-Za-z0-9_-`, no `=` padding, no whitespace, and no line breaks. The MAC decodes to exactly 32 octets.

The verifier does not trim. Leading or trailing whitespace, a fourth segment, standard base64 with `+`, `/`, or `=`, or any character outside the wire alphabet fails closed.

The MAC is HMAC-SHA256 over the canonical payload bytes, keyed by the 32-octet secret for that `kid`. The verifier recomputes it with the schema-qualified `hmac` function and compares all 32 octets. A mismatch, an unknown `kid`, and a retired `kid` all return null to the caller. The client error does not say which check failed and does not include key material.

A Supabase JWT does not start with `nya1.` and does not MAC with the assertion key, so it returns null even when its public key is stored.

`jti`, when present, is checked only for shape. It is not stored and it is not a replay key. Duplicate `jti` values are not detectable.

### Test vectors

Both implementations compute these MACs independently. The first vector proves the bytes. Its `exp` is `iat + 5`, so the verifier rejects it. The second is the lifetime the verifier accepts.

HMAC fixture. Key: 32 octets of `0x01`. `kid` `test-key`. `sub` `58060e06-2f2a-4645-a8de-b4cc00414533`. `iat` `1762684200`. `exp` `1762684205`. `nbf` and `jti` absent.

Canonical hex:

```text
6e7961310008746573742d6b6579000f6e79756d612d617373657274696f6e00086e79756d612d6462002435383036306530362d326632612d343634352d613864652d623463633030343134353333000a31373632363834323030000a3137363236383432303500000000
```

MAC hex: `677e169c3cd410b0ea2ec76ca3d85d63d76be9e000dc04691102c6107de6b441`

Acceptance vector. Same key, `kid`, `sub`, and `iat`. `exp` is `1762684320` (`iat + 120`).

Canonical hex:

```text
6e7961310008746573742d6b6579000f6e79756d612d617373657274696f6e00086e79756d612d6462002435383036306530362d326632612d343634352d613864652d623463633030343134353333000a31373632363834323030000a3137363236383433323000000000
```

MAC hex: `d58a97bfbc03607a180c4a501f7efb63d936cfafc6c59edc4b11c9e787bf82ca`

Wire:

```text
nya1.bnlhMQAIdGVzdC1rZXkAD255dW1hLWFzc2VydGlvbgAIbnl1bWEtZGIAJDU4MDYwZTA2LTJmMmEtNDY0NS1hOGRlLWI0Y2MwMDQxNDUzMwAKMTc2MjY4NDIwMAAKMTc2MjY4NDMyMAAAAAA.1YqXv7wDYHoYDEpQH377Y9k2z6_GxZ7cSxHJ54e_gso
```

## 4. Replay protection

### Design A — short expiry

The verifier accepts an assertion only while `exp = iat + 120` and `clock_timestamp() < to_timestamp(exp)`. Nothing is written to record use. A person who captures the wire string can set it on any `nyuma_api` session and be that same subject until `exp`. They cannot change the subject without breaking the MAC. They cannot extend the lifetime, because a different `exp` fails the `iat + 120` rule. Replaying the same bytes does not move `iat` or `exp`.

The capture itself is not granted by ordinary session rights. `nyuma.access_token` is transaction-local. Reading it requires SQL that runs inside that transaction, a copy from process memory, or a log that recorded it. The pool must not log the setting. After `exp`, the same bytes return null.

Cost: no nonce table, no cleanup job, and no extra write on the request path. Rollback does not consume the assertion, so a captured copy still works until `exp`. The application retry path does not use that copy. After a deadlock or serialization failure it discards the old wire string and mints another assertion with a new `iat`.

### Design B — a database nonce

The verifier would insert `jti` into a uniqueness table on first use and reject a duplicate. That stops a second session from replaying the assertion while it is unexpired.

If the insert is in the same transaction, rollback removes it. The captured assertion works again until `exp`, which is the same window as design A, plus a write. If the insert commits independently, a rolled-back business transaction still consumes the assertion. Nyuma retries serialization failures. Those retries would fail closed unless the signer minted a new assertion for each attempt. The nonce table also needs an index, retention cleanup, and an insert privilege for `nyuma_fn_identity`.

### Recommendation

Use design A. The nonce does not survive rollback unless it is committed outside the transaction, and that outside commit fights the existing retry behavior. The accepted exposure is replay of one captured assertion, as the same subject, until its original `exp`. That window is 120 seconds, not a refreshed lifetime. `jti` stays in the format so a later design can record it, and this design does not record it. A transaction retry does not reuse the old assertion. It asks the signer for a new one with a new `iat` and `exp = iat + 120`.

## 5. Key rotation

Keys are 32 random octets. The key id is unique. The database holds the verification copies in `nyuma_private`, with states `active`, `retiring`, and `retired`. `nyuma_api` cannot read or write that table. The signer holds only the key it currently mints with. It does not read the table.

`active` and `retiring` keys verify. `retired` and unknown key ids return null. A retired row does not keep the secret; the secret is erased when the state becomes `retired`. The client still sees only null.

Initial installation:

1. Generate the key and id.
2. Insert it as `active` in the database.
3. Deploy every signer instance with that key.
4. Send traffic only after those steps.

A signer that mints with a key the database does not yet accept produces assertions that fail closed. That is the safe failure, and it is also a user-facing outage, so the database step comes first.

Replacing a key without a verification gap:

1. Insert the new key as `active` while the old key remains `active`. The verifier now accepts both.
2. Confirm the new row is visible to `nyuma_verified_sub()` before changing signers. This confirmation is an operator check, not a query by the signer.
3. Roll signer instances from the old minting key to the new one. During the roll, some instances still mint the old key. Both verify.
4. When every signer mints only the new key, mark the old key `retiring`. Signers must not mint a `retiring` key. In-flight assertions still verify.
5. Wait 180 seconds, and only for this normal rotation. The wait starts when the old key is marked `retiring`, which is allowed only after every signer is minting the new key. An assertion minted in the last moment of the old key lives 120 seconds, and `iat` may be one second ahead of the database, so the shortest safe wait is 121 seconds. The remaining 59 seconds are operator margin for a slow restart. The verifier does not accept an expired assertion because of that margin.
6. Mark the old key `retired` and erase its secret.

Emergency compromise does not use the 180-second wait. Mark that key `retired` and erase the secret immediately, including assertions that have not reached `exp`. The database then rejects that key id even if a signer process still holds the octets in memory. Restart those signers so they stop minting it. Then install and deploy a replacement with the database write first. A short period of legitimate failure is accepted. Leaving a disclosed key `active` or `retiring` during a slow rollout is not.

Multiple API instances do not take part in key installation. They only need the signer address and the signer client credential. Multiple signer instances mint with one configured key id at a time. Two ids are valid in the database during the overlap, and each signer uses the id in its own deploy configuration.

## 6. Time and expiry

`iat` and `exp` are integer Unix seconds. The signer sets `exp` to `iat + 120`. The verifier requires that equality, so a signer bug or a modified payload cannot produce a longer-lived assertion that still verifies. These 120 seconds limit the internal assertion. They do not limit the Supabase access token, the login session, or how long a database transaction may run.

Let `now_s` be the floor of the epoch seconds from `clock_timestamp()`, not `transaction_timestamp()` and not `statement_timestamp()`. A long transaction must not freeze the clock and stretch the lifetime.

Accept the assertion only when all of these are true:

- `iat <= now_s + 1`
- `exp = iat + 120`
- `clock_timestamp() < to_timestamp(exp)`
- if `nbf` is present, `nbf <= iat` and `clock_timestamp() >= to_timestamp(nbf)`

`clock_timestamp() >= to_timestamp(exp)` rejects the assertion. There is no leeway that accepts an assertion at or after `exp`. Crossing `exp` makes the next verification return null. It does not cancel a statement that already passed verification and authorization and stored the account id for the rest of that call.

The `+ 1` on `iat` is the integer-second boundary, not a general skew allowance. If the signer clock is more than one second ahead of the database, or far enough behind that `exp` is not in the future, verification returns null.

Signer and database clocks must stay within one second, using NTP or an equivalent. If either clock is unsynchronized, stepped, or otherwise unreliable, assertions fail closed. The system must not fall back to a user id, skip the MAC, or widen the window on its own. Restore time, then mint again.

The future verifier should be `VOLATILE` so a statement that runs past `exp` does not keep a cached success. The current HS256 function is `STABLE`. This document does not alter it.

## 7. Security review

### Ordinary authenticated caller

This includes a caller who can influence SQL as `nyuma_api`, set session variables that role can set, create temporary objects, and reuse a pooled connection. It does not include theft of the signer host.

| Event | Result |
| --- | --- |
| Caller sends another account's UUID in a body, SQL argument, `nyuma.user_id`, or `request.jwt.claims` | Ignored. The subject comes from a verified assertion, or the result is null. |
| Caller sets `nyuma.access_token` to a Supabase JWT, `none`, or a bare UUID | Null. The MAC does not match an assertion key. |
| Caller alters `sub` or `exp` inside a captured assertion | Null. The MAC fails. |
| Caller creates a temporary table named like `users` or the key table | No effect when the verifier schema-qualifies `hmac` and the key lookup and keeps `pg_temp` last. |
| Caller asks the Nyuma API for another account's assertion | The signer never receives a caller-supplied subject. It verifies the caller's own token. |
| Caller captures a valid assertion and sets it on another `nyuma_api` session | That same subject, until `exp`. Not another subject, and not after `exp`. |
| Caller has no token | Empty setting, null identity. |

These are the guarantees against an ordinary user and against stolen `nyuma_api` SQL. They are not guarantees against a compromised signer or superuser.

### Infrastructure compromise

| Event | Result |
| --- | --- |
| API process compromise | The assertion key is not in that process. The attacker can send the signer any bearer token the process can obtain, and can act as those users. The attacker cannot invent a `sub` the signer did not verify. |
| Theft of an assertion from the transaction-local setting | Same as a captured assertion: that subject until `exp`, on any `nyuma_api` session. |
| Signer process compromise | The attacker can mint assertions for any subject until that key is retired. This is a host incident. Emergency rotation is the response. |
| Database superuser compromise | The superuser can read verification keys, change the verifier, or read rows directly. Assertion checks and later RLS do not contain a superuser. |
| Connection-pool reuse | Safe when the setting is transaction-local and the existing helper clears it before `release`. A session-level setting left in place can leak the previous assertion. |
| `ROLLBACK` | Drops the transaction-local setting. It does not retire the key. A captured copy still works until `exp`. |
| Key disclosure | Emergency retirement rejects that key id immediately. The replacement is installed in the database before signers mint it. |

## 8. Compatibility

### Local PostgreSQL 18.4

Fact, measured on this project's local cluster. The server version is PostgreSQL 18.4. `pgcrypto` 1.4 is installed in `nyuma_private`. Its functions include `hmac(bytea, bytea, text)`. `nyuma_fn_identity` can execute those functions. `nyuma_api` cannot use the schema. The current pool talks to this server directly, uses a transaction-local setting, and resets it. No new extension is required for the assertion.

The implementation must schema-qualify `nyuma_private.hmac` and the key table, and it must keep the verifier `search_path` as `pg_catalog`, `nyuma_private`, then `pg_temp` last.

### Hosted Supabase

This design was not run against a hosted project. Compatibility below is limited to public documentation.

Fact. Supabase lists `pgcrypto` among supported Postgres extensions ([Postgres Extensions](https://supabase.com/features/postgres-extensions)). The extensions guide shows `CREATE EXTENSION` and says most extensions are installed in the `extensions` schema, which is accessible to `public` by default. It also says a separate schema can be used when access to an extension must be restricted ([Database extensions](https://supabase.com/docs/guides/database/extensions)). Those pages do not state the `pgcrypto` version, do not state that the host is PostgreSQL 18, and do not say the extension can be installed a second time in `nyuma_private`.

An extension can be installed once per database. If a hosted database already has `pgcrypto` in `extensions`, Nyuma cannot install another copy in `nyuma_private`. The verifier would call the installed `hmac` by its real schema name. The key table would still live in `nyuma_private`, with no privilege for the application login. Whether that install is present, and which version it is, is unmeasured here. A third-party note of `pgcrypto` 1.3 on one Postgres 17.6 project is not evidence for this project.

Fact. Supabase's pooler documentation distinguishes a direct connection from Supavisor session mode and transaction mode. Transaction mode reuses backend connections, and session-level settings persist unless reset ([transaction pooler session state](https://supabase.com/kb/troubleshooting/resolving-cannot-execute-update-in-a-read-only-transaction-on-transaction-pooler-connections-ef582c)). The shared transaction-mode pooler does not support named prepared statements ([prepared statements](https://supabase.com/kb/troubleshooting/disabling-prepared-statements-qL8lEL)).

The assertion setting is transaction-local, which matches that warning. This document does not claim the current Node pool is ready for the shared transaction-mode pooler. Hosted use needs a direct connection or a measured session-mode pooler, and a check that the client is not leaving named prepared statements or session-level GUCs behind.

Multiple API instances are compatible with the design because they do not hold the assertion key. Multiple signer instances are compatible if every instance mints with a key the database already accepts.

What is not claimed: that hosted PostgreSQL is 18.4, that its `pgcrypto` is 1.4, that `hmac` is in `nyuma_private`, that PostgREST will enforce this assertion, or that a live project was tested.

## 9. Approaches rejected

Per-account database roles are rejected as the primary design. `current_user` is a real boundary only if `nyuma_api` is not a member of those roles. Something must still select the role. A login that is a member of every account role, or that holds every password, is a master credential on the request path. `assertApplicationRole` would reject that session. Hosted pooling would become per-user provisioning.

A gateway that only writes `nyuma.user_id` or `request.jwt.claims` is rejected. Anyone who can run SQL as `nyuma_api` overwrites the setting.

Supabase `auth.uid()` is rejected for this pool. PostgREST writes `request.jwt.claims`, and `auth.uid()` reads it. This server has no `auth.uid()` and no `supautils`. A direct `nyuma_api` login can set the claim. Moving fully onto PostgREST would replace the coordination functions.

A separate database per account is rejected. Shared agreements, shared quantity limits, and the single schema are the product.

In-database ES256 remains rejected. No reviewed extension for it is available on this server or in the hosted extension set documented for that purpose. Production HS256, meaning storing `SUPABASE_JWT_SECRET` and accepting Supabase HMAC tokens, remains rejected. The `nya1` MAC is a Nyuma assertion over a Nyuma payload. It is not a Supabase JWT. `plpython3u` and unreviewed native verifiers remain rejected.

Design B, the nonce table, is rejected as the replay control for the reasons in section 4.

## 10. Later implementation sequence

This sequence is not approval to start. It preserves current workflows once it is approved and built.

1. Add assertion verification beside the current verifier. Keep the local HS256 test path working until tests mint `nya1` assertions.
2. Deploy the signer with no database access. The pool sends an assertion only after the signer has verified the bearer token. A missing token still sets an empty value. The pool does not pass `users.id`.
3. Leave listing, demand, agreement, purchase, outcome, and role-request SQL on `nyuma_verified_account_id()`, `nyuma_insert_commitment`, `nyuma_insert_outcome`, `nyuma_insert_purchase`, and `nyuma_set_commitment_status`.
4. Leave Stage D grants in place. `nyuma_api` gains no revoked table write, no lock or quantity helper, no `BYPASSRLS`, and no mint function.
5. Run the tests in section 11 while RLS is still off.
6. Open Stage E only after those tests pass, in its own change. Policies call `nyuma_verified_account_id()`. `nyuma_fn_constraint` remains the quantity backstop.
7. Rollback restores the previous verifier body and the previous pool payload. It does not drop coordination tables, enable RLS, or widen `nyuma_api`.

## 11. Tests required before Stage E

Run these on local PostgreSQL 18.4. Generate keys in the test. Do not call a live JWKS. RLS stays off.

- The test vector in section 3 verifies with the all-`0x01` key and returns the expected subject.
- A valid assertion for an active account returns that account from `nyuma_verified_account_id()`.
- After `COMMIT` and pool release, a checkout with no assertion does not return that account.
- `ROLLBACK` clears the transaction-local setting.
- Setting `nyuma.user_id`, `request.jwt.claims`, or `nyuma.access_token` to another account's UUID returns null.
- A flipped MAC bit, a retired or unknown key id, `exp` other than `iat + 120`, a future `nbf`, uppercase UUID hex, padding in base64url, trailing whitespace, and leftover canonical bytes return null and do not reveal the key.
- An assertion for account A, with a body or SQL argument naming account B, resolves to A or null, never to B.
- A Supabase-shaped ES256 token in `nyuma.access_token` returns null, including when its public key is present.
- A temporary object named like `users` or the key table does not change the result.
- `nyuma_api` still cannot `SET ROLE` to `nyuma_fn_identity` or `nyuma_fn_constraint`, and still cannot read `nyuma_private`.
- The signer rejects a JSON body that includes `sub` or any second property.
- One listing, one agreement, one purchase, one outcome, and one role approval still succeed for their real participants.
- No test reads or writes the sample-workspace browser keys.

## 12. Remaining blockers

Closed by this document: signer placement, canonical bytes, replay choice, rotation order, and expiry rules.

Still blocking hosted use, not the local implementation design:

- No measurement of the hosted `pgcrypto` schema, version, or `hmac` signature on a Nyuma database.
- No measurement of the current pool against Supavisor transaction mode. Session GUCs and named prepared statements are known hazards in the public docs.

Still blocking Stage E:

- The verifier is not built, and the section 11 tests have not passed.
- Architectural approval of this document is still required before implementation.

## 13. Conclusion

Recommendation. Use a separate signer and a `nya1` HMAC assertion. The signer verifies ES256 or RS256 and is the only place that holds the minting key. PostgreSQL recomputes the MAC with `pgcrypto` and treats the verified `sub` as the only account input. Replay of a captured assertion is bounded by its original 120-second `exp`. A transaction retry mints a new assertion. Keys overlap in the database before signers switch. Emergency revocation does not wait for that overlap to age out. Clocks that disagree by more than one second fail closed. Expiry blocks the next verification. It does not undo a statement that already passed authorization.

Residual risks:

- A captured assertion works as that subject until its original `exp`, up to 120 seconds. Reuse does not extend it.
- Signer compromise can mint any subject until the key is retired.
- Superuser compromise is outside this control.
- API compromise can present bearer tokens the process can already obtain.
- Hosted PostgreSQL is not yet shown to match the local `pgcrypto` installation.

**Implementation: CONDITIONAL GO.** It may be built in a later milestone after this design is approved, against local PostgreSQL 18.4, without RLS, without a new extension, and without granting `nyuma_api` any further privilege. Hosted deployment stays out of that milestone until the blockers in section 12 are measured.

**Stage E: NO-GO.** Do not enable or force row-level security, and do not add a policy, until that implementation exists and the forgery tests pass.
