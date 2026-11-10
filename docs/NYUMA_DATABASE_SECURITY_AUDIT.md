# Nyuma database security and RLS architecture audit

Milestone 15.5.1. Read-only. No migrations, grants, policies, queries, or data were changed.

The audit date is 5 November 2026. The inspected database is the local verification cluster, not a live Supabase project.

## Conclusion

The HTTP API is the only enforcement boundary for who may see a coordination record. That boundary is real for a normal caller: request bodies do not choose the account, and SQL predicates repeat the account resolved from the verified token. It is not a boundary against a stolen application database credential, and it is not a boundary against an application query that forgets its `WHERE` clause.

`nyuma_app` is not a superuser, cannot log in, and cannot assume the provisioner, operator, or function-owner roles. It can still read and write every coordination row. Row-level security is not enabled on any table. Several `SECURITY DEFINER` functions are owned by the local superuser, so turning RLS on in the current shape would not close the stolen-credential hole and would break quantity checks.

A session variable such as `app.user_id`, set by the backend, would limit accidental unscoped queries. It would not stop the holder of the shared database credential, because that holder can set the variable to any account.

Do not enable RLS until function ownership, identity verification, and the connection-pool contract are designed together. The recommended target is below.

## 1. Current architecture

Nyuma uses one PostgreSQL database and two Node connection pools. Both pools use `APP_DATABASE_URL`. Migrations use a separate `DATABASE_URL`. The browser never receives a database URL. The API refuses `SUPABASE_SERVICE_ROLE_KEY` at startup. `loadConfig` refuses a database host other than localhost.

Identity:

- `server/src/auth/tokens.ts` verifies the bearer token before an account id is used. HS256 uses `SUPABASE_JWT_SECRET` when that legacy mode is configured. ES256 and RS256 use the Supabase JWKS document. `service_role` and `anon` tokens are rejected. The verified `sub` is the only account identity.
- `server/src/auth/identity.ts` resolves `users.auth_user_id` from that `sub`. It inserts a user row on bootstrap, reads `users` and `user_roles`, and calls `nyuma_set_active_role`, `nyuma_submit_role_requests`, and `nyuma_list_role_requests`.
- `server/src/coordination/store.ts` receives the Nyuma `users.id` already resolved from that token. Inserts set `owner_id` or `buyer_id` from that value. List and update statements repeat it in SQL. Market reads are `status = 'open' AND origin = 'live'` and do not return owner or buyer ids. Agreement, purchase, and outcome reads use the participant predicate in `partySql`. Outcome reads return non-sold rows and notes only to a listing owner who holds farmer or trader. A buyer sees a sold outcome linked to their purchase, and the API clears notes for that buyer in application code.
- An administrator role is not a participant. `partySql` does not grant an administrator every agreement.

Pools and transactions:

- Identity and coordination each create `new pg.Pool({ max: 4 })`.
- Every checkout runs `SET statement_timeout = '15s'` and `assertApplicationRole`. The timeout is left on the pooled session. No `RESET`, `DISCARD`, or `SET ROLE` runs before `release()`.
- `runTransaction` issues `BEGIN` / `COMMIT` and retries only SQLSTATE `40P01` and `40001`. Many reads, including listing lists and account reads, are not inside a transaction.
- Identity bootstrap uses its own `BEGIN` / `COMMIT`.
- Nothing sets a user id, JWT, or `search_path` on the pooled connection.

`assertApplicationRole` requires `current_user` to be a member of `nyuma_app` and rejects a superuser or a member of `nyuma_provisioner`, `nyuma_operator`, or any `nyuma_fn_*` role. It does not reject `BYPASSRLS`, `CREATEROLE`, or `CREATEDB`.

Roles created by migrations:

| Role | Login | Inherit | Purpose |
| --- | --- | --- | --- |
| `nyuma_app` | no | no | Privileges inherited by the API login |
| `nyuma_provisioner` | no | no | Sole path that may insert `administrator` |
| `nyuma_operator` | no | no | May execute approve, reject, and revoke |
| `nyuma_fn_request` | no | no | Owns submit and list functions |
| `nyuma_fn_approve` | no | no | Owns approval and may insert `user_roles` |
| `nyuma_fn_reject` | no | no | Owns rejection |
| `nyuma_fn_revoke` | no | no | Owns ordinary-role revocation |

Operator logins are created outside the repository. The migrations grant `nyuma_operator` to the migration user `WITH ADMIN OPTION`, and grant the function-owner roles and `nyuma_provisioner` to that same user. `nyuma_app` is not granted to the migration user by the migrations.

There is no RLS, no policy, and no `FORCE ROW LEVEL SECURITY` in any migration.

## 2. What was verified in PostgreSQL 18.4

The local cluster at `C:\Users\HP\AppData\Local\Temp\nyuma-pg-11b1` was stopped. It was started on `127.0.0.1:5433` for this inspection and stopped afterward. The database name is `nyuma_dev`. The login used for inspection was `nyuma`.

Verified server identity:

- `PostgreSQL 18.4 on x86_64-windows, compiled by msvc-19.44.35226, 64-bit`
- `current_user` was `nyuma`, and `rolsuper` was true
- `pg_hba.conf` for this cluster is `trust` for localhost only. That is a property of the throwaway cluster, not a production host-auth design
- `pg_authid.rolpassword` is null for `nyuma`, `nyuma_app`, `nyuma_provisioner`, `nyuma_operator`, and every `nyuma_fn_*` role. `pg_roles.rolpassword` always displays `********` and was not used as evidence
- `schema_migrations` contains `000_roles.sql` through `004_role_requests.sql`

Verified role attributes for every `nyuma_*` role:

- `rolsuper`, `rolcreaterole`, `rolcreatedb`, `rolcanlogin`, `rolreplication`, and `rolbypassrls` are all false
- `rolinherit` is false
- `nyuma_app` is not a member of `nyuma_provisioner`, `nyuma_operator`, or `nyuma_fn_approve` (`pg_has_role` returned false)
- Explicit `pg_auth_members` rows are only `nyuma` as a member of `nyuma_provisioner`, `nyuma_operator`, and the four function-owner roles. There is no login role in this database whose only membership is `nyuma_app`. `pg_has_role('nyuma', 'nyuma_app', 'member')` is true because `nyuma` is a superuser, not because migration `000` granted it
- `has_schema_privilege('nyuma_app', 'public', 'CREATE')` is false. `USAGE` is true. Database `CREATE` is false. `CONNECT` and `TEMP` are true because the database ACL is null, which leaves PostgreSQL's default public connect and temporary rights
- `pg_default_acl` is empty

`SET LOCAL ROLE nyuma_app` in a read-only transaction, from the superuser session, could `SELECT` all 240 listings, all 199 commitments, all 36 outcomes, and all 479 users. The same session received `permission denied for table role_requests`. A later `SET ROLE nyuma_provisioner` succeeded in that superuser session because `SET ROLE` follows `session_user`. That success is not evidence that `nyuma_app` can become the provisioner. Membership is the evidence, and `nyuma_app` is not a member.

Row counts are leftover local integration fixtures. No commercial column was selected. These rows are not the browser sample document.

| Table | Rows visible to the superuser and to `nyuma_app` |
| --- | ---: |
| users | 479 |
| profiles | 0 |
| user_roles | 431 |
| role_requests | 93, and `nyuma_app` cannot read them |
| role_revocations | 10, and `nyuma_app` cannot read them |
| coordination_ids | 730 |
| listings | 240 |
| buyer_demands | 207 |
| commitments | 199 |
| purchases | 48 |
| outcomes | 36 |

`information_schema.triggers` reports 37 triggers in `public`. `pg_policy` reports 0 policies.

## 3. Sensitive object inventory

Every public table is owned by `nyuma`. RLS is off and not forced. `relacl` below is the verified grant string. Privilege letters follow PostgreSQL: `a` insert, `r` select, `w` update, `d` delete.

| Table | Sensitive contents | `nyuma_app` privileges | Other grants | RLS |
| --- | --- | --- | --- | --- |
| `users` | Account id, Supabase `auth_user_id`, status, selected workspace | `SELECT`, `INSERT`, `DELETE`. `UPDATE` revoked | `SELECT` to operator and all function owners | off |
| `profiles` | Display name and phone. Unused by the API. Empty locally | `SELECT`, `INSERT`, `UPDATE`, `DELETE` | none | off |
| `user_roles` | Granted roles, including administrator | `SELECT` only | provisioner `SELECT/INSERT/DELETE`; approve `SELECT/INSERT`; revoke `SELECT/DELETE`; operator and request function `SELECT` | off |
| `role_requests` | Role preference, decision, and decision note | none | request `SELECT/INSERT`; approve and reject `SELECT/UPDATE`; operator `SELECT` | off |
| `role_revocations` | Who removed an ordinary role, and the note | none | revoke `INSERT`; operator `SELECT` | off |
| `coordination_ids` | Global id registry for coordination records | `SELECT`, `INSERT`, `UPDATE`, `DELETE` | none | off |
| `listings` | Owner, quantity, price, location, status, notes are not on this table | `SELECT`, `INSERT`, `UPDATE`, `DELETE` | revoke `SELECT` | off |
| `buyer_demands` | Buyer, quantity, price, location, status | `SELECT`, `INSERT`, `UPDATE`, `DELETE` | revoke `SELECT` | off |
| `commitments` | Agreed quantity and price between a listing and a requirement | `SELECT`, `INSERT`, `DELETE`. `UPDATE` revoked | none | off |
| `purchases` | Actual quantity and price | `SELECT`, `INSERT`, `UPDATE`, `DELETE` | none | off |
| `outcomes` | Category, quantity, and notes | `SELECT`, `INSERT`, `UPDATE`, `DELETE`, including `notes` | none | off |
| `schema_migrations` | Applied migration names | none. ACL is null, so only the owner has access | none | off |

`has_column_privilege` confirmed `nyuma_app` can `SELECT` and `UPDATE` `outcomes.notes`, can `SELECT` `users.auth_user_id`, and cannot `UPDATE` `users.status`.

Tables that ordinary API operations should not read or write directly:

- `role_requests` and `role_revocations`. The API reaches requests only through `nyuma_submit_role_requests` and `nyuma_list_role_requests`. Direct grants match that intent.
- `user_roles` writes. Direct insert and delete are revoked from `nyuma_app`. The catalog confirms this. Approval and revocation stay with the function-owner roles.
- `schema_migrations`. The API does not use it, and `nyuma_app` cannot see it.
- `profiles` has full write grants and no API. It should stay unused until a profile design exists, and it should not be readable by every API session once it holds phone numbers.
- `users.auth_user_id` and `users.status` are identity material. Status changes are already blocked for `nyuma_app`. Selecting every `auth_user_id` is not blocked.

Foreign keys are all `ON DELETE RESTRICT`. Commitments reference listings and buyer demands. Purchases reference commitments and listings. Outcomes reference listings and, optionally, commitments and purchases. Role tables reference `users`. Deleting a user, listing, or agreement that is still referenced fails at the foreign key. Triggers also reject deleting commitments, purchases, and outcomes, but the `DELETE` grant on those tables still exists.

Functions and triggers that see these tables:

- Invoker triggers on listings, demands, commitments, purchases, outcomes, users, and role tables enforce quantity caps, status transitions, immutable columns, and the administrator-role guard. They run as the caller.
- `nyuma_lock_user`, `nyuma_lock_listing`, `nyuma_lock_demand`, `nyuma_lock_for_commitment`, `nyuma_lock_for_purchase`, `nyuma_lock_for_outcome`, `nyuma_set_commitment_status`, `nyuma_insert_purchase`, `nyuma_set_active_role`, and `nyuma_clear_active_role` are `SECURITY DEFINER`, owned by `nyuma`, with `search_path = pg_catalog, public`. `nyuma_app` can execute every one of them. `nyuma_fn_revoke` can also execute `nyuma_clear_active_role` and `nyuma_lock_user`.
- `nyuma_grant_administrator` is invoker, owned by `nyuma`, and executable only by `nyuma` and `nyuma_provisioner`.
- `nyuma_submit_role_requests` and `nyuma_list_role_requests` are definer functions owned by `nyuma_fn_request`. `nyuma_app` can execute both. They accept an `auth_user_id` argument and do not verify a token.
- Approve, reject, and revoke are definer functions owned by their own function roles. `nyuma_app` cannot execute them. Approve and reject require `pg_has_role(session_user, 'nyuma_operator', 'MEMBER')`.
- Many invoker helper functions, including `nyuma_listings_guard` and `nyuma_users_guard`, still have default `EXECUTE` for `PUBLIC` (`proacl` contains `=X/nyuma`, or the ACL is null and `has_function_privilege('public', ...)` is true). They are not a second grant of table access by themselves, because a trigger function still needs table rights when it is invoker. They are broader than they need to be.

Backend operations that need access:

| Operation | Tables and functions |
| --- | --- |
| Bootstrap and read account | `INSERT` and `SELECT` on `users`, `SELECT` on `user_roles` |
| Select workspace | `nyuma_set_active_role`, then `SELECT` on `users` |
| Submit or list role requests | the two request functions. No direct table write |
| Create, list, update, delete own listing | `listings`, `nyuma_lock_user`, listing triggers, `coordination_ids` |
| Market listings and requirements | `SELECT` of open live rows only |
| Own buyer requirements | `buyer_demands`, same lock and id pattern |
| Create agreement | `INSERT` into `commitments` after the participant join. Commitment triggers read listings and demands |
| Change agreement status | participant `SELECT`, then `nyuma_set_commitment_status` |
| Create purchase | participant `SELECT`, then `nyuma_insert_purchase` |
| Create outcome | owner `SELECT` of the listing, `INSERT` into `outcomes`, outcome triggers |
| List agreements, purchases, outcomes | participant or owner joins. Buyer sold-outcome filter is in SQL. Note redaction for buyers is in TypeScript after the row is read |

## 4. Evaluation of `nyuma_app`

Verified from `pg_roles`, `pg_authid`, `pg_auth_members`, `has_*_privilege`, and one read-only `SET LOCAL ROLE`:

- It is not a login role, so the passwordless role itself cannot open a connection.
- It is not a superuser and does not have `BYPASSRLS`, `CREATEROLE`, or `CREATEDB`.
- It owns no table and no function.
- It cannot create objects in `public`.
- It can read every user's listings, demands, commitments, purchases, outcomes, notes, and `auth_user_id`. The read-only role switch counted the same rows the superuser counted.
- It can insert, update, and delete listings, demands, purchases, outcomes, profiles, and coordination ids, subject to triggers and foreign keys. Triggers do not check that `current_user` is the row's owner. An `UPDATE listings ... WHERE id = <someone else's id>` is allowed by the grant. The listing trigger only freezes id, owner, commodity, unit, and origin.
- It can insert and delete commitments. It cannot update them directly. It can call `nyuma_set_commitment_status(id, status)` for any id. That function does not check the caller against the listing owner or the buyer.
- It can call `nyuma_insert_purchase` for any confirmed commitment. The purchase trigger checks confirmation and quantity. It does not check the caller.
- It can call `nyuma_set_active_role` for any account that already holds the role.
- It can call `nyuma_submit_role_requests` and `nyuma_list_role_requests` for any `auth_user_id` it can supply. A submitted row stays pending. The function comment already says this.
- It cannot insert, update, or delete `user_roles`. It cannot execute grant, approve, reject, or revoke. It cannot read role-request or revocation tables.
- It cannot `UPDATE users`, so it cannot change `status` or `auth_user_id` through a normal update. `nyuma_set_active_role` updates `active_role` as the superuser owner and bypasses that revoke.
- The lock functions select by id with no owner predicate. The coordination store avoids `nyuma_lock_listing` and `nyuma_lock_demand` for that reason. The execute grant still lets a direct SQL session use them as an existence check.

A stolen API credential is a login role that inherits `nyuma_app`, not a connection as `nyuma_app` itself. No such login role is installed in this local database. Its effective rights would be the `nyuma_app` rights above, plus anything granted directly to that login. `assertApplicationRole` would accept it if it is not a superuser and not a member of the privileged roles.

Because the definer functions that change commitments, purchases, and the selected workspace are owned by superuser `nyuma`, they run as a role that bypasses RLS even if `FORCE ROW LEVEL SECURITY` is later set. Enabling RLS without reowning those functions does not contain a stolen credential.

## 5. RLS design comparison

### A. Transaction-local user id set by the backend

The API would `SELECT set_config('app.user_id', <users.id>, true)` and policies would compare `owner_id` to `current_setting('app.user_id', true)`.

What it protects against: an application bug that omits a `WHERE` clause, as long as every statement runs in a transaction where the setting was made, the role does not bypass RLS, and policies match the real visibility rules.

What it does not protect against: the holder of the shared database credential. PostgreSQL lets that role set a custom variable to any value. It also does not protect a compromised API process, which knows every user's id and can set the variable itself.

Stolen `nyuma_app` credential: bypasses this design.

Pool and transactions: `set_config(..., true)` lasts for one transaction. Reads that currently have no `BEGIN` would not see it. A non-local setting would survive `release()` and attach the next request to the previous account. `runTransaction` can carry a local setting through one attempt. A retry opens a new transaction, so the setting must be applied again inside every attempt. `statement_timeout` is already session-level and is not cleared today.

Triggers and definer functions: invoker triggers would see only rows the policy allows, so quantity totals would be wrong unless the policy is much wider than "own rows" or the check runs as a constrained definer. Superuser-owned definer functions would ignore the policies.

Operational cost: small in the API, high in the policy design, and the security claim would be overstated if it were described as protection against a stolen credential.

### B. Verified token checked again inside the database

The API would pass the bearer token that it already verified, using a transaction-local setting. A `SECURITY DEFINER` function owned by a non-superuser role would verify the signature, issuer, audience, expiry, and `sub`, reject `service_role` and `anon`, and return the matching `users.id`. Policies would call that function. The verification key would live in a schema `nyuma_app` cannot read. For current Supabase projects the material stored there should be the public verification key, not a signing secret. HS256 would require the shared secret in that schema, which is a worse option because anyone who can read it can mint tokens.

What it protects against: a stolen database credential used by itself. The attacker can put a token into the setting, but cannot mint a `sub` without the signing key. It also protects an unscoped query, because a query with no verified token returns no account-scoped rows. A captured end-user token still works until it expires. That is the same power that token already has through the API.

What it does not protect against: a compromised API server that also sees live access tokens, and a database owner who can read the key schema and disable RLS. It does not protect an attacker who has both the database credential and a user's unexpired token.

Stolen `nyuma_app` credential alone: does not bypass this design, provided the function owner is not a superuser, the key is not readable by `nyuma_app`, policies use the function rather than a raw user id, `FORCE ROW LEVEL SECURITY` is on after ownership has left the superuser, and definer functions that `nyuma_app` can execute repeat the same check.

Pool and transactions: the token setting must be transaction-local and cleared in `finally` before `release()`. Every read and every retry attempt must set it inside the transaction. The current split between transactional writes and bare reads has to become one pattern.

Triggers and definer functions: workable if quantity and lock functions are reowned to a non-superuser and recheck the verified account before they touch another person's row. A policy that joins agreements to listings can recurse if those tables also have RLS. The visibility predicate should be one definer function with a fixed `search_path`, not a policy that re-enters RLS on the same tables.

Operational cost: higher. Key storage, token lifetime, HS256 versus JWKS, and Supabase key rotation all become database concerns. This is still the first design that treats the stolen application credential differently from a missing `WHERE` clause.

### C. Separate database identities

Practical split:

- migration owner, used only by `DATABASE_URL`
- API login, member of `nyuma_app` only
- operator login, member of `nyuma_operator` only, not used by the HTTP pool
- function-owner roles, already separated and `NOLOGIN`

A database role per end user is not practical with Supabase accounts.

What it protects against: the API process using the migration owner, and the API process executing approve or revoke. Those are already the intended boundaries. `assertApplicationRole` enforces the second one at startup of each checkout.

What it does not protect against: cross-user reads inside the one API role. Separate logins do not create row boundaries.

Stolen `nyuma_app` credential: still reads every coordination row.

Pool and transactions: fits the current pools. The operator must not be added to `APP_DATABASE_URL`.

This split should be kept. It is not an RLS substitute.

### D. API-only authorization and tighter grants

Keep predicates in `store.ts` and `identity.ts`. Revoke grants the triggers already make useless, and revoke direct execute of lock and status functions that do not check the caller.

What it protects against: a normal user and a forged request body. Those are already protected. Tighter grants reduce damage from a stolen credential: for example, removing `DELETE` on history tables and `UPDATE` on purchases and outcomes removes rights the triggers already refuse.

What it does not protect against: `SELECT` of every row, `UPDATE` of someone else's listing, `INSERT` of a commitment without being a participant, and any definer function that still trusts an id argument. A forgotten `WHERE` clause still returns every granted row.

Stolen `nyuma_app` credential: bypasses row isolation. Grants can shrink the blast radius. They do not create per-account isolation while `SELECT` on the base tables remains.

This is the right immediate hardening layer. It is not the target if the requirement is protection when the application credential leaks.

## 6. Recommended target architecture

Preserve one rule: the verified token `sub` is the application identity. The database may verify that token again. It must not trust a user id that the SQL session can choose freely. The browser must not receive database credentials or the Supabase service-role key. An administrator role must not become a policy exception for private agreements, purchases, or outcomes.

### Roles

| Role | Attributes | Use |
| --- | --- | --- |
| `nyuma_owner` | `LOGIN`, `NOSUPERUSER`, `NOBYPASSRLS`, no membership in `nyuma_app` | Migrations and object ownership. Not the API pool |
| `nyuma_api` | `LOGIN`, `INHERIT`, `NOSUPERUSER`, `NOBYPASSRLS`, `NOCREATEROLE`, `NOCREATEDB` | The only role in `APP_DATABASE_URL`. Member of `nyuma_app` and nothing else |
| `nyuma_app` | unchanged `NOLOGIN NOINHERIT` | Shared privilege set for the API |
| `nyuma_fn_identity` | `NOLOGIN NOSUPERUSER NOBYPASSRLS` | Owns the token-verification function and can read the key schema |
| Existing provisioner, operator, and `nyuma_fn_*` roles | unchanged `NOLOGIN NOINHERIT` | Role administration only |

The local superuser `nyuma` is a verification convenience. It should not own production tables or `SECURITY DEFINER` functions. Supabase's `postgres` and `service_role` need the same treatment when a live project exists: the API must not connect as either of them.

`assertApplicationRole` should also reject `rolbypassrls`, `rolcreaterole`, and `rolcreatedb` when this is implemented.

### Data access

- `nyuma_app` keeps `SELECT`, `INSERT`, and `UPDATE` on its own listing and requirement operations only through policies, not through an open table grant as the final state.
- Until policies exist, revoke the grants that no correct API call needs: `DELETE` on `commitments`, `purchases`, and `outcomes`; `UPDATE` on `purchases` and `outcomes`; `DELETE` on `users`; all privileges on `profiles`; `UPDATE` on `coordination_ids`. Keep the insert and delete rights the id triggers need, or move those triggers to a definer owned by `nyuma_owner` and then revoke the direct rights.
- `role_requests`, `role_revocations`, and `user_roles` writes stay unavailable to `nyuma_app`.
- `outcomes.notes` stays in the table. Buyer redaction should move into the visibility predicate so a direct `SELECT` cannot read another account's notes. The current TypeScript redaction happens after a permitted read.
- Market visibility is a policy clause for `status = 'open' AND origin = 'live'`, not a second grant and not an administrator exception.
- Agreement and purchase visibility is participant-only: listing owner who holds farmer or trader, or requirement buyer who holds buyer.
- Outcome visibility is listing owner who holds farmer or trader, or a buyer seeing a sold outcome tied to their purchase.
- Suspended and deactivated users fail the verified-account function, so policies and definer writes do not run for them.
- Workspace selection remains `nyuma_set_active_role`, after that function checks the verified account instead of accepting any `users.id`.

### Identity context and pool safety

On every checkout:

1. `BEGIN`.
2. `SELECT set_config('nyuma.access_token', <bearer>, true)`.
3. Run the existing statement.
4. `COMMIT` or `ROLLBACK`.
5. In `finally`, `RESET nyuma.access_token` before `release()`, so a later bug cannot leave a session-level value on the pooled client.

Do not use `set_config` with the local flag false. Apply the setting again inside each `runTransaction` attempt. Do not put the token in a log line. `statement_timeout` can stay.

`nyuma_verified_account_id()` should be `STABLE`, `SECURITY DEFINER`, with `search_path = pg_catalog, nyuma_private`. It returns null when the token is missing, expired, or not a verified authenticated `sub`. Policies use `owner_id = nyuma_verified_account_id()` plus the explicit market and participant exceptions. They do not call `current_setting('app.user_id')`.

### RLS boundary

Enable RLS and `FORCE ROW LEVEL SECURITY` only after:

- tables and the coordination definer functions are owned by `nyuma_owner` or another non-superuser, non-bypass role
- `nyuma_set_commitment_status`, `nyuma_insert_purchase`, `nyuma_set_active_role`, and the lock functions check `nyuma_verified_account_id()`
- quantity checks that must see every child row of one listing run inside a definer that has that check and a fixed search path
- the API login, not the superuser, is the role used in the tests that claim RLS works

`FORCE` does not apply to a superuser owner. That is why ownership has to move first.

## 7. Compatibility with current workflows

| Workflow | Can the target model express it? | What breaks if RLS is enabled on today's owners and grants |
| --- | --- | --- |
| Farmer-owned listing | Yes. Policy: owner matches verified account and the account holds farmer or trader | Invoker insert can work for own rows. A superuser-owned lock still reveals any listing id |
| Trader-owned listing | Yes. Same owner rule. Trader is not a global reader | Same |
| Buyer-owned requirement | Yes. `buyer_id` matches verified account and the account holds buyer | Same existence leak through `nyuma_lock_demand` |
| Participant-only agreements | Yes, if the participant predicate is one non-recursive definer | A policy that only allows `owner_id = app.user_id` hides the other party's listing or requirement, so the join returns nothing. A policy that scans commitments under RLS can recurse |
| Purchase on a confirmed agreement | Yes. `nyuma_insert_purchase` must require the verified account to be a participant, then keep the current lock order | The function is owned by the superuser, so it bypasses a new policy and can still insert for any confirmed agreement |
| Listing-owner outcome | Yes. Insert policy requires ownership and farmer or trader | Invoker insert of another owner's outcome must fail once RLS is forced and the owner is not a superuser. Today the grant allows it |
| Buyer outcome visibility | Yes. Sold rows linked through the buyer's purchase. Notes excluded for that buyer | An owner-only policy hides the buyer's sold rows. A table-wide `SELECT` grant keeps notes visible to SQL |
| Open market feeds | Yes. Explicit `open` and `live` clause, with no owner id in the result | An owner-only policy makes the market empty |
| Role checks and suspended accounts | Yes. Verified function joins `users.status` and `user_roles` | Current checks are in SQL and triggers, not in RLS. A policy that hides `user_roles` from the invoker trigger makes role checks fail closed, which is safe, or fail open if the check is skipped |
| Administrator | No extra rows. Administrator remains a `user_roles` value granted only through `nyuma_provisioner` | Nothing in the API grants private coordination rows to administrators today. A mistaken policy `OR role = 'administrator'` would create that hole. Do not add it |

Quantity triggers are the sharp incompatibility. `nyuma_listing_held_grams`, `nyuma_listing_accounted_grams`, and the demand equivalent sum every related commitment, purchase, and outcome. If those `SELECT`s run as `nyuma_app` under an owner-only policy, they under-count another participant's rows and can allow a quantity the current triggers would reject. Those checks have to run with a controlled bypass that is not "the caller is superuser" and not "the caller picked a user id."

`nyuma_set_commitment_status` and `nyuma_insert_purchase` also take locks as the function owner. Leaving them owned by a superuser keeps the current behavior and keeps the bypass. Reowning them without adding a participant check makes them subject to RLS and can make a legitimate status change fail, or, if the new owner bypasses RLS, leaves the stolen-credential path open.

## 8. Migration sequence

Do not apply this sequence in this milestone.

1. Add `nyuma_owner` and `nyuma_fn_identity` outside the API pool. Keep `nyuma_app` as `NOLOGIN`.
2. Move table and coordination-function ownership from the superuser to `nyuma_owner`. Revoke superuser ownership of `SECURITY DEFINER` functions. Confirm `pg_proc.proowner` for `nyuma_set_commitment_status` and `nyuma_insert_purchase` is no longer a superuser.
3. Add `nyuma_private` for verification material. Grant no privileges to `nyuma_app`, `PUBLIC`, or the operator roles. Prefer a public verification key.
4. Add `nyuma_verified_account_id()` and make the status, purchase, workspace, and lock functions require it.
5. Change both pools so every statement runs in a transaction with a transaction-local token and a `RESET` before `release()`. Extend `assertApplicationRole` to reject bypass and create privileges.
6. Revoke the unused grants listed above. Re-test triggers after each revoke, because invoker triggers need the caller to hold the rights they use.
7. Add policies for listings, demands, commitments, purchases, outcomes, users, profiles, and `user_roles` reads. Enable RLS. Test as `nyuma_api`, not as the superuser.
8. `FORCE ROW LEVEL SECURITY` after those tests pass.
9. Local verification on PostgreSQL 18.4: two accounts, cross-reads, market rows, participant agreement, purchase, owner outcome, buyer note redaction, suspended account, stolen-role simulation by connecting as `nyuma_api` and attempting another account's id, and a query with the token cleared.
10. Live Supabase verification stays in the later milestone. Repeat the catalog queries there. Do not assume hosted `postgres` or `service_role` behaves like `nyuma_app`.

Rollback, also not applied now:

- Keep a reviewed script beside the migration. It should `ALTER TABLE ... DISABLE ROW LEVEL SECURITY` and `NO FORCE ROW LEVEL SECURITY`, drop the new policies, restore the previous function bodies, and restore the previous grants.
- Run rollback on the local cluster before it is considered ready.
- Ownership can stay with `nyuma_owner` during rollback. Returning ownership to a superuser is not part of the safe rollback.
- There is no automatic down-migration in `server/src/db/migrate.ts`. A failed migration file already rolls back its own transaction unless it is marked `nyuma:no-transaction`. Role creation and ownership moves need their own failure handling.
- Do not roll back by dropping tables. Coordination rows, including commitments, are not disposable.

## 9. Threat model

| Threat | What holds today | Residual risk after the target model |
| --- | --- | --- |
| 1. A signed-in user reads another account's records through the API | Mitigated. The token `sub` is resolved to `users.id`, and coordination SQL repeats that id. Agreements use the participant predicate. Tests cover cross-account `404` responses | A bug in a new query. RLS becomes the backstop |
| 2. A caller forges owner ids in a request body | Mitigated. The HTTP handlers reject client owner, buyer, and account ids. The store writes the resolved id | A new handler that trusts a body id. The verified-token function still constrains SQL |
| 3. An application bug omits a `WHERE` clause | Not mitigated. `nyuma_app` has table-wide `SELECT` and RLS is off | Mitigated for the API role once policies are forced and the session has a verified token. A superuser connection still bypasses |
| 4. The application server is compromised | The process holds `APP_DATABASE_URL` and sees bearer tokens. It can query as the API role and act as any user whose token it observes. If `SUPABASE_JWT_SECRET` is configured, it can also mint HS256 tokens | RLS does not contain a process that holds both the API credential and live user tokens. Asymmetric verification, with no signing secret on the API host, at least stops that process from minting tokens for users who are not currently signed in |
| 5. The shared API database credential is stolen | The holder can read and write every coordination row, change any agreement status, insert purchases, set workspaces, and list role requests for any auth id. The holder cannot grant roles, approve requests, or update `users.status` | The holder can still open a connection and attempt SQL. Account-scoped rows stay closed unless the holder also has a valid user token. Market rows and pending role-request submission remain available to the extent policies and functions allow them |
| 6. The migration or database-owner credential is stolen | The local owner is a superuser with trust authentication on localhost. A production owner can bypass RLS, change grants, replace functions, and read every row | Still a full compromise. The owner credential must stay off the API host, off the browser, and out of `APP_DATABASE_URL`. Trust authentication must not be copied to a shared host |
| 7. An administrator uses the application to read private coordination data | Mitigated in the API. Administrator is not a participant predicate and there is no admin coordination route | Still mitigated only if no later policy adds an administrator exception. Role administration remains a separate operator path with no HTTP approve or revoke route |

## 10. Outstanding risks

- RLS is off, grants are table-wide, and the important definer functions belong to a superuser. That combination is the production blocker.
- A freely set user-id variable must not be documented or implemented as stolen-credential protection.
- Buyer note privacy is applied after the row is read. Direct SQL can read `outcomes.notes`.
- Lock functions remain an existence oracle for any id.
- `PUBLIC` can still execute many invoker helper functions.
- `profiles` is fully writable by `nyuma_app` and has no product path.
- `assertApplicationRole` does not reject `BYPASSRLS`.
- Pooled sessions do not reset session state beyond what the next checkout overwrites.
- Coordination writes are not rate-limited, and lists are not paginated. Those are availability and bulk-read concerns, not RLS substitutes.
- The local cluster is trust-authenticated and owned by a superuser. Its role attributes were verified. Its host authentication is not a production control.
- No live Supabase catalog was inspected. Hosted projects add `anon`, `authenticated`, `service_role`, and an `auth` schema. Those grants are unknown until the later verification milestone.

## 11. Evidence

### Files inspected

- `server/migrations/000_roles.sql`
- `server/migrations/001_foundation.sql`
- `server/migrations/002_identity.sql`
- `server/migrations/003_role_assignment_roles.sql`
- `server/migrations/004_role_requests.sql`
- `server/src/db/client.ts`
- `server/src/db/transaction.ts`
- `server/src/db/applicationRole.ts`
- `server/src/db/migrate.ts`
- `server/src/db/operations.ts`
- `server/src/db/ready.ts`
- `server/src/config/env.ts`
- `server/src/index.ts`
- `server/src/auth/identity.ts`
- `server/src/auth/tokens.ts`
- `server/src/coordination/store.ts`
- `server/tests/schema.integration.test.ts`, for the existing non-superuser `SET ROLE` denial. That test was not re-executed, because running it creates and drops a role
- `C:\Users\HP\AppData\Local\Temp\nyuma-pg-11b1\pg_hba.conf`, read for host-auth lines only

No frontend file, sample storage key, or live Supabase project was used.

### Catalog queries

The cluster was started only for these reads and then stopped. The inspection login was the local superuser. One statement failed as intended: `SELECT count(*) FROM role_requests` after `SET LOCAL ROLE nyuma_app` returned `permission denied for table role_requests`.

```sql
SELECT version();
SELECT current_database(), current_user, session_user,
       (SELECT rolsuper FROM pg_roles WHERE rolname = current_user);

SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin,
       rolreplication, rolbypassrls, rolconnlimit
FROM pg_roles
WHERE rolname LIKE 'nyuma%' OR rolname = 'postgres';

SELECT rolname, (rolpassword IS NULL) AS authid_password_absent
FROM pg_authid
WHERE rolname LIKE 'nyuma%';

SELECT r.rolname AS role, m.rolname AS member, a.admin_option, a.inherit_option, a.set_option
FROM pg_auth_members a
JOIN pg_roles r ON r.oid = a.roleid
JOIN pg_roles m ON m.oid = a.member
WHERE r.rolname LIKE 'nyuma%' OR m.rolname LIKE 'nyuma%';

SELECT pg_has_role('nyuma_app', 'nyuma_provisioner', 'member'),
       pg_has_role('nyuma_app', 'nyuma_operator', 'member'),
       pg_has_role('nyuma_app', 'nyuma_fn_approve', 'member'),
       pg_has_role('nyuma', 'nyuma_app', 'member');

SELECT nspname, nspowner::regrole, nspacl FROM pg_namespace WHERE nspname = 'public';
SELECT datname, datdba::regrole, datacl FROM pg_database WHERE datname = current_database();
SELECT has_schema_privilege('nyuma_app', 'public', 'USAGE'),
       has_schema_privilege('nyuma_app', 'public', 'CREATE'),
       has_database_privilege('nyuma_app', current_database(), 'CONNECT'),
       has_database_privilege('nyuma_app', current_database(), 'CREATE'),
       has_database_privilege('nyuma_app', current_database(), 'TEMP');

SELECT c.relname, pg_get_userbyid(c.relowner), c.relrowsecurity, c.relforcerowsecurity, c.relacl
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r';

SELECT count(*) FROM pg_policy p
JOIN pg_class c ON c.oid = p.polrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public';

SELECT table_name, grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND grantee IN ('nyuma_app', 'nyuma_provisioner', 'nyuma_operator',
                  'nyuma_fn_request', 'nyuma_fn_approve', 'nyuma_fn_reject', 'nyuma_fn_revoke', 'PUBLIC');

SELECT has_table_privilege('nyuma_app', c.oid, perm)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r';

SELECT has_column_privilege('nyuma_app', 'public.outcomes', 'notes', 'SELECT'),
       has_column_privilege('nyuma_app', 'public.outcomes', 'notes', 'UPDATE'),
       has_column_privilege('nyuma_app', 'public.users', 'auth_user_id', 'SELECT'),
       has_column_privilege('nyuma_app', 'public.users', 'status', 'UPDATE');

SELECT p.proname, pg_get_function_identity_arguments(p.oid), r.rolname, p.prosecdef, p.proconfig, p.proacl,
       has_function_privilege('nyuma_app', p.oid, 'EXECUTE'),
       has_function_privilege('public', p.oid, 'EXECUTE')
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_roles r ON r.oid = p.proowner
WHERE n.nspname = 'public' AND p.proname LIKE 'nyuma_%';

SELECT conrelid::regclass, conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE contype = 'f' AND connamespace = 'public'::regnamespace;

SELECT version, applied_at FROM schema_migrations ORDER BY version;
SELECT count(*) FROM information_schema.triggers WHERE trigger_schema = 'public';
SELECT defaclrole::regrole, defaclnamespace::regnamespace, defaclobjtype, defaclacl FROM pg_default_acl;

-- counts only; no commercial columns
SELECT count(*) FROM users;
SELECT count(*) FROM profiles;
SELECT count(*) FROM user_roles;
SELECT count(*) FROM role_requests;
SELECT count(*) FROM role_revocations;
SELECT count(*) FROM coordination_ids;
SELECT count(*) FROM listings;
SELECT count(*) FROM buyer_demands;
SELECT count(*) FROM commitments;
SELECT count(*) FROM purchases;
SELECT count(*) FROM outcomes;

BEGIN READ ONLY;
SET LOCAL ROLE nyuma_app;
SELECT current_user, session_user;
SELECT count(*) FROM listings;
SELECT count(*) FROM commitments;
SELECT count(*) FROM outcomes;
SELECT count(*) FROM users;
ROLLBACK;
```

### Assumptions, kept separate from the catalog

- Production host authentication, network exposure, and backup access were not inspected. The local cluster's `trust` lines must not be treated as the production setting.
- Live Supabase role names and grants were not queried.
- The integration test that connects as a non-superuser and shows `SET ROLE nyuma_provisioner` failing was read and not re-run.
- No write, `GRANT`, `REVOKE`, `CREATE`, `ALTER`, or `COMMIT` of a data change was issued. The failed `role_requests` read aborted its read-only transaction.
