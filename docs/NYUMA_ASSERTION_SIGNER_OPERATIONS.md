# Nyuma assertion signer operations

This note describes the signer and the local PostgreSQL verifier. `docs/NYUMA_ALTERNATIVE_IDENTITY_ARCHITECTURE.md` remains the source of truth for assertion lifetime, expiry, clock tolerance, replay, and key rotation.

## Secret separation

Three configurations stay apart.

| Holder | What it may contain | Where it lives |
|---|---|---|
| API process | Signer client credential. Database URLs for the API and migrations. | `.env` or `server/.env`, copied from `.env.example` |
| Signer process | Signer client credential, optional next credential, HMAC key, key id, Supabase URL | Process environment supplied only to `npm run signer`. The template is `.env.signer.example` |
| Database operator | Database verification key, the same 32 octets the signer uses for a key id | `nyuma_private.assertion_keys`, written by operator SQL as `nyuma_fn_identity`. The migration inserts no key. Not an environment variable |

The API loads `.env` and `server/.env` only. It does not load `.env.signer`. If `ASSERTION_HMAC_KEY` or `ASSERTION_HMAC_KEY_FILE` is set in the API environment, the API refuses to start and does not print the value. The signer refuses to start when any environment name contains `DATABASE_URL`.

The HMAC key and the client credential are different values. The database verification key is not written into either example file.

## Client-credential rotation

The signer reads credentials only at process start. It accepts `SIGNER_CLIENT_CREDENTIAL` and, when that variable is also set, `SIGNER_CLIENT_CREDENTIAL_NEXT`. There is no reload endpoint. This is not zero-downtime rotation: every change requires a restart, and a single signer process is down during that restart.

The new credential is accepted before the old one is retired by starting the signer with both values.

1. Generate at least 32 random bytes. The value must not be the HMAC key.
2. Stop the signer. Start it with the old value in `SIGNER_CLIENT_CREDENTIAL` and the new value in `SIGNER_CLIENT_CREDENTIAL_NEXT`. After this start, either value authenticates. The old value is still accepted.
3. Give the API process the new value and restart the API. The API then presents the new credential.
4. Stop the signer. Start it with only the new value in `SIGNER_CLIENT_CREDENTIAL`. Leave the next variable unset. The old value then receives `401`.

A second signer process can keep serving the old credential while the first restarts onto both values. Each process that changes its environment still restarts. Do not describe that as zero downtime.

Recovery: if the new process fails its startup checks, start it again with the last environment that started. If the old credential was removed before the API moved, start the signer again with both values. While the signer is stopped, it mints nothing.

Compromise is immediate. Start the signer without the stolen value. Calls fail closed until the API process has the replacement. Do not keep the stolen value in the overlap set.

## HMAC signing-key rotation

This signer holds one key id and one 32-byte key. It has no second HMAC slot. When one process restarts onto a new key, that process stops minting the old key at the same moment. One process cannot accept the new key before it drops the old key. This is not zero-downtime rotation.

The database accepts a key only after an operator inserts it. One signer process holds one key, so overlap uses the old process and the new process.

1. Generate a new 32-byte key and a new key id. Keep both outside the API environment.
2. As `nyuma_fn_identity`, insert the new id, the 32 octets, and state `active`. Do this before any signer mints that id.
3. Start a signer with `ASSERTION_KEY_ID` and exactly one of `ASSERTION_HMAC_KEY` or `ASSERTION_HMAC_KEY_FILE` pointed at the new material. Leave the old process minting the old key until this start succeeds. If the new process fails its checks, stop it and start it again with the old material.
4. Stop the old signer. When every signer mints only the new key, set the old row to `retiring`. Leave its secret in place. `active` and `retiring` both verify. A signer must not mint a `retiring` key.
5. Wait 180 seconds from that update. Then set the old row to `retired` and set its secret to null. `retired` and unknown ids return null.

Emergency revocation does not wait and does not pass through `retiring`. Set that row to `retired`, clear its secret immediately, and restart every signer that still holds the key.

A key file is read only after its permissions pass. On Windows an allow entry may grant file-content read to the current account, `NT AUTHORITY\SYSTEM` (`S-1-5-18`), and `BUILTIN\Administrators` (`S-1-5-32-544`). Inherited entries are judged by that same rule. An inherited grant does not become safe, and it is not ignored. Any other reader, an identity that cannot be translated to a SID, an empty ACL, an ACE type other than Allow or Deny, a permission bit the checker does not recognize, a symlink or other reparse point, or a failed ACL query stops startup before the file contents are used. A Deny entry does not grant read and does not cancel an Allow. On Unix, group or world permission does the same. Administrators, and Unix root, can still read a file they take ownership of. That residual is the same limit as mode `0600`.

The permission check and the read are separate. The signer does not hold a file handle or a lock from one to the other. After the check returns, `readFileSync` opens the path again. A local writer who can replace the file, change its bytes, or change its ACL in that gap changes what is loaded. Rejecting a symlink at check time has the same gap if the path is replaced afterward. This race is not eliminated.

Emergency replacement of the signer process does not wait 180 seconds. Stop the process and start it without the compromised key. The database row for that key is set to `retired` with a null secret at the same time, as the emergency step above describes.

## API identity mode

`NYUMA_IDENTITY_MODE` is required for API startup. Startup fails when it is missing or set to any other value. `NODE_ENV` does not select a mode. The API does not choose the raw-bearer path because a signer credential is absent.

`signer` requires `SIGNER_CLIENT_CREDENTIAL`. The API calls `POST http://127.0.0.1:8791/assertions` with the original access token. The body is `{ "token": "<access token>" }`. The signer returns the `nya1` wire string. The API writes that string with `set_config('nyuma.access_token', <assertion>, true)` before the transaction work. A retry after `40P01` or `40001` rolls back, calls the signer again, and begins a new transaction. Commit, rollback, and `RESET nyuma.access_token` before pool release drop the setting. If the signer is unavailable, rejects the token, times out, or returns an invalid wire, the API throws before the database callback and does not write the access token. A caller-supplied assertion is not accepted.

`local-hs256-test` writes the original access token into the same transaction-local setting and does not call the signer. PostgreSQL accepts that bearer only when `nyuma_private.verifier_config.local_hs256_enabled` is true. The migration sets that flag to false. `nyuma_api` cannot read or change it. An operator changes it with `SET ROLE nyuma_fn_identity`. A row in `local_test_hmac_keys` does not turn the branch on. This mode exists for local PostgreSQL HS256 tests and local development. It is not production-safe. The API accepts the mode only when `NODE_ENV` is exactly `test` or `development`. An unset, empty, `production`, or any other value rejects it. Production also rejects startup when the mode or the signer credential is missing. A credential left in the environment does not switch this mode to the signer, and it does not enable the database flag.

The migration command reads `DATABASE_URL` through `loadMigrationConfig`. It does not require `NYUMA_IDENTITY_MODE` or `NODE_ENV`. That split does not relax API startup.

`nyuma_verified_sub()` verifies a value that starts with `nya1` as an assertion. It reads `nyuma_private.assertion_keys`, checks HMAC-SHA256 with `nyuma_private.hmac`, and returns the subject only when the key is `active` or `retiring`, the MAC matches, and the time rules pass. A failed `nya1` value returns null and is not checked as an HS256 bearer. Any other value uses the local HS256 test path only when `local_hs256_enabled` is true. A missing configuration row fails closed.

The migration creates the key table and inserts no key. The operator, as `nyuma_fn_identity`, inserts a 32-byte secret with state `active` before any signer mints that id. `nyuma_api` cannot read or change the table. Normal rotation inserts the new key as `active`, restarts signers onto it, marks the old key `retiring`, waits 180 seconds, then sets the old key `retired` and clears its secret. Emergency revocation sets `retired` and clears the secret immediately. `active` and `retiring` verify. `retired` and unknown ids return null. This local result does not prove a hosted Supabase database.

The server test runner selects `local-hs256-test` for the process before the suite. That selection is the test harness. It is not the API default.

## UUID letters

The API pattern in `server/src/auth/tokens.ts` and the signer pattern both require lowercase hexadecimal. Uppercase and mixed-case subjects are rejected. Neither side lowercases `sub`. A verified API subject is the exact string from the token. The `nya1` subject must already be lowercase.
