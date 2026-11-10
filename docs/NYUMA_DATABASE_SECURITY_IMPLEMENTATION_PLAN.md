# Nyuma database security implementation plan

Milestone 15.5.2A. Planning only. No migration, role, grant, function, policy, source file, or database row was changed.

This plan starts from `docs/NYUMA_DATABASE_SECURITY_AUDIT.md` and was checked against the migrations, pools, token verifier, coordination store, and the local PostgreSQL 18.4 catalog. Facts, assumptions, and recommendations are marked as such.

## Recommendation

Do not enable row-level security until PostgreSQL can verify a bearer token without holding the signing secret, and until the quantity triggers read child rows through a constrained function owner rather than through the caller's visible rows.

The identity value stored for a request is the access token, transaction-local, and cleared before the connection returns to the pool. Policies and privileged functions call a verifier. They do not call `current_setting('app.user_id')` or any other application-supplied account id.

There is a gate in front of that design. The local PostgreSQL 18.4 server can install `pgcrypto` 1.4. That extension can verify HMAC-SHA256. It cannot verify the ES256 or RS256 signatures used by current Supabase projects. No JWT extension is shipped with this server. Stage E does not start until a reviewed verifier for the production algorithm is chosen. A custom user-id setting is not that verifier.

## 1. What was rechecked

### Verified against current code

The audit's description of the running design still matches the repository.

- Migrations `000` through `004` are the full set. None enables RLS or creates a policy.
- `nyuma_app` is `NOLOGIN NOINHERIT`. The API is specified as a separate login that inherits it (`.env.example`). The local database still has no such login role.
- Identity and coordination each use `pg.Pool` with `max: 4`. Checkout sets `statement_timeout` and calls `assertApplicationRole`. It does not set a token, a user id, or `SET ROLE`, and it does not reset the session before `release()`.
- `runTransaction` is `BEGIN` / work / `COMMIT`, with `ROLLBACK` on failure. It retries only `40P01` and `40001`. It opens a new transaction on each attempt. There is no `SAVEPOINT` and no nested transaction helper. Identity bootstrap uses its own `BEGIN` / `COMMIT` and is not wrapped by `runTransaction`.
- Reads of listings, requirements, agreements, purchases, outcomes, and accounts are often outside any transaction.
- `server/src/auth/tokens.ts` verifies the bearer token before `users.id` is used. Integration tests and `auth.test.ts` fix the check as issuer `{origin}/auth/v1`, audience `authenticated`, expiry, and a UUID `sub`. `service_role` and `anon` role claims are rejected. ES256 is tested with a generated public key. HS256 is tested with a test secret. A wrong key, issuer, audience, or expiry fails.
- `.env.example` leaves `SUPABASE_JWT_SECRET` empty and says current projects use ES256 or RS256 from the project JWKS. Legacy projects use HS256 and that secret. `SUPABASE_SERVICE_ROLE_KEY` is rejected by `loadConfig`.
- The coordination store writes `owner_id` and `buyer_id` from the account already resolved in the API. `partySql` allows the listing owner only when that account holds farmer or trader, or the requirement buyer only when that account holds buyer. Administrator is not a branch. Outcome notes are returned to the client only when `owns_listing` is true (`toOutcome`). The SQL `SELECT` still reads the notes column.
- `nyuma_set_commitment_status`, `nyuma_insert_purchase`, `nyuma_set_active_role`, `nyuma_clear_active_role`, and the lock functions are `SECURITY DEFINER`, owned by the migration superuser on the local cluster, and executable by `nyuma_app`. Their arguments are ids. They do not verify a token.
- Quantity helpers (`nyuma_listing_held_grams`, `nyuma_listing_accounted_grams`, `nyuma_demand_held_grams`, and the assert functions) are `SECURITY INVOKER`.

### Verified again on the local cluster

The cluster at `C:\Users\HP\AppData\Local\Temp\nyuma-pg-11b1` was started on `127.0.0.1:5433`, queried, and stopped. No grant or row was committed.

- Server: PostgreSQL 18.4, same build recorded in the audit.
- `pgcrypto` 1.4 is available and not installed. `pg_proc` has no `hmac`, `digest`, or signature-verify function.
- Available extension names matching crypto, JWT, sodium, Python, Perl, or SSL do not include a JWT verifier. `plpython3u` is available and not installed. It is an untrusted language and is not a candidate.
- After `SET LOCAL ROLE nyuma_app` inside a read-only transaction, `set_config('nyuma.user_id', '<uuid>', true)` succeeded and `current_setting` returned that uuid. The transaction was rolled back. This is the concrete demonstration that a custom setting is not an identity boundary for the application role.

### Assumptions

- No live Supabase project exists in this workspace. The JWKS document, the active `kid`, the access-token lifetime, and the hosted extension allow-list were not fetched. Issuer, audience, and algorithms below are the rules already implemented and tested in this repository, plus the comments in `.env.example`.
- Supabase's current hosted projects sign access tokens with an asymmetric key and publish the public key at `{SUPABASE_URL}/auth/v1/.well-known/jwks.json`. That is what `tokens.ts` and `.env.example` say. It was not observed on a live project.
- A hosted project owner can create `NOLOGIN` roles and transfer ownership. That was not tried.
- Supabase access tokens are commonly valid for about an hour. The implementation must read `exp` from the token. It must not hard-code an hour.

## 2. Identity verification

### What the database must establish

For an API request, PostgreSQL must derive `users.id` from a bearer token it verifies itself. The application may pass that token. It must not pass `users.id`, `auth_user_id`, or a role as the value the policies trust.

`nyuma_verified_sub()` returns the token `sub` or null. `nyuma_verified_account_id()` returns `users.id` only when that `sub` matches `users.auth_user_id` and `users.status` is `active`. A separate `nyuma_account_status()` may return the status for that same `sub` when the account is suspended or deactivated, so the API can still answer `account-disabled` instead of pretending the account does not exist. Neither function accepts an account id argument.

### Token rules to implement in both places

Match the current verifier, and tighten one claim when the database verifier is added:

| Check | Current API | Database verifier |
| --- | --- | --- |
| Algorithm | HS256 if `SUPABASE_JWT_SECRET` is set; otherwise ES256 or RS256 from JWKS. `none` and other algorithms fail | Production: ES256 or RS256 only, selected by the token header `alg` and `kid`. HS256 is not accepted in production |
| Issuer | `{SUPABASE_URL}/auth/v1` | Same |
| Audience | `authenticated` | Same |
| Expiry | `exp` required by `jose`, no extra leeway in the Nyuma wrapper | `exp` must be strictly after `clock_timestamp()`. No leeway |
| Subject | UUID matching the existing auth-user pattern | Same pattern, then a lookup in `users` |
| Role claim | `role` must be the string `authenticated`. A missing claim, `anon`, `service_role`, or any other value is rejected | Same. `payload->>'role'` must be `authenticated` |
| `nbf`, when present | Left to `jose` | Reject when `nbf` is after now |

The signing secret is not stored in the database for production. The private key never is. `nyuma_private.jwt_public_keys` holds public JWK material, `kid`, `alg`, and a retirement time. `nyuma_app` has no privilege on that schema. Unknown `kid`, wrong algorithm, or a failed signature returns null. It does not raise a raw crypto error to the client.

Key rotation, once a live JWKS exists: insert the new public key before it is used, keep the previous public key until every token it signed has passed `exp`, then delete it. Do not fetch JWKS from inside a request. A migration or an operator job copies public keys in. The database does not need outbound network access to verify a token.

### Why this server cannot verify ES256 today

`pgcrypto` provides `hmac()` and `digest()` after it is installed. Those can check an HS256 signature, and only if the signing secret is in the database. They do not check an ES256 or RS256 JWS. Installing `plpython3u` to import a JWT library would place an untrusted language in the database. That is rejected.

Local integration tests may install `pgcrypto` and verify HS256 with a test secret that exists only in `nyuma_private` on the local cluster. That proves the SQL, the pool reset, and the policies. It is not the production algorithm. Production stage E stays closed until one of these is true:

1. A reviewed extension, pinned by version, verifies ES256 and RS256 from a public JWK on both this Windows PostgreSQL 18.4 build and the future hosted database, or
2. The project explicitly chooses a different production signing setup that still keeps the signing secret out of `nyuma_app`'s reach and out of the API process.

There is no third option in this plan. In particular, the implementation must not fall back to `set_config('nyuma.user_id', ...)`.

### Attack results the design has to produce

| Event | Required result |
| --- | --- |
| Caller sends another account's UUID in a body, a SQL argument, or `set_config('nyuma.user_id', ...)` | Ignored. Visibility and writes follow the verified token, or fail closed when no token verifies |
| Caller changes any custom PostgreSQL setting | Same. Settings are not identity. The token setting can be changed, and a forged or unsigned value fails verification |
| Shared API database password is stolen, and the thief has no user token | Connection succeeds as `nyuma_api`. Account-scoped tables return no rows. Privileged functions return null or raise insufficient privilege. Open market rows, if exposed, do not include owner or buyer ids |
| A valid user's bearer token is stolen | The thief can act as that user until `exp`. This is the same capability the token already has through the API. Revocation before `exp` is not provided by this design |
| Token expires while a pooled connection is still checked out | The next statement rechecks `exp`. `STABLE` may cache the result inside one statement, not across statements. The following statement fails closed |
| Token was valid for request A, and the connection is reused for request B | Request B does not see request A's token. The checkout protocol below is what makes that true |

## 3. Role and privilege matrix

Attributes below are the target. "Verified now" is the local catalog. Everything else is the recommendation.

| Role | Login | Superuser | BYPASSRLS | Inherit | Memberships | Owns | Schema | Tables | Execute |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `nyuma_owner` | LOGIN | no | no | no | none of the API or operator roles. Not a member of `nyuma_app` | All Nyuma tables after stage A. Invoker helpers that do not need hidden rows | `CREATE` and `USAGE` on `public`. `USAGE` on `nyuma_private` is not required | Full owner rights. Subject to RLS after `FORCE`, so this login is a poor place to read coordination rows | Migration objects only |
| `nyuma_api` | LOGIN | no | no | yes | `nyuma_app` only | nothing | `USAGE` on `public` only | Only through `nyuma_app` grants and, later, views | Only through `nyuma_app` |
| `nyuma_app` | NOLOGIN | no | no | no | none | nothing | `USAGE` on `public`. No `CREATE` | See stage D. No direct `SELECT` on base coordination tables after stage E | Verifier, own-row RPCs that recheck the token, and trigger functions they must fire. Not approve, revoke, grant, or private lock helpers |
| `nyuma_fn_identity` | NOLOGIN | no | no | no | none. Nobody grants this to `nyuma_api` | `nyuma_verified_sub`, `nyuma_verified_account_id`, `nyuma_account_status`. Reads `nyuma_private` | `USAGE` on `nyuma_private` and `public` | `SELECT` on `users` and `user_roles` as this role, bounded by the policy clause for this role | Not granted to `PUBLIC` |
| `nyuma_fn_constraint` | NOLOGIN | no | yes | no | none. Nobody grants this to `nyuma_api` | Quantity, lock, agreement-status, purchase, workspace, and the triggers that must see another party's rows | `USAGE` on `public` | The DML those functions perform. Not a login path | `EXECUTE` granted to `nyuma_app` only for the functions the API or a trigger must call |
| `nyuma_provisioner` | NOLOGIN | no | no | no | granted only to the migration owner, without giving that membership to `nyuma_api` | no change | `USAGE` on `public` | `SELECT`, `INSERT`, `DELETE` on `user_roles`, as today | `nyuma_grant_administrator` only |
| `nyuma_operator` | NOLOGIN | no | no | no | operator logins created outside the API, `WITH ADMIN OPTION` held by the migration owner | no | `USAGE` on `public` | `SELECT` on the role tables it can read today | approve, reject, revoke |
| `nyuma_fn_request` | NOLOGIN | no | no | no | migration owner only | submit and list functions | `USAGE` on `public` | `SELECT` and `INSERT` on `role_requests`, `SELECT` on `users` and `user_roles` | not executable by `nyuma_api` except the two functions, which compare the argument with the verified `sub` |
| `nyuma_fn_approve` | NOLOGIN | no | no | no | migration owner only | approve function | `USAGE` | `SELECT` and `UPDATE` on `role_requests`, `SELECT` and `INSERT` on `user_roles`, `SELECT` on `users` | `nyuma_operator` only |
| `nyuma_fn_reject` | NOLOGIN | no | no | no | migration owner only | reject function | `USAGE` | `SELECT` and `UPDATE` on `role_requests`, `SELECT` on `users` | `nyuma_operator` only |
| `nyuma_fn_revoke` | NOLOGIN | no | no | no | migration owner only | revoke function | `USAGE` | `DELETE` on `user_roles`, `INSERT` on `role_revocations`, `SELECT` on `users` and `user_roles` | `nyuma_operator` only |

`BYPASSRLS` is confined to `nyuma_fn_constraint`. It is not given to `nyuma_owner` or `nyuma_api`. The reason is the quantity cap. If those functions merely ran under the caller's RLS policy, a missing or narrow policy would hide another participant's commitment and the cap would allow too much quantity. A policy clause of the form `current_user = 'nyuma_fn_constraint'` has the same fail-open result when the clause is forgotten. `BYPASSRLS` on a `NOLOGIN` role that the API cannot assume keeps the sum complete. The function body still has to decide whether the verified account may cause the write. Seeing rows is not permission to return them.

`assertApplicationRole` gains three rejections: `rolbypassrls`, `rolcreaterole`, and `rolcreatedb`. It also rejects membership of `nyuma_owner`, `nyuma_fn_identity`, `nyuma_fn_constraint`, and the existing provisioner, operator, and function-owner roles. A superuser remains rejected.

The migration owner is the only login used in `DATABASE_URL`. `APP_DATABASE_URL` is `nyuma_api` and no other role. The API process must not receive the owner password, the provisioner, or an operator login.

`SET ROLE` from `nyuma_api` to `nyuma_owner`, `nyuma_provisioner`, `nyuma_operator`, `nyuma_fn_identity`, `nyuma_fn_constraint`, or any `nyuma_fn_*` role must fail. The local superuser can still `SET ROLE` after `SET LOCAL ROLE nyuma_app`, because `SET ROLE` follows the session user. Tests for this rule connect as `nyuma_api`, not as the superuser.

## 4. Function plan

Current owner and mode are from the local catalog and the migrations. Future owner is the recommendation.

| Function | Now | Future owner and mode | Identity check | Hidden rows | Execute after the change |
| --- | --- | --- | --- | --- | --- |
| `nyuma_verified_sub` | does not exist | `nyuma_fn_identity`, definer, `search_path = pg_catalog, nyuma_private` | Verifies the token in `nyuma.access_token`. No account argument | Reads keys only | `nyuma_app` |
| `nyuma_verified_account_id` | does not exist | `nyuma_fn_identity`, definer | Active user for that `sub` only | Reads `users` as the identity role | `nyuma_app` |
| `nyuma_account_status` | does not exist | `nyuma_fn_identity`, definer | Same `sub`, including suspended and deactivated. Returns no other account | Reads one user row | `nyuma_app` |
| `nyuma_lock_user` | superuser, definer | `nyuma_fn_constraint`, definer | Locks `nyuma_verified_account_id()` only. If the argument is present and differs, raise. Do not report whether another id exists | Yes, its own lookup | `nyuma_app` |
| `nyuma_lock_listing`, `nyuma_lock_demand`, `nyuma_lock_for_commitment`, `nyuma_lock_for_purchase`, `nyuma_lock_for_outcome` | superuser, definer | `nyuma_fn_constraint`, definer | No public account argument. Caller must already be inside a constraint function that checked participation or ownership. A direct call from `nyuma_app` is revoked | Yes | `nyuma_fn_constraint` only |
| `nyuma_set_commitment_status` | superuser, definer | `nyuma_fn_constraint`, definer | Verified account is a participant and holds farmer, trader, or buyer. Ignore any extra id if one is ever passed | Yes, for the lock order | `nyuma_app` |
| `nyuma_insert_purchase` | superuser, definer | `nyuma_fn_constraint`, definer | Same participant rule. Listing id must be the commitment's listing. No caller-chosen owner | Yes | `nyuma_app` |
| `nyuma_set_active_role` | superuser, definer | `nyuma_fn_constraint`, definer | User id comes from the verified account. Argument is the role name. Reject a user-id argument that does not match | Updates `users` despite the revoke on `nyuma_app` | `nyuma_app` |
| `nyuma_clear_active_role` | superuser, definer | `nyuma_fn_revoke`, definer | Not an end-user token path. Only the revoke function calls it | Updates one user | `nyuma_fn_revoke`. Revoke from `nyuma_app` |
| `nyuma_set_commitment_status` and purchase insert keep today's status and quantity triggers | those triggers | see trigger rows | The definer does not replace the state machine | | |
| `nyuma_submit_role_requests`, `nyuma_list_role_requests` | `nyuma_fn_request`, definer | same owner, definer | `p_auth_user_id` must equal the verified `sub`. A stolen credential cannot file or list another account's requests | Reads that account's request rows | `nyuma_app` |
| `nyuma_approve_role_request`, `nyuma_reject_role_request`, `nyuma_revoke_ordinary_role` | their function owners, definer | unchanged owners | Keep `pg_has_role(session_user, 'nyuma_operator', 'MEMBER')`. No end-user id argument is trusted | Role tables through the existing owner grants. Policies must allow these owners | `nyuma_operator` only |
| `nyuma_grant_administrator` | superuser, invoker | `nyuma_owner`, invoker | Remains `pg_has_role(current_user, 'nyuma_provisioner', 'MEMBER')` and `SET ROLE nyuma_provisioner` | No | `nyuma_provisioner` only |
| `nyuma_listing_held_grams`, `nyuma_listing_accounted_grams`, `nyuma_listing_outcome_grams`, `nyuma_demand_held_grams`, `nyuma_assert_*` | superuser, invoker | `nyuma_fn_constraint`, definer | Not called by the API. They return totals, so `EXECUTE` is not granted to `nyuma_app`. Trigger functions call them | Yes, all child rows of the listing or requirement | `nyuma_fn_constraint` |
| `nyuma_listings_check`, `nyuma_demands_check`, `nyuma_commitments_check`, `nyuma_purchases_check`, `nyuma_outcomes_check` | superuser, invoker triggers | `nyuma_fn_constraint`, definer triggers | The triggering write was already allowed by RLS or by a checked definer. The check sums every child row | Yes | `nyuma_app`, because the invoker must be allowed to fire the trigger |
| `nyuma_commitments_guard`, `nyuma_purchases_guard`, `nyuma_outcomes_guard` | superuser, invoker | `nyuma_fn_constraint`, definer | Same business rules as today. They read the other party's listing, requirement, or purchase | Yes | `nyuma_app` |
| `nyuma_listings_guard`, `nyuma_demands_guard`, `nyuma_users_guard` | superuser, invoker | stay invoker after RLS, owner `nyuma_owner` | They check the row being written and the verified account's own roles. They do not sum other accounts' commercial rows | Own `user_roles` row is visible under the user policy | `nyuma_app` |
| `nyuma_guard_role_removal` | superuser, invoker | `nyuma_fn_constraint`, definer | Still refuses administrator removal unless the session is the provisioner, and still refuses removal while listings or requirements exist | Yes, that account's listings and requirements | `nyuma_fn_revoke` |
| `nyuma_guard_administrator_role`, `nyuma_user_roles_no_update` | superuser, invoker | stay invoker, owner `nyuma_owner` | Catalog membership, not a token | No | fire rights for the role writers |
| `nyuma_claim_coordination_id`, `nyuma_release_coordination_id` | superuser, invoker | `nyuma_fn_constraint`, definer | Id registry only | Writes `coordination_ids` | `nyuma_app` must be able to fire them, or the parent trigger is the only definer and these stay internal |
| `nyuma_grams`, `nyuma_is_time_compatible` | superuser, invoker | `nyuma_owner`, invoker | None. Pure functions | No | `nyuma_app` |
| Role-request and revocation guard triggers | their owners, invoker | unchanged | Unchanged | Their own tables | the function owners that write those tables |

A definer owned by a non-superuser is still a bypass if it trusts a caller-supplied account id, if `nyuma_app` can `SET ROLE` to its owner, or if it returns rows the caller should not see. The execute column is part of the control. Lock helpers that reveal existence stay off `nyuma_app`.

`search_path` for every definer remains `pg_catalog` plus the one application schema it needs. No definer keeps a caller-controlled `search_path`.

## 5. RLS and trigger compatibility

Enable and force RLS in stage E, after stages B and C pass. Policies are written for `nyuma_api` / `nyuma_app`. The constraint role does not depend on them for sums, because it has `BYPASSRLS`.

Forcing RLS makes `nyuma_owner` subject to policies. Do not use the owner login to decide whether a user can see a row.

### Base-table policies

`users`

- `SELECT` / `UPDATE`: `id = nyuma_verified_account_id()` for an active account.
- `nyuma_account_status()` is definer and may read the row for the verified `sub` even when the status is not active. The policy used by ordinary SQL does not.
- `INSERT`: `auth_user_id` equals `nyuma_verified_sub()`, status is `active`, and `active_role` is null. Bootstrap of a new account still works. Bootstrap of a suspended account does not create a second row.
- No policy branch mentions `administrator`.

`user_roles`

- `SELECT`: `user_id = nyuma_verified_account_id()`.
- No `INSERT`, `UPDATE`, or `DELETE` policy for `nyuma_app`. Writers remain the provisioner, approve, and revoke owners. Their policies allow `current_user` in `nyuma_fn_approve`, `nyuma_fn_revoke`, and `nyuma_provisioner` only. That is role administration, not coordination access.

`profiles`

- `USING (false)` and `WITH CHECK (false)` for `nyuma_app`. The table is unused. A later profile milestone replaces this policy. Do not leave the current table-wide grant in place once RLS is on.

`listings`

- Owner path: `owner_id = nyuma_verified_account_id()` and the account holds farmer or trader.
- Market path, `SELECT` only: `status = 'open' AND origin = 'live'`.
- `INSERT` and `UPDATE`: owner path only. `WITH CHECK` repeats it so a row cannot be moved to another owner.
- `DELETE`: owner path, and only when no commitment references the listing. The foreign key remains the backstop.

`buyer_demands`

- Same shape, with `buyer_id` and the buyer role.
- Market `SELECT`: open and live.

`commitments`, `purchases`, `outcomes`

- Do not express "the other party's listing" as a policy subquery on `listings` or `buyer_demands`. Under RLS that subquery can recurse and can also hide a closed listing that a participant must still see.
- Base-table policies for `nyuma_app` are fail-closed: `USING (false)` if direct `SELECT` remains, or `SELECT` is revoked and the views below are the only read path.
- `INSERT` on `commitments` and `outcomes` stays on the base table, `WITH CHECK` calling `nyuma_fn_constraint` functions that apply today's participant and owner rules and return boolean. Those functions are definers, so they see the other party's row without opening a policy cycle.
- `UPDATE` on `commitments` stays revoked. Status changes remain `nyuma_set_commitment_status`.
- `INSERT` on `purchases` stays inside `nyuma_insert_purchase`.
- `DELETE` on commitments, purchases, and outcomes stays revoked. Triggers already reject those deletes.

`coordination_ids`, `role_requests`, `role_revocations`, `schema_migrations`

- No policy grants `nyuma_app` access. Request rows are reached only through the submit and list functions after the `sub` check. `schema_migrations` stays owner-only.

### Views that hide columns

RLS cannot null one column for one reader and reveal it for another. Notes and hidden party ids need views.

| View | Rows | Columns removed or nulled | Grant |
| --- | --- | --- | --- |
| `own_listings` | verified owner | none of the owner's own fields | `SELECT` to `nyuma_app` |
| `market_listings` | open and live | `owner_id` absent | `SELECT` to `nyuma_app` |
| `own_requirements` | verified buyer | none of the buyer's own fields | `SELECT` to `nyuma_app` |
| `market_requirements` | open and live | `buyer_id` absent | `SELECT` to `nyuma_app` |
| `participant_agreements` | verified participant | no account ids beyond the rows the API already returns | `SELECT` to `nyuma_app` |
| `participant_purchases` | verified participant | same | `SELECT` to `nyuma_app` |
| `visible_outcomes` | listing owner with farmer or trader, or a buyer for a sold outcome tied to that buyer's purchase | `notes` is null unless the verified account owns the listing | `SELECT` to `nyuma_app` |

The views are owned by `nyuma_fn_constraint` and defined with `security_invoker = false`, so the join runs with the constraint role's ability to see both parties and the `WHERE` clause applies the participant rule. `security_barrier` is on. A view that selected every column of the base table and relied on the caller's RLS would bring back the recursion problem.

The API store changes, in the implementation milestone, read these views instead of the base tables. Writes still use the checked functions and base-table `INSERT` / `UPDATE` policies. That store change is not part of 15.5.2A.

### What stays true

- A farmer or trader sees and edits their own listings, including drafts.
- A buyer sees and edits their own requirements.
- Another account's draft, closed, or withdrawn listing is invisible.
- An open live listing is visible on the market without its owner id.
- An agreement or purchase is visible only to a participant, using the same farmer-or-trader owner test and buyer test as `partySql`.
- A buyer does not insert an outcome. The insert check requires the verified account to own the listing and hold farmer or trader.
- A buyer select of a sold outcome does not include notes.
- Administrator does not appear in any coordination policy or view.

### Trigger interaction

Invoker triggers run as `nyuma_api`. After RLS, an invoker `SELECT` of all commitments on a listing sees only the caller's visible commitments. `nyuma_listings_check` and the other quantity triggers therefore become definers owned by `nyuma_fn_constraint` before RLS is forced. The lock order is unchanged: user, listing, requirement, commitment.

If those triggers are left as invokers, a two-party agreement can under-count held quantity. That failure has to be caught by the quantity test in stage E, before `FORCE`.

## 6. Pool and transaction context

The current helper needs a redesign. Adding `set_config` beside the existing calls is not enough, because many reads never call `runTransaction`, and a retry opens a transaction in which a local setting from the previous attempt is gone.

### Checkout protocol

Both pools use one helper.

```text
checkout
  RESET nyuma.access_token
  assertApplicationRole
  SET statement_timeout = '15s'
  BEGIN
  SELECT set_config('nyuma.access_token', token, true)
  work
  COMMIT
on any error
  ROLLBACK
finally
  RESET nyuma.access_token
  release
```

`set_config` uses the local flag `true`, so the value dies at `COMMIT` or `ROLLBACK`. `RESET` in `finally` covers a bug that sets the value for the session. The reset also runs when `BEGIN` never happened.

`runTransaction` takes the token and applies `set_config` again at the start of every attempt, after its own `BEGIN`. It does not call `BEGIN` if the helper already opened the transaction. One request has one transaction. There are no savepoints in this design. A deadlock retry is a new transaction and a new `set_config`.

The token value is the raw bearer token. It is not written to a log, a migration, or an error message. `statement_timeout` is not identity and may remain session-level.

A missing token is an empty setting. Verifiers return null. Coordination policies then hide account rows. The HTTP layer still rejects a missing bearer before it borrows a connection. The database check is the backstop when the pool is used directly.

### Lifetime

| Boundary | Token state |
| --- | --- |
| `COMMIT` or `ROLLBACK` | Transaction-local value is discarded |
| Exception before `finally` | `finally` still resets and releases |
| Next checkout of the same connection | Starts with `RESET`. A missing reset is a failed adversarial test |
| Token expiry mid-request | Later statements in that transaction see a null account. The request fails closed. The connection is still reset |
| Two pools | Each connection carries only the token given to that checkout. Identity does not cross pools except by the application passing the same token on purpose |

## 7. Staged migrations

These are separate migrations. Each file is transactional except where it must create a role. Role creation stays in a `nyuma:no-transaction` file, as migration `000` and `003` already do. Do not put RLS in the role-creation file. Stages A, B, and C are written. Stages D–G are not.

Deploy the API build that uses the new checkout helper before stage C. Leave the API stopped across stage E.

### Stage A. Non-superuser owners

Objects: `nyuma_owner`, `nyuma_api`, `nyuma_fn_identity`, `nyuma_fn_constraint`. Ownership of existing tables and functions moves off the superuser. No policy. No grant revoke yet. No function body change.

Preconditions: current migrations applied. API stopped or still on the old login. A password for `nyuma_owner` and `nyuma_api` exists outside git.

Expected permissions: `nyuma_api` inherits `nyuma_app` and fails `SET ROLE` to the owner, provisioner, operator, and function roles. `pg_proc.proowner` for `nyuma_set_commitment_status` and `nyuma_insert_purchase` is not a superuser. `rolbypassrls` is true only for `nyuma_fn_constraint`.

Tests: catalog assertions as the superuser, then a connection as `nyuma_api` that can still complete one current listing read. Behavior is unchanged because RLS is off and function bodies are unchanged.

Failure: any API connection still using the superuser, or `assertApplicationRole` rejecting `nyuma_api`.

Rollback: `server/migrations/rollback/005_stage_a_rollback.sql` drops the four new roles only when `006_stage_a_ownership.sql` is not recorded. Once ownership has moved, leave it with `nyuma_owner`. Restoring superuser ownership is not the rollback. Do not drop roles that already own objects. Keep `nyuma_owner` as the owner if a later stage fails.

Files: `server/migrations/005_stage_a_roles.sql` and `server/migrations/006_stage_a_ownership.sql`. No password is stored in either file. `nyuma_owner` is granted membership in the operator and function-owner roles, including `nyuma_fn_constraint`, so a later non-superuser migration can assign ownership. That membership does not confer `BYPASSRLS`. `nyuma_api` is not a member of those roles.

Maintenance window: short. `ALTER OWNER` takes locks. Stop the API for the ownership move.

### Stage B. Verifier and checkout helper

Objects: schema `nyuma_private`, public-key table, verifier functions, `pgcrypto` only if the local HS256 test path is included. API helper from section 6. Existing coordination functions are not switched yet.

Preconditions: stage A. A test keypair or local HS256 test secret is installed in `nyuma_private`. Production ES256 remains gated. `nyuma_app` has no grant on `nyuma_private`.

Expected permissions: `nyuma_verified_sub()` returns the test subject for a good token and null for a bad signature, wrong issuer, wrong audience, expired token, `service_role`, `anon`, and a substituted `nyuma.user_id`. Direct `SELECT` of the key table as `nyuma_api` fails.

Tests: the six token failures above, plus pool reuse with `max: 1`. Two sequential checkouts must not share a token. This stage can use HS256 locally and must say so in the test output. It does not claim ES256 is solved.

Failure: verifier accepts a token signed by another key, or a session-level setting survives `release()`.

Rollback: `server/migrations/rollback/007_stage_b_rollback.sql` drops the verifier functions, `pgcrypto`, and `nyuma_private` when no later migration is recorded. Revert the pool helper in the same change. Coordination function bodies stay as they were. Restoring a superuser-owned verifier is not the rollback.

Files: `server/migrations/007_stage_b_identity.sql`, `server/src/db/session.ts`. A request that presents a bearer token stores that token for the current transaction. A request without one stores an empty value. `nyuma_verified_sub()` reads only `nyuma.access_token`. Stage C functions consult it. Production ES256 and RS256 verification stays disabled: this PostgreSQL build's `pgcrypto` 1.4 can check HMAC-SHA256 and cannot check those signatures, and no JWT extension is installed. A local HS256 secret is inserted by the integration test, not by the migration.

Maintenance window: none if the helper is deployed while old functions ignore the token. Do not revoke grants in this stage.

### Stage C. Privileged functions check the verified account

Implemented in `server/migrations/008_stage_c_functions.sql`. Rollback is `server/migrations/rollback/008_stage_c_rollback.sql`. This stage does not enable or force row-level security.

Objects: bodies and owners listed in section 4. Trigger functions that sum child rows are `SECURITY DEFINER` owned by `nyuma_fn_constraint`. Changing the owner alone does not change an invoker's execution identity, so the migration sets `SECURITY DEFINER` explicitly. Lock helpers that are existence oracles lose `EXECUTE` from `nyuma_app`.

Direct `INSERT` and `UPDATE` by `nyuma_app` on coordination tables remain until Stages D and E. Those statements still fire the quantity triggers, so a quantity cap cannot be skipped by avoiding the privileged function. The caller's account is not enforced on those direct statements until row-level security exists. `nyuma_api` is not a member of `nyuma_fn_constraint` and cannot `SET ROLE` to it.

Preconditions: stage B helper is the only API code running. A request without a token is already rejected by HTTP, and the database functions now also reject it.

Expected permissions: `nyuma_set_commitment_status` and `nyuma_insert_purchase` raise unless the token's account is a participant. `nyuma_set_active_role` ignores a user id that is not the verified account. Submit and list reject a different `auth_user_id`. Quantity totals still include the other participant's rows. This is tested before RLS exists, with two accounts and the function owner.

Tests: participant and non-participant status change, purchase, workspace selection, role-request `sub` mismatch, and a held-quantity case with commitments from both sides. Existing integration workflows for farmer, trader, and buyer pass.

Failure: a legitimate participant is rejected, or a non-participant succeeds, or a quantity assert under-counts.

Rollback: restore the previous function bodies from the previous migration text. Restore execute grants for the lock helpers. The private verifier can stay. Stop the API while replacing function bodies so a mixed process does not call a signature that changed.

Maintenance window: yes. Old API processes that do not set the token will fail closed, which is safe and also an outage. Deploy the helper and this migration together.

### Stage D. Revoke unused runtime grants

Objects: grants only.

Revoke from `nyuma_app`:

- `DELETE` on `commitments`, `purchases`, `outcomes`, and `users`
- `UPDATE` on `purchases`, `outcomes`, and `coordination_ids`
- `UPDATE` on `commitments` is already revoked
- all privileges on `profiles`
- `EXECUTE` on `nyuma_clear_active_role`, the private lock helpers, approve, reject, revoke, and `nyuma_grant_administrator` if any remains
- `EXECUTE` on gram and assert functions

Keep, until stage E replaces reads with views: `SELECT`, `INSERT`, and the `UPDATE` the API still issues on listings and requirements. Keep `INSERT` on commitments and outcomes until the checked functions are the only writers. Keep `SELECT` on `users` and `user_roles`.

Preconditions: stage C tests passed on the new API.

Expected permissions: a direct `UPDATE` of a purchase or `DELETE` of an outcome as `nyuma_api` is `permission denied`, not only a trigger error. Listing create, agreement create, and purchase create still work through the API.

Failure: an invoker trigger loses a privilege it still needs. The workflow test fails. Fix by granting that privilege to `nyuma_fn_constraint`, not by returning it to `nyuma_app`.

Rollback: re-grant the revoked privileges. Function bodies from stage C can stay if the API helper is still deployed.

Maintenance window: yes, together with stage C or immediately after it, with the API stopped.

### Stage E. RLS and views

Objects: policies and views from section 5. `ENABLE ROW LEVEL SECURITY`. After the tests below pass, `FORCE ROW LEVEL SECURITY`.

Preconditions: stages A through D. Verifier is the production algorithm, or this stage is explicitly still a local HS256 rehearsal and is not called production-ready. API is stopped.

Expected permissions: as `nyuma_api`, with account A's token, account B's draft listing is invisible and not updatable. Open live listings are visible without `owner_id`. Agreements and purchases follow participation. Outcome notes are null for the buyer. No token yields no account rows. `SET nyuma.user_id` does not change that. The superuser is not the connection used to claim success.

Failure: any adversarial test in section 8 fails, or a current farmer, trader, or buyer workflow fails. Do not force RLS if the unforced run fails. Leave the API stopped rather than serving an empty or leaky policy.

Rollback: `NO FORCE ROW LEVEL SECURITY`, `DISABLE ROW LEVEL SECURITY`, drop the new policies and views, restore base-table `SELECT` if it was revoked in this stage. Do not drop coordination rows. Do not return ownership to the superuser.

Maintenance window: yes. An API process that does not set the token would see empty account data if it kept serving.

### Stage F. Adversarial and workflow tests

Objects: none. This stage is the test run against stage E.

Preconditions: stage E applied on the local cluster and not forced until the unforced tests pass. Then force, and run the same tests again. Forcing changes the owner's visibility, not `nyuma_api`'s, but the second run catches a policy that only worked because the owner bypassed it.

Tests: section 8, plus the existing backend integration suite and the frontend suite so the sample workspace stays green.

Failure: any case in section 8. Fix forward with a new migration. Do not edit stage E in place after it has been applied to a shared database.

Maintenance window: the API stays stopped until this stage passes.

### Stage G. Privilege verification

Objects: none. Read-only catalog queries.

Preconditions: stage F passed after `FORCE`.

Record: role attributes, memberships, `proowner`, `prosecdef`, `relrowsecurity`, `relforcerowsecurity`, `relacl`, `has_table_privilege` and `has_function_privilege` for `nyuma_api`, and a negative `SELECT` from `nyuma_private`. Compare them with section 3. A superuser connection is used only to read the catalog, not to decide row visibility.

Failure: any attribute in section 3 is different, especially `BYPASSRLS` on `nyuma_api` or `nyuma_owner`, or `EXECUTE` on approve or grant for `nyuma_app`.

Rollback: none of its own. A mismatch returns to the failed stage's rollback.

Maintenance window: none beyond stage F. The API starts only after this catalog check.

## 8. Adversarial tests

These are PostgreSQL integration tests, the same style as `server/tests/coordination.integration.test.ts` and `server/tests/activity.integration.test.ts`. Mocks are not the evidence. The connection under test is `nyuma_api`. The migration owner creates fixture rows and is not the subject of the assertion.

1. Account A cannot `SELECT` or `UPDATE` account B's draft or closed listing, including by id.
2. Buyer A cannot `SELECT` or `UPDATE` buyer B's requirement, including by id.
3. A third account that guesses an agreement id gets no row. The listing owner and the requirement buyer still can.
4. That third account cannot insert a purchase against the agreement. `nyuma_insert_purchase` fails, and no purchase row appears.
5. A buyer token cannot insert an outcome on a listing the buyer does not own. The listing owner can. The buyer's later `SELECT` of a sold outcome has null notes, including through a direct view query rather than only through TypeScript.
6. `set_config('nyuma.user_id', <B>, true)` while holding A's token, or holding no token, does not reveal B's rows. `set_config('nyuma.access_token', '<tampered>', true)` does not verify.
7. A connection that has only the `nyuma_api` password, and no bearer token, cannot obtain another user's id by choosing a uuid. `nyuma_verified_account_id()` is null. Account tables are empty for that session.
8. `nyuma_api` cannot `EXECUTE` approve, reject, revoke, `nyuma_grant_administrator`, or the private lock helpers. `nyuma_set_commitment_status` without a verified token fails.
9. Two participants create commitments that together exceed the listing only when both are counted. Under RLS, the second write fails. A control query as the constraint role, or a returned error from the trigger, shows the full held quantity. This is the test that catches an invoker sum.
10. A pool with `max: 1` runs request A to completion, releases, then runs request B. B must not see A's rows. A variant raises inside A, rolls back, and then runs B.
11. A suspended account's token does not `SELECT` coordination rows and does not insert a listing. `nyuma_account_status()` still reports suspended so the HTTP mapping can stay `account-disabled`.
12. The sample workspace is unchanged. Frontend tests that sign in as the sample farmer still pass, and none of the new migrations reads or writes `nyuma.coordination.v1`, `nyuma.session.v1`, or `nyuma.decisionSupport.scenario.v1`. Those keys are not database objects. The database tests must not delete or import them.

Also keep the current cross-account HTTP cases. A passing HTTP test alone does not replace cases 6, 7, and 10.

## 9. Rollback principle

Each stage has its own reverse script, reviewed before that stage is applied. The scripts live beside the migrations and are not registered as forward migrations.

- Disable and unforce RLS before dropping policies.
- Restore grants before restoring old invoker trigger bodies, or the triggers fail while the reverse is half applied.
- Do not drop `users`, listings, commitments, purchases, or outcomes as a rollback.
- Leave objects owned by `nyuma_owner` unless stage A itself is being reversed and nothing later depends on it.
- Stop the API while a reverse script replaces a function the API is calling.
- A failed transactional migration already rolls back. Role-creation files do not. Their failure handling has to be written statement by statement, as `000` and `003` are.

## 10. Unresolved questions

1. Which pinned extension, if any, will verify ES256 and RS256 on this PostgreSQL 18.4 Windows build and on the future hosted database? Stage E waits on this answer. `pgcrypto` is not that extension.
2. Will the hosted project allow that extension? If it will not, in-database verification of current Supabase tokens is blocked, and this plan does not authorize a user-id setting instead.
3. The live JWKS, active `kid` values, and access-token TTL were not read. Rotation timing must be taken from that document when a project exists.
4. The API and the database both require `role` to be the string `authenticated`. That alignment is in `tokens.ts` and `nyuma_verified_sub()`. Production ES256 and RS256 verification inside PostgreSQL remains disabled.
5. Whether hosted `postgres` and `service_role` can be kept out of `APP_DATABASE_URL` is a deployment rule, not something this local catalog can prove.
6. Bulk listing reads and write rate limits are still open. They are not part of these stages.
7. `nyuma_fn_constraint` with `BYPASSRLS` is the recommended exception to an otherwise no-bypass design. If that attribute is rejected, the substitute is a fail-closed test that is treated as a release blocker, not a policy clause that silently under-counts.

## 11. Evidence for this plan

Re-read, not modified:

- `docs/NYUMA_DATABASE_SECURITY_AUDIT.md`
- `server/migrations/000_roles.sql` through `004_role_requests.sql`
- `server/src/db/client.ts`, `transaction.ts`, `applicationRole.ts`, `migrate.ts`
- `server/src/config/env.ts`
- `server/src/auth/tokens.ts`, `server/src/auth/identity.ts`
- `server/src/coordination/store.ts`
- `server/tests/auth.test.ts`, `coordination.integration.test.ts`, `activity.integration.test.ts`
- `.env.example`

Read-only catalog, 5 November 2026, PostgreSQL 18.4 on `127.0.0.1:5433`, database `nyuma_dev`, then the cluster was stopped:

```sql
SELECT name, default_version, installed_version
FROM pg_available_extensions
WHERE name ~ 'crypto|jwt|sodium|python|perl|ssl'
ORDER BY name;

SELECT n.nspname, p.proname
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.proname IN ('hmac', 'digest', 'pgp_pub_decrypt');

BEGIN READ ONLY;
SET LOCAL ROLE nyuma_app;
SELECT set_config('nyuma.user_id', '00000000-0000-4000-8000-000000000099', true);
ROLLBACK;
```

No live Supabase URL was called. No sample storage key was read or written.
