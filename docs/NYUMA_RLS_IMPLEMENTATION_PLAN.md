# Nyuma RLS implementation plan

Stage E1 is an assessment. This document does not enable Row-Level Security, create policies, or change grants, roles, ownership, functions, or migrations.

Inspection target: local PostgreSQL 18.4, database `nyuma_dev`, `inet_server_port()` 5433. Sixteen application tables. Zero policies. `relrowsecurity` and `relforcerowsecurity` are false on every one of them.

**Recommendation: CONDITIONAL GO for a later implementation milestone. NO-GO for enabling RLS as part of this assessment.**

Stage E2 (section 11) keeps that boundary and narrows the next step. Migration `013` is **GO** only as the helper-only SQL in that section. Migrations `014` and later stay **NO-GO** until the corrections in section 11 are the ones implemented. Stage E2 did not execute any of that SQL.

The database can now derive an account from a verified `nya1` assertion. That removes the earlier reason to refuse RLS. Enabling it on the current catalog would still break legitimate counterparty reads, hide a suspended account from `findAccount`, and leave column leaks that a row policy cannot close.

## 1. Identity and authorization model

There is no workspace table. The tenant is `public.users.id`. `users.active_role` is a preference constrained to a row in `user_roles`. It is not an identity.

The only identity expression policies and new helpers may use is `public.nyuma_verified_account_id()`.

That function is `SECURITY DEFINER`, owned by `nyuma_fn_identity`, `VOLATILE`, `search_path = pg_catalog, pg_temp`. Its body is:

```sql
SELECT users.id
FROM public.users AS users
WHERE users.auth_user_id = public.nyuma_verified_sub()
  AND users.status = 'active';
```

`nyuma_verified_sub()` reads the transaction-local setting `nyuma.access_token` and verifies a `nya1` assertion. It returns null when the setting is missing, empty, malformed, signed by an unknown or retired key, or expired (`clock_timestamp() >= to_timestamp(exp)`). With `nyuma_private.verifier_config.local_hs256_enabled` false, a non-`nya1` token also returns null. The function takes no account-id argument.

Consequences:

- An invalid, missing, or expired assertion makes `nyuma_verified_account_id()` return null. A policy comparison `owner_id = nyuma_verified_account_id()` is not true.
- A suspended or deactivated account matches `nyuma_verified_sub()` and fails the `status = 'active'` predicate, so the account function returns null. Protected policies therefore grant nothing.
- `nyuma_account_status()` can still return `suspended` or `deactivated`. It selects `users.status` by verified subject and does not require `active`. The API may keep using it to distinguish "disabled" from "unknown". Ordinary table policies must not.
- `nyuma.user_id`, request parameters, headers, and client-supplied account ids are not identity. The coordination store still filters with a bound account id (`partySql`). That filter is an application predicate. A direct `nyuma_api` session can omit it. Policies must ignore it.
- `set_active_role` and `nyuma_lock_user` already require the supplied user id to equal `nyuma_verified_account_id()` unless `session_user` is the operator or provisioner. Policies must not add a second path that trusts `active_role` or a caller argument.

### Who can execute the account function

`EXECUTE` is granted to `nyuma_app`. `nyuma_api` inherits that grant. `nyuma_fn_constraint` and `nyuma_fn_request` also retain `EXECUTE` from earlier grants. The function is not granted to `PUBLIC`.

`nyuma_fn_identity` has `BYPASSRLS = false` and does not own `public.users`. After RLS is enabled, its `SELECT` on `users` is subject to policy. A `users` policy that calls `nyuma_verified_account_id()` recurses: the function reads `users` as `nyuma_fn_identity`, the policy calls the function again, and the lookup never resolves.

The safe identity lookup is `nyuma_verified_sub()`. It reads `nyuma.access_token` and `nyuma_private` key tables. It does not read `public.users`. The `users` policy for `nyuma_fn_identity` must be `auth_user_id = nyuma_verified_sub()`, and RLS stays off on `nyuma_private`.

`nyuma_fn_constraint` has `BYPASSRLS`. Policies do not filter queries that run as that role, including after `FORCE ROW LEVEL SECURITY`. Quantity and lock functions must keep that attribute. Their own checks are what stops a caller from naming another account. RLS will not.

## 2. Roles that matter once RLS exists

| Role | Login | Superuser | BYPASSRLS | Inherits | What RLS will do |
| --- | --- | --- | --- | --- | --- |
| `nyuma` | yes | yes | yes | yes | Bypasses `ENABLE` and `FORCE`. This is the migration login. |
| `nyuma_api` | yes | no | no | yes, member of `nyuma_app` | Subject to policies. This is the application session. |
| `nyuma_app` | no | no | no | no | Privilege source for `nyuma_api`. Policies should name this role. |
| `nyuma_owner` | yes | no | no | no | Owns every `public` table. Without `FORCE`, this login bypasses RLS. With `FORCE`, its direct DML is filtered. It can `SET ROLE` to the function owners. |
| `nyuma_fn_identity` | no | no | no | no | Owns `nyuma_private` and the verifier. Needs an explicit `users` policy that does not call the account function. |
| `nyuma_fn_constraint` | no | no | yes | no | Owns quantity, lock, and write-entry functions. Bypasses RLS. Must keep its own party checks. |
| `nyuma_fn_request` | no | no | no | no | Owns role submission and listing. Its reads of `users`, `user_roles`, and `role_requests` become empty unless those policies name this role. |
| `nyuma_fn_approve`, `nyuma_fn_reject`, `nyuma_fn_revoke` | no | no | no | no | Decision and revocation functions. Same default-deny problem. |
| `nyuma_operator`, `nyuma_provisioner` | no | no | no | no | Operator and bootstrap sessions. Need policies on the tables they still read or write directly. |

`nyuma_api` cannot `SET ROLE` to `nyuma_fn_identity`, `nyuma_fn_constraint`, or the decision roles. A superuser session that `SET ROLE nyuma_api` is still the superuser for later `SET ROLE`. Isolation tests have to log in as `nyuma_api`.

## 3. Table inventory

Owners, keys, and grants below are the live catalog. `nyuma_api` holds the same table privileges as `nyuma_app` through membership. "Direct DML" means `has_table_privilege` for `nyuma_api` while RLS is off.

### Account-owned

| Table | Owner | Primary key | Tenant column | Foreign keys | `nyuma_api` direct DML | Definers that touch it |
| --- | --- | --- | --- | --- | --- | --- |
| `public.users` | `nyuma_owner` | `id` | `id` is the account. `auth_user_id` links the assertion subject. | None. Referenced by every tenant table. | `SELECT`, `INSERT`. No `UPDATE` or `DELETE`. | `nyuma_verified_account_id`, `nyuma_account_status`, `nyuma_lock_user`, `nyuma_set_active_role`, `nyuma_clear_active_role`, `nyuma_submit_role_requests`, `nyuma_list_role_requests`, `nyuma_approve_role_request`, `nyuma_users_guard` |
| `public.user_roles` | `nyuma_owner` | `(user_id, role)` | `user_id` | `user_id → users(id)` | `SELECT` only | `nyuma_set_active_role`, `nyuma_submit_role_requests`, `nyuma_list_role_requests`, `nyuma_approve_role_request`, `nyuma_revoke_ordinary_role`, `nyuma_guard_role_removal`, `nyuma_guard_role_request`, insert/outcome/purchase/commitment functions |
| `public.profiles` | `nyuma_owner` | `user_id` | `user_id` | `user_id → users(id)` | none | none in the function inventory |

`profiles` has `display_name` and `phone`. The API role has no privilege on it. It is still account-owned data and must not be left readable by the table owner after `FORCE`.

### Records owned by one account, with a counterparty

| Table | Owner | Primary key | Tenant column | Foreign keys | `nyuma_api` direct DML | Definers that touch it |
| --- | --- | --- | --- | --- | --- | --- |
| `public.listings` | `nyuma_owner` | `id` | `owner_id` | `owner_id → users(id)` | `SELECT`, `INSERT`, `UPDATE`, `DELETE` | listing guards and checks, locks, quantity sums, commitment/purchase/outcome writers, `nyuma_release_coordination_id`, `nyuma_guard_role_removal` |
| `public.buyer_demands` | `nyuma_owner` | `id` | `buyer_id` | `buyer_id → users(id)` | `SELECT`, `INSERT`, `UPDATE`, `DELETE` | demand guards and checks, locks, commitment writer, `nyuma_guard_role_removal` |

The market query selects open live listings and does not project `owner_id`. A direct session can still `SELECT owner_id` from any row the policy makes visible. RLS cannot hide one column of a visible row.

Agreement, purchase, and outcome reads join `listings` and `buyer_demands` and then apply `partySql` to the bound account id. An owner-only policy on those two tables hides the counterparty row from the other party, so the join returns no row for a legitimate participant.

### Records with two parties and no account column

| Table | Owner | Primary key | Tenant column | Foreign keys | `nyuma_api` direct DML | Definers that touch it |
| --- | --- | --- | --- | --- | --- | --- |
| `public.commitments` | `nyuma_owner` | `id` | none. Parties are `listing_id → listings.owner_id` and `buyer_demand_id → buyer_demands.buyer_id`. | both FKs `ON DELETE RESTRICT` | `SELECT` only | `nyuma_insert_commitment`, `nyuma_set_commitment_status`, purchase writer, guards, quantity sums |
| `public.purchases` | `nyuma_owner` | `id` | none. Parties are reached through `commitment_id` and `listing_id`. | both FKs `ON DELETE RESTRICT` | `SELECT` only | `nyuma_insert_purchase`, outcome writer, guards, quantity sums |
| `public.outcomes` | `nyuma_owner` | `id` | none. The listing owner is `listing_id → listings.owner_id`. A buyer reaches a `sold` row through `purchase_id`. | `listing_id`, `commitment_id`, `purchase_id` | `SELECT` only | `nyuma_insert_outcome`, outcome guards, quantity sums |

`notes` is on `outcomes`. The store returns notes only when the bound account owns the listing. A policy that lets the buyer `SELECT` the row also lets the buyer `SELECT notes`.

Writes already go through `nyuma_insert_commitment`, `nyuma_set_commitment_status`, `nyuma_insert_purchase`, and `nyuma_insert_outcome`. Those are `SECURITY DEFINER`, owned by `nyuma_fn_constraint`, and executable by `nyuma_app`. They call `nyuma_verified_account_id()` and require the caller to be a party with the matching role. RLS will not see their internal writes.

### System and administrative

| Table | Owner | Primary key | Tenant column | `nyuma_api` direct DML | Treatment |
| --- | --- | --- | --- | --- | --- |
| `public.coordination_ids` | `nyuma_owner` | `id` | none. Columns are `id` and `collection`. | `SELECT` only. Insert and delete run inside `nyuma_claim_coordination_id` and `nyuma_release_coordination_id`. | Not a shared catalog of commodities. It is the id registry. Leave it out of tenant policies. Enable RLS with no `nyuma_app` policy so the leftover `SELECT` returns nothing. The claim and release functions bypass RLS. |
| `public.role_requests` | `nyuma_owner` | `id` | `user_id → users(id)` | none | Account-owned history. Policies are for `nyuma_fn_request`, `nyuma_fn_approve`, `nyuma_fn_reject`, and `nyuma_operator` only. |
| `public.role_revocations` | `nyuma_owner` | `id` | `user_id → users(id)` | none | Append-only. `nyuma_fn_revoke` has `INSERT`. `nyuma_operator` has `SELECT`. |
| `public.schema_migrations` | `nyuma_owner` | `version` | none | none | Operational bookkeeping. Do not enable RLS. |
| `nyuma_private.assertion_keys` | `nyuma_fn_identity` | `kid` | none | none | HMAC secrets. Do not enable RLS. |
| `nyuma_private.verifier_config` | `nyuma_fn_identity` | `id` | none | none | Singleton issuer, audience, and `local_hs256_enabled`. Do not enable RLS. |
| `nyuma_private.local_test_hmac_keys` | `nyuma_fn_identity` | `kid` | none | none | Local HS256 material. The flag is false. Do not enable RLS. |
| `nyuma_private.jwt_public_keys` | `nyuma_fn_identity` | `kid` | none | none | Unused by the current `nya1` verifier. Do not enable RLS. |

Commodity, location, and status values are `CHECK` constraints, not tables. There is no shared reference table that should stay world-readable.

`nyuma_private` stays without RLS because the verifier owner is the table owner, the API has no grant, and a policy that called the verifier would recurse into the key lookup. `schema_migrations` stays without RLS because the migrator is the superuser and the table has no tenant rows. `coordination_ids` is the one system table that should still be enabled: the API currently has a direct `SELECT`, and the table reveals every issued coordination id.

## 4. SECURITY DEFINER and trigger assessment

Every `public.nyuma_*` function in the catalog is listed. Trigger functions are included. `nyuma_private` cryptographic helpers (`hmac`, `base64url_encode`, `base64url_decode`, `verify_nya1_subject`) are owned by `nyuma_fn_identity`, pinned to `pg_catalog, nyuma_private, pg_temp`, and do not read tenant tables. They stay safe if `nyuma_private` RLS remains off.

`BYPASSRLS` on the owner means the function body is not filtered after RLS is enabled. A party check inside that body is mandatory. A missing check is a cross-account read or write.

### Identity functions

| Function | Owner | Owner bypass | Path | Tables | Identity source | Caller-supplied account | Safe after RLS |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `nyuma_verified_sub()` | `nyuma_fn_identity` | no | `pg_catalog, nyuma_private, pg_temp` | `verifier_config`, `assertion_keys`, `local_test_hmac_keys` | transaction-local assertion only | no argument | yes, if `nyuma_private` RLS stays off |
| `nyuma_verified_account_id()` | `nyuma_fn_identity` | no | `pg_catalog, pg_temp` | `users` | `nyuma_verified_sub()` plus `status = 'active'` | no argument | only with a `users` policy for `nyuma_fn_identity` that calls `nyuma_verified_sub()` and does not call this function |
| `nyuma_account_status()` | `nyuma_fn_identity` | no | `pg_catalog, pg_temp` | `users` | verified subject, any status | no argument | same policy. It must keep returning a suspended status. |
| `nyuma_identity_verification_mode()` | `nyuma_fn_identity` | no | `pg_catalog, pg_temp` | none | none | no | yes. Returns the fixed mode string. |

### `nyuma_fn_constraint` — keep the bypass

These functions are all `SECURITY DEFINER`, owned by `nyuma_fn_constraint`, `search_path = pg_catalog, public, pg_temp`, owner `BYPASSRLS = true`. RLS will not constrain them. They must keep the bypass so a quantity sum still sees the other party's child rows. A policy written as "the current user is `nyuma_fn_constraint`" would be redundant and, if forgotten, fail-open only if someone later removed the bypass. Do not express the bypass as a policy.

| Function | Tables | Verified-account check | Direct `nyuma_api` execute | Why the bypass stays |
| --- | --- | --- | --- | --- |
| `nyuma_lock_user(uuid)` | `users` | yes, unless `session_user` is operator or provisioner | yes | Lock of the caller's account during writes. The argument must equal the verified account. |
| `nyuma_lock_listing(text)` | `listings` | no | no | Internal row lock. Callers are other constraint functions that already checked the party. |
| `nyuma_lock_demand(text)` | `buyer_demands` | no | no | Same. |
| `nyuma_lock_for_commitment(text, text)` | listings, demands | no | no | Orders the two locks. |
| `nyuma_lock_for_purchase(text)` | commitments, listings, demands | no | no | Internal. |
| `nyuma_lock_for_outcome(text, text)` | listings, purchases | no | no | Internal. |
| `nyuma_listing_held_grams(text)` | commitments, purchases | no | no | Sum across both parties. An invoker sum under-counts. |
| `nyuma_listing_accounted_grams(text)` | purchases, outcomes | no | no | Same. |
| `nyuma_listing_outcome_grams(text)` | outcomes | no | no | Same. |
| `nyuma_demand_held_grams(text)` | commitments, purchases | no | no | Same. |
| `nyuma_assert_listing_quantities(text)` | listings plus the gram helpers | no | no | Raises when the cap breaks. Must see every child. |
| `nyuma_assert_demand_hold(text)` | demands plus helper | no | no | Same. |
| `nyuma_assert_commitment_purchases(text)` | commitments, purchases | no | no | Same. |
| `nyuma_assert_sold_link(text)` | purchases, outcomes | no | no | Same. |
| `nyuma_listings_check()` | calls the listing assert | no | yes, as a trigger | Trigger. Bypass keeps the cap honest. |
| `nyuma_demands_check()` | calls the demand assert | no | yes, as a trigger | Same. |
| `nyuma_commitments_check()` | calls three asserts | no | yes, as a trigger | Same. |
| `nyuma_purchases_check()` | calls two asserts | no | yes, as a trigger | Same. |
| `nyuma_outcomes_check()` | calls two asserts | no | yes, as a trigger | Same. |
| `nyuma_commitments_guard()` | listings, demands, purchases | no; the insert function checked the party before the trigger | yes, as a trigger | Cross-row rules. Must read both parties. |
| `nyuma_purchases_guard()` | commitments | no | yes, as a trigger | Same. |
| `nyuma_outcomes_guard()` | listings, commitments, purchases | no | yes, as a trigger | Same. |
| `nyuma_claim_coordination_id()` | `coordination_ids` | no | yes, as a trigger | Allocates an id. Not tenant data. |
| `nyuma_release_coordination_id()` | `coordination_ids` | yes for listing and demand deletes: verified account must equal `OLD.owner_id` or `OLD.buyer_id`, unless operator or provisioner | yes, as a trigger | Bypass lets the delete see `OLD` even when the caller's policy would hide the registry row. The owner comparison is the tenant check. |
| `nyuma_guard_role_removal()` | listings, demands, `user_roles` | uses `nyuma_lock_user` | yes, as a trigger | Must see the account's open records before a role disappears. |
| `nyuma_set_active_role(uuid, text)` | `users`, `user_roles` | yes. `p_user_id` must equal the verified account. | yes | Bypass updates `active_role`. The equality check is the tenant check. A policy cannot see this update because the owner bypasses RLS. |
| `nyuma_insert_commitment(...)` | listings, demands, commitments, `user_roles` | yes. Caller must own the listing as farmer/trader or own the demand as buyer. | yes | Bypass insert. The party check is the tenant check. A forged listing id fails that check. |
| `nyuma_insert_purchase(...)` | commitments, listings, demands, purchases, `user_roles` | yes, same party rule | yes | Same. |
| `nyuma_insert_outcome(...)` | listings, purchases, outcomes, `user_roles` | yes. Verified account must own the listing and hold farmer or trader. | yes | Same. Buyer-supplied ids cannot insert. |
| `nyuma_set_commitment_status(text, text)` | commitments, listings, demands, `user_roles` | yes, party rule | yes | Status change without a table `UPDATE` grant. |

`nyuma_lock_listing`, `nyuma_lock_demand`, the gram helpers, and the assert helpers are not executable by `nyuma_api`. The API cannot call them to read another account's rows. The functions the API can call are the ones that compare the verified account before they write.

### `nyuma_fn_request` — no bypass, policies required

| Function | Owner bypass | Tables | Identity | Safe after RLS |
| --- | --- | --- | --- | --- |
| `nyuma_submit_role_requests(uuid, text[])` | no | `users`, `user_roles`, `role_requests` | requires `p_auth_user_id = nyuma_verified_sub()` and an active status | no, until `SELECT`/`INSERT` policies exist for `nyuma_fn_request` on those three tables |
| `nyuma_list_role_requests(uuid)` | no | same | same subject check | no, until the `SELECT` policies exist |

Both are executable by `nyuma_api`. The supplied auth-user id cannot name another subject: the function rejects a mismatch. After RLS, a missing policy makes the function see zero rows and fail closed, which also breaks the legitimate caller. The policies belong in the migration that enables RLS on these tables.

### Decision and revocation — no bypass

| Function | Owner | Tables | Who may call | Tenant check | Safe after RLS |
| --- | --- | --- | --- | --- | --- |
| `nyuma_approve_role_request(uuid, text)` | `nyuma_fn_approve` | `role_requests`, `user_roles`, `users` | `nyuma_operator` only | `session_user` must be the operator. The request id is the operator's argument. | needs `SELECT`/`UPDATE` on `role_requests` and `SELECT`/`INSERT` on `user_roles` for `nyuma_fn_approve`, plus `SELECT` on `users` |
| `nyuma_reject_role_request(uuid, text)` | `nyuma_fn_reject` | `role_requests`, `users` | `nyuma_operator` only | same | needs `SELECT`/`UPDATE` on `role_requests` for `nyuma_fn_reject` |
| `nyuma_revoke_ordinary_role(uuid, text, text)` | `nyuma_fn_revoke` | `user_roles`, `role_revocations`, `users` | `nyuma_operator` only | operator `session_user`; the user id is the operator's argument | needs `SELECT`/`DELETE` on `user_roles`, `INSERT` on `role_revocations`, `SELECT`/`UPDATE` on `users` for `nyuma_fn_revoke` |
| `nyuma_clear_active_role(uuid, text)` | `nyuma_fn_revoke` | `users` | not granted to `nyuma_api`; called by the revoke function | runs as the revoke owner | covered by the `users` `UPDATE` policy for `nyuma_fn_revoke` |

These roles are `NOLOGIN`. `nyuma_api` is not a member. A policy of `USING (true)` for that role is the table-level grant matching the function's existing privilege. The operator check stays in the function, because a policy cannot see `session_user` membership as a substitute for reviewing the function. Do not grant these policies to `nyuma_app`.

### Invoker triggers and helpers

These are not `SECURITY DEFINER`. They run as the current user. After RLS, they see only rows that user's policies allow. That is correct for the owner guards. It is the wrong visibility for quantity checks, which is why those checks are already definers.

| Function | Owner | Path | What it enforces | After RLS |
| --- | --- | --- | --- | --- |
| `nyuma_listings_guard()` | `nyuma_owner` | `pg_catalog, public` | `INSERT` calls `nyuma_lock_user`. `UPDATE` requires `owner_id` unchanged and, for an ordinary session, `owner_id = nyuma_verified_account_id()`. | Runs as `nyuma_api`. The lock and the account function must already resolve. |
| `nyuma_demands_guard()` | `nyuma_owner` | same | Same for `buyer_id`. | Same. |
| `nyuma_users_guard()` | `nyuma_owner` | same | `INSERT` requires `auth_user_id = nyuma_verified_sub()`. `UPDATE` freezes `id` and `auth_user_id`. `active_role` must be an assigned role. | Runs as the session. The `user_roles` read must be allowed for that session. |
| `nyuma_guard_administrator_role()` | `nyuma_owner` | same | Blocks an administrator grant unless `current_user` is the provisioner. | Invoker. Unchanged by row visibility. |
| `nyuma_guard_role_request()` | `nyuma_owner` | same | Request shape and one-pending rule. Reads `user_roles`. | The request function is the definer, so this trigger runs as `nyuma_fn_request` and needs that role's `user_roles` policy. |
| `nyuma_guard_role_revocation()` | `nyuma_owner` | same | Append-only shape. | Runs as `nyuma_fn_revoke`. |
| `nyuma_user_roles_no_update()` | `nyuma_owner` | same | Rejects `UPDATE` of `user_roles`. | Unchanged. |
| `nyuma_grams(numeric)` | `nyuma_owner` | same | Unit conversion. | No table read. Execute revoked from `nyuma_app`. |
| `nyuma_is_time_compatible(text, text)` | `nyuma_owner` | same | Window check. | No table read. Execute revoked from `nyuma_app`. |
| `nyuma_grant_administrator(uuid)` | `nyuma_owner` | same | Provisioner entry. Invoker. | The provisioner needs `INSERT` policy on `user_roles`. |

### Triggers

| Table | Trigger | Function | Definer |
| --- | --- | --- | --- |
| `listings` | `listings_guard` | `nyuma_listings_guard` | no |
| `listings` | `listings_check` | `nyuma_listings_check` | yes, bypass |
| `listings` | `listings_claim_id` | `nyuma_claim_coordination_id` | yes, bypass |
| `listings` | `listings_release_id` | `nyuma_release_coordination_id` | yes, bypass |
| `buyer_demands` | `buyer_demands_guard` | `nyuma_demands_guard` | no |
| `buyer_demands` | `buyer_demands_check` | `nyuma_demands_check` | yes, bypass |
| `buyer_demands` | `buyer_demands_claim_id` | `nyuma_claim_coordination_id` | yes, bypass |
| `buyer_demands` | `buyer_demands_release_id` | `nyuma_release_coordination_id` | yes, bypass |
| `commitments` | `commitments_guard` | `nyuma_commitments_guard` | yes, bypass |
| `commitments` | `commitments_check` | `nyuma_commitments_check` | yes, bypass |
| `commitments` | `commitments_claim_id` | `nyuma_claim_coordination_id` | yes, bypass |
| `purchases` | `purchases_guard` | `nyuma_purchases_guard` | yes, bypass |
| `purchases` | `purchases_check` | `nyuma_purchases_check` | yes, bypass |
| `purchases` | `purchases_claim_id` | `nyuma_claim_coordination_id` | yes, bypass |
| `outcomes` | `outcomes_guard` | `nyuma_outcomes_guard` | yes, bypass |
| `outcomes` | `outcomes_check` | `nyuma_outcomes_check` | yes, bypass |
| `outcomes` | `outcomes_claim_id` | `nyuma_claim_coordination_id` | yes, bypass |
| `users` | `users_guard` | `nyuma_users_guard` | no |
| `user_roles` | `user_roles_guard_admin` | `nyuma_guard_administrator_role` | no |
| `user_roles` | `user_roles_guard_removal` | `nyuma_guard_role_removal` | yes, bypass |
| `user_roles` | `user_roles_no_update` | `nyuma_user_roles_no_update` | no |
| `role_requests` | `role_requests_guard` | `nyuma_guard_role_request` | no |
| `role_revocations` | `role_revocations_guard` | `nyuma_guard_role_revocation` | no |

## 5. Proposed policies

Policies name `nyuma_app` for application sessions. `nyuma_api` inherits the role, so it is covered. Every application predicate obtains the account with `nyuma_verified_account_id()`. Insert and update checks repeat the predicate in `WITH CHECK`, so a row cannot be written into a shape the same role could not read.

No policy may call `nyuma_verified_account_id()` from a role whose lookup itself reads the protected table. The identity-role exception is stated on `users`.

No policy may subquery `listings` or `buyer_demands` to decide whether a commitment, purchase, or outcome is visible. That subquery is itself under RLS and hides the counterparty. Participation is a new `SECURITY DEFINER` function owned by `nyuma_fn_constraint`. The function reads the party tables under the bypass, compares them with `nyuma_verified_account_id()`, and returns boolean. It accepts the row id, not an account id. It returns false for every non-participant, including a missing row. `EXECUTE` goes to `nyuma_app` only.

Proposed helpers, created before any `ENABLE`:

- `nyuma_listing_owner_access(owner_id uuid)` — verified account equals `owner_id` and that account has `farmer` or `trader` in `user_roles`.
- `nyuma_demand_owner_access(buyer_id uuid)` — verified account equals `buyer_id` and that account has `buyer`.
- `nyuma_commitment_participant(commitment_id text)` — verified account is the listing owner with farmer/trader, or the demand owner with buyer.
- `nyuma_purchase_participant(purchase_id text)` — same, through the purchase's commitment.
- `nyuma_outcome_listing_owner(outcome_id text)` — verified account owns the listing and has farmer/trader.
- `nyuma_outcome_buyer(outcome_id text)` — category is `sold`, a purchase is linked, and the verified account owns that demand and has buyer.

The helpers exist so policies do not recurse. They are not a second identity source.

### `public.users`

| Operation | Role | `USING` | `WITH CHECK` |
| --- | --- | --- | --- |
| `SELECT` | `nyuma_fn_identity` | `auth_user_id = nyuma_verified_sub()` | — |
| `SELECT` | `nyuma_app` | `auth_user_id = nyuma_verified_sub()` | — |
| `INSERT` | `nyuma_app` | — | `auth_user_id = nyuma_verified_sub() AND status = 'active' AND active_role IS NULL` |
| `SELECT` | `nyuma_fn_request` | `auth_user_id = nyuma_verified_sub()` | — |
| `SELECT` | `nyuma_fn_approve`, `nyuma_fn_reject`, `nyuma_operator`, `nyuma_provisioner` | `true` | — |
| `UPDATE` | `nyuma_fn_revoke` | `true` | `true` |

`nyuma_app` has no `UPDATE` or `DELETE` grant. Add no write policy for those operations. A later grant then fails closed.

The application `SELECT` uses `nyuma_verified_sub()`, not `nyuma_verified_account_id()`. `findAccount` and `bootstrap` read `users` by subject and then reject a non-active status in application code. A policy that hides the suspended row makes that read return no row, and the API reports `account-not-bootstrapped` instead of `account-disabled`. Section 11 is the corrected statement. Listing, demand, and agreement policies still use `nyuma_verified_account_id()`, so a suspended account still receives no protected coordination rows.

The identity-role policy is what stops recursion. It calls `nyuma_verified_sub()`, which does not read `users`. Do not add a `nyuma_fn_constraint` policy. That role bypasses RLS. A `USING (true)` policy would become a full-table read if the bypass were later removed.

`WITH CHECK` on the revoke update cannot see the old row. `nyuma_users_guard` is what freezes `id` and `auth_user_id`.

Cross-account insert: `WITH CHECK` ties `auth_user_id` to the verified subject. The existing `users_guard` trigger does the same. Neither accepts a caller-chosen `users.id` as authority over another subject.

### `public.user_roles`

| Operation | Role | `USING` | `WITH CHECK` |
| --- | --- | --- | --- |
| `SELECT` | `nyuma_app` | `user_id = nyuma_verified_account_id()` | — |
| `SELECT` | `nyuma_fn_request` | `user_id` belongs to `auth_user_id = nyuma_verified_sub()` | — |
| `INSERT` | `nyuma_fn_approve` | — | `true` |
| `SELECT`, `DELETE` | `nyuma_fn_revoke` | `true` | — |
| `SELECT`, `INSERT`, `DELETE` | `nyuma_provisioner` | `true` | `role = 'administrator'` is still rejected by `nyuma_guard_administrator_role` unless the current user is the provisioner |
| `SELECT` | `nyuma_operator` | `true` | — |

No `UPDATE` policy. The no-update trigger stays. `nyuma_app` cannot insert a role for account B, because it has no `INSERT` grant and no `INSERT` policy.

Workspace loss: after revocation deletes the role, the `nyuma_app` listing and demand policies fail the role predicate, so the account stops seeing those rows.

### `public.profiles`

No `nyuma_app` policy. `ENABLE` denies the API. `FORCE` denies a direct `nyuma_owner` session. A later product milestone can add `SELECT`/`UPDATE` for `user_id = nyuma_verified_account_id()` when the API starts reading profiles. Phone and display name stay account-private until that policy exists.

### `public.listings`

| Operation | Role | `USING` | `WITH CHECK` |
| --- | --- | --- | --- |
| `SELECT`, `UPDATE`, `DELETE` | `nyuma_app` | `nyuma_listing_owner_access(owner_id)` | `UPDATE`: `owner_id` is unchanged and `nyuma_listing_owner_access(owner_id)` |
| `INSERT` | `nyuma_app` | — | `nyuma_listing_owner_access(owner_id)` |

There is no market `SELECT` policy on the base table. Open live rows for other accounts are exposed through a `security_barrier` view owned by `nyuma_fn_constraint`, with `security_invoker = false`. The view projects `id, commodity, quantity, quantity_unit, quantity_kind, location, availability_window, asking_price_ksh_per_kg, status` and filters `status = 'open' AND origin = 'live'`. It does not project `owner_id`. `SELECT` on the view goes to `nyuma_app`. The market store reads the view. A direct `SELECT owner_id FROM listings` then returns only the caller's own rows.

Forged insert: `WITH CHECK` rejects `owner_id` of account B. The listing guard and `nyuma_lock_user` still require the verified account.

Ownership change: `WITH CHECK` rejects an `UPDATE` that sets `owner_id` to B. The guard trigger also rejects a changed `owner_id`.

Delete: `USING` rejects account B's id. `nyuma_release_coordination_id` repeats the owner comparison.

### `public.buyer_demands`

Same shape, with `buyer_id` and `nyuma_demand_owner_access`. No market policy on the base table. A barrier view projects the demand columns the market already returns and omits `buyer_id`.

### `public.commitments`

| Operation | Role | `USING` | `WITH CHECK` |
| --- | --- | --- | --- |
| `SELECT` | `nyuma_app` | `nyuma_commitment_participant(id)` | — |

No `INSERT`, `UPDATE`, or `DELETE` policy. The API grant is `SELECT` only. Inserts and status changes stay on `nyuma_insert_commitment` and `nyuma_set_commitment_status`, which check the verified party and then bypass RLS.

The helper is what lets either party see a commitment without a policy subquery on the other party's table. The store's current inner join of `listings` and `buyer_demands` returns no row for either party once those tables are owner-only. That store change belongs with migration 015, which is when those policies turn on. Section 11 has the measurement.

A forged insert through the function fails the function's party check. A direct insert fails the missing grant and the missing policy.

### `public.purchases`

`SELECT` for `nyuma_app` using `nyuma_purchase_participant(id)`. No write policy. Writes stay on `nyuma_insert_purchase`.

### `public.outcomes`

| Operation | Role | `USING` | `WITH CHECK` |
| --- | --- | --- | --- |
| `SELECT` | `nyuma_app` | `nyuma_outcome_listing_owner(id)` | — |

The buyer does not receive a base-table policy. A barrier view owned by `nyuma_fn_constraint` returns sold outcomes for `nyuma_outcome_buyer(id)` and omits `notes`. The store's buyer branch reads that view. The owner branch keeps reading the base table, notes included.

This split is required. A single policy that shows the row to both parties lets the buyer select `notes`.

### `public.role_requests`

| Operation | Role | `USING` | `WITH CHECK` |
| --- | --- | --- | --- |
| `SELECT`, `INSERT` | `nyuma_fn_request` | `user_id` of `auth_user_id = nyuma_verified_sub()` | same |
| `SELECT`, `UPDATE` | `nyuma_fn_approve` | `true` | `true` |
| `SELECT`, `UPDATE` | `nyuma_fn_reject` | `true` | `true` |
| `SELECT` | `nyuma_operator` | `true` | — |

No `nyuma_app` policy. The API reaches this table only through the request functions. A caller cannot pass another account's user id: `nyuma_submit_role_requests` compares the argument with `nyuma_verified_sub()`.

### `public.role_revocations`

| Operation | Role | `USING` | `WITH CHECK` |
| --- | --- | --- | --- |
| `INSERT` | `nyuma_fn_revoke` | — | `true` |
| `SELECT` | `nyuma_operator` | `true` | — |

No `nyuma_app` policy. The revoke function is the only writer, and only an operator session can execute it.

### `public.coordination_ids`

No permissive policy. After `ENABLE`, `nyuma_api` `SELECT` returns zero rows. Claim and release continue as `nyuma_fn_constraint`.

### Tables with no policy and no RLS

`public.schema_migrations` and all four `nyuma_private` tables. Justification is in the inventory. Enabling RLS there does not isolate tenants and can break the verifier or the migrator.

## 6. FORCE ROW LEVEL SECURITY

`ENABLE ROW LEVEL SECURITY` applies to `nyuma_api`, `nyuma_app`, and every function owner that lacks `BYPASSRLS` and does not own the table. It does not apply to:

- the table owner, `nyuma_owner`, while `FORCE` is off
- `nyuma_fn_constraint`, because `BYPASSRLS` wins over both `ENABLE` and `FORCE`
- the cluster superuser `nyuma`, which is today's migration login

`FORCE` is necessary on every tenant table whose owner is `nyuma_owner`: `users`, `user_roles`, `profiles`, `listings`, `buyer_demands`, `commitments`, `purchases`, `outcomes`, `role_requests`, `role_revocations`, and `coordination_ids`. Without it, a `nyuma_owner` login reads and writes every row and skips the policies. That login exists, does not inherit the function roles, and still owns the tables.

`FORCE` does not change `nyuma_api`. It does change direct SQL run as `nyuma_owner`: repairs and ad-hoc reads become subject to the policies. The owner can `SET ROLE nyuma_fn_constraint` and then bypass RLS, because the bypass is an attribute of the current user. That remains an operator path. The API cannot take it.

`FORCE` does not change the constraint functions. It does subject `nyuma_fn_identity`, `nyuma_fn_request`, and the decision roles to the policies above. Those policies have to exist before `ENABLE`, and `FORCE` should follow only after the `ENABLE` tests pass.

Do not put `FORCE` in the migration that first enables a table. A bad policy under `FORCE` also blocks the owner's own diagnostic `SELECT`. The superuser can still disable it. Rollback of the force migration is `NO FORCE ROW LEVEL SECURITY` and leaves the policies and `ENABLE` in place.

`nyuma_private` tables are owned by `nyuma_fn_identity`. `FORCE` there would subject the verifier to policies on its own key tables. Do not enable and do not force those tables.

## 7. Integration tests

Setup uses the superuser only to insert two accounts, their roles, and fixture rows, and to install a local assertion key inside a transaction that the test controls. Every assertion in the ten groups below runs on a real `nyuma_api` login, empty password, trust, port 5433, database `nyuma_dev`. `SET ROLE nyuma_api` on the superuser connection is not evidence.

Each case mints a fresh `nya1` for that account, starts a transaction, sets `nyuma.access_token` with `set_config(..., true)`, and rolls back or commits. After release, the next checkout on that pool reads an empty transaction-local setting and `nyuma_verified_sub()` returns null.

1. Account A cannot read account B's `users`, `user_roles`, `listings`, `buyer_demands`, `commitments`, `purchases`, `outcomes`, `role_requests`, or `role_revocations` rows. Run as `nyuma_api`.
2. Account A cannot `UPDATE` or `DELETE` account B's listings or demands. Run as `nyuma_api`. Updates and deletes of commitments, purchases, and outcomes fail the grant as well as the missing policy.
3. Account A cannot `INSERT` a listing with `owner_id` of B, a demand with `buyer_id` of B, or a user with B's `auth_user_id`. Run as `nyuma_api`.
4. Account A cannot `UPDATE` its own listing or demand to B's account id. Run as `nyuma_api`. Expect the policy or the guard exception, and the same owner afterwards.
5. A missing setting, an empty setting, a bad MAC, an expired `nya1`, and an HS256 bearer while the flag is false all leave `nyuma_verified_account_id()` null and every protected `SELECT` empty. Run as `nyuma_api`.
6. A suspended account with a valid `nya1` gets null from `nyuma_verified_account_id()`, no protected rows, and still receives its status from `nyuma_account_status()`. Run as `nyuma_api`. Restore the account to `active` in cleanup.
7. Account A can insert, select, update, and delete its own listing and demand; can read its own commitment, purchase, and outcome; and the market view returns B's open listing without `owner_id`. The counterparty read of an agreement still returns the row through the view or helper. Run as `nyuma_api`.
8. As `nyuma_api`, `nyuma_insert_commitment`, `nyuma_insert_purchase`, `nyuma_insert_outcome`, and `nyuma_set_commitment_status` reject B's ids when the assertion is A's. `nyuma_set_active_role` rejects B's user id. `nyuma_lock_listing` and the gram helpers are not executable. `nyuma_submit_role_requests` rejects B's subject. Approve, reject, and revoke are not executable.
9. As `nyuma_api`, `ALTER TABLE ... DISABLE ROW LEVEL SECURITY`, `DROP POLICY`, and `CREATE POLICY` fail with `42501`. Run as `nyuma_api`, not as the owner.
10. Two checkouts on one `nyuma_api` pool: the first sets A's assertion and rolls back; the second reads the setting before its own `set_config` and gets the empty string, with a null subject. A serialization retry mints a new assertion and does not commit the first one. This repeats the Milestone 3C cleanup proof after RLS is on.

Also run, as the superuser observing `pg_class` only: `relrowsecurity` true on the enabled tables, `relforcerowsecurity` matching the force migration under test, and both flags still false on `nyuma_private` and `schema_migrations`.

## 8. Migration sequence

One table family per migration. Policies are created in the same migration that enables RLS, before the `ENABLE` statement. Each migration is transactional. The application change that reads a new view ships in the same release as the `ENABLE` that would otherwise hide those rows.

Rollback files live under `server/migrations/rollback/` and are not applied by the migrator. Each guard uses the numeric prefix rule from Milestone 3B.1: a version must match `^[0-9]+_.+$`, the prefix is an integer from 0 through 2147483647, and a later migration is a greater prefix. The guard refuses when its own version is absent or a later prefix is present. It then disables RLS and drops only the policies and helpers that migration created. It does not drop tables, columns, assertions, or keys.

| Migration | What it changes | What must already be true | Rollback restores |
| --- | --- | --- | --- |
| `013_rls_predicates.sql` | The six boolean helpers. No `ENABLE`. | `nyuma_verified_account_id()` is the 012 body. | Drops the helpers if no later RLS migration is applied. |
| `014_rls_accounts.sql` | Policies, then `ENABLE`, on `users`, `user_roles`, `profiles`, `role_requests`, `role_revocations`. | 013 applied. Identity policy does not call the account function. | `DISABLE` and `DROP POLICY` on those five tables. |
| `015_rls_market_records.sql` | Owner policies, barrier views, then `ENABLE` on `listings` and `buyer_demands`. In the same release, market reads use the views, and agreement, purchase, and outcome reads stop inner-joining the other party's base table. | 014 applied. The store change is part of this release, not of 016. | Drops the views, disables RLS, drops the policies. |
| `016_rls_agreements.sql` | Participant policies and the notes-free outcome view, then `ENABLE` on `commitments`, `purchases`, and `outcomes`. | 015 applied, and the store no longer needs the counterparty base row to decide visibility. | Drops the outcome view, disables RLS, drops the policies. |
| `017_rls_coordination_ids.sql` | `ENABLE` on `coordination_ids` with no permissive policy. | Claim and release are still owned by `nyuma_fn_constraint`. | `DISABLE`. |
| `018_rls_force.sql` | `FORCE` on the eleven `public` tables listed in section 6. | 014 through 017 applied and their tests passing. | `NO FORCE` only. Leaves policies and `ENABLE`. |

Do not enable all sixteen tables in one migration. `schema_migrations` and `nyuma_private` stay out of this sequence.

Existing writes keep working through the sequence because:

- Account bootstrap still inserts `users` under the verified-subject check.
- Listing and demand writes still pass `nyuma_lock_user` and the owner `WITH CHECK`.
- Commitment, purchase, and outcome writes stay on the bypass functions, which already check the party.
- Role submission keeps seeing its rows once the 014 policies for `nyuma_fn_request` exist.
- Quantity triggers keep seeing every child row through `BYPASSRLS`.

The break to avoid is enabling owner-only listing and demand policies while `listAgreements`, `readAgreement`, `createPurchase`, `listPurchases`, `readPurchase`, and `outcomeListSql` still inner-join both base tables. That join returns no row for either party. `listOpenListings` and `listOpenDemands` must read the barrier views in the same release. Section 11 records the rolled-back measurement.

## 9. Risks, assumptions, unresolved questions

Assumptions:

- The application session remains a real `nyuma_api` login, not the superuser and not `nyuma_owner`.
- `nyuma_fn_constraint` keeps `BYPASSRLS` and keeps the party checks in the four write functions, `nyuma_lock_user`, `nyuma_set_active_role`, and `nyuma_release_coordination_id`.
- `local_hs256_enabled` stays false outside the local test setup. Policies do not read that flag.
- Hosted Supabase is out of scope. This plan is the local cluster. `pgcrypto` in `nyuma_private` is not assumed to match a hosted `extensions` schema.
- Assertion format and the 120-second lifetime stay as they are. A transaction that outlives `exp` can fail a later statement because the account function is `VOLATILE` and re-reads the clock. The pool already bounds work with `statement_timeout` of 15 seconds. Policies do not widen that window.

Risks the sequence is built around:

- A `users` policy that calls `nyuma_verified_account_id()` recurses. The identity policy must call `nyuma_verified_sub()` only.
- Enabling RLS without policies for `nyuma_fn_request` and the decision roles makes those functions fail closed and breaks role workflow.
- An owner-only listing policy without a view change makes the market and the counterparty joins return no rows.
- A shared outcome policy leaks `notes`. A shared market policy leaks `owner_id` to any direct `SELECT`.
- Removing `BYPASSRLS` from `nyuma_fn_constraint` makes quantity caps under-count. Do not remove it in the RLS migrations.
- `FORCE` on the first enable blocks the table owner's own inspection. It is a separate, later migration.
- `nyuma_owner` can still `SET ROLE nyuma_fn_constraint` and bypass RLS. That is an operator capability, not an API capability.

Unresolved, and not blockers for writing the later migrations:

- Whether a future profile screen needs its own `SELECT`/`UPDATE` policy. Until the API reads `profiles`, the table stays deny-all.
- Whether operator review screens need a narrower `role_requests` policy than `USING (true)` for the decision roles. The roles are `NOLOGIN` and not granted to the API. Narrowing them is a later hardening pass.
- The coordination store still passes a bound account id into SQL. After RLS, that predicate is redundant for security and still useful as a second filter. The implementation should not start trusting it.

## 10. Recommendation

**Migration 013 is implemented** as `server/migrations/013_rls_predicates.sql`. It creates the six helpers and grants `EXECUTE` on those new functions. It does not enable RLS. Section 11.10 records the result. Migrations 014 through 018 remain unapplied.

**NO-GO for migrations 014 through 018** until section 11's corrections are implemented with them. **NO-GO** for enabling or forcing RLS in the current tree, for one migration that covers every table, and for any policy that treats `nyuma.user_id`, a request parameter, or a function argument as the account.

The conditions for the later milestone are:

1. `nyuma_verified_account_id()` is the identity expression for coordination policies. `users` policies for `nyuma_app`, `nyuma_fn_identity`, and `nyuma_fn_request` call `nyuma_verified_sub()` so a suspended account remains visible to itself and the lookup does not recurse.
2. Participation and owner checks used by policies are bypass-owned boolean helpers, not RLS subqueries on the counterparty table.
3. Market rows and buyer-visible outcomes are barrier views that omit `owner_id`, `buyer_id`, and `notes`.
4. `nyuma_fn_constraint` keeps `BYPASSRLS`. Decision and request roles get explicit policies before `ENABLE`.
5. `FORCE` is a separate migration after the enable tests pass.
6. `nyuma_private` and `schema_migrations` stay without RLS.
7. The ten integration groups run as real `nyuma_api` connections.
8. Each rollback uses the numeric prefix guard and restores only the policies, views, helpers, and RLS flags that migration introduced.

## 11. Stage E2 verification

Stage E2 re-read migrations `000` through `012`, the live catalog on `nyuma_dev` port 5433, all 53 `nyuma_*` and `nyuma_private` verifier functions, the 23 user triggers, and the API queries in `server/src/coordination/store.ts` and `server/src/auth/identity.ts`. The catalog still has zero views, zero policies, and RLS off. No policy SQL was executed. Fixture rows used to check predicates were inserted in a transaction and removed with `ROLLBACK`. A follow-up count of listing `e2a` was 0.

### 11.1 Discrepancies

| Finding | E1 statement | Live evidence | Correction |
| --- | --- | --- | --- |
| Suspended account read | `nyuma_app` `SELECT` on `users` uses `id = nyuma_verified_account_id()` | `findAccount` and `bootstrap` select `users` by `auth_user_id`. Dispatch turns a missing row into `account-not-bootstrapped` and a non-active status into `account-disabled`. | Application `SELECT` uses `auth_user_id = nyuma_verified_sub()`. Coordination policies still use the account function, which is null while suspended. |
| Constraint policies | `USING (true)` for `nyuma_fn_constraint`, described as fail-closed if the bypass is removed | The role has `BYPASSRLS`, so the policy never runs. `USING (true)` would grant every row if the bypass were removed. | Do not create those policies. Removal of the bypass then fails closed, and quantity checks would need a separate design. |
| Revoke `WITH CHECK` | Policy says `id` and `auth_user_id` are unchanged | `WITH CHECK` sees the new row only. `nyuma_users_guard` already rejects changes to those columns. | `UPDATE` policy for `nyuma_fn_revoke` is `USING (true) WITH CHECK (true)`. The trigger remains the freeze. |
| Agreement joins | The join fails for the counterparty, and the store change can wait for migration 016 | Rolled-back rows: listing owner A, buyer B, commitment `e2c`. Under owner-only visibility the inner join count was 0 for A and 0 for B. `SELECT` of the commitment without the join was 1 for both. | Stop those joins in the same release as migration 015, when listing and demand RLS first hides the other party's row. |
| Trigger `EXECUTE` | Described as trigger-only | ACL of `nyuma_claim_coordination_id` includes `nyuma_app`. A real `nyuma_api` session called five trigger functions. Each failed with SQLSTATE `0A000`, `trigger functions can only be called as triggers`. `coordination_ids` stayed at 3596. | No function change is required for 013. The body does not start. Revoking `EXECUTE` from `nyuma_app` is optional hardening, not a 013 gate. |
| Owner helper | Sketch can read `user_roles` for the supplied account id | A boolean `AND EXISTS` is not a reliable short-circuit. Granted to `nyuma_app`, that would answer whether another uuid holds farmer or trader. | The role predicate compares `user_id` to `nyuma_verified_account_id()` and to the row's owner. |

No other table, owner, grant, or function-owner discrepancy turned up. The 50 `public.nyuma_*` functions and `nyuma_private.verify_nya1_subject`, `base64url_encode`, and `base64url_decode` match section 4. `pgcrypto` routines in `nyuma_private` do not read tenant tables.

### 11.2 Exact helper SQL for migration 013

Do not execute this in Stage E2. Every helper is `VOLATILE` because `nyuma_verified_account_id()` is `VOLATILE`. Each one returns boolean, takes no account-id argument except the row's own owner column, and reads party tables as `nyuma_fn_constraint`. A missing id and a non-participant both return false.

```sql
CREATE FUNCTION public.nyuma_listing_owner_access(p_owner_id uuid)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles AS roles
    WHERE roles.user_id = public.nyuma_verified_account_id()
      AND roles.user_id = p_owner_id
      AND roles.role IN ('farmer', 'trader')
  );
$fn$;

CREATE FUNCTION public.nyuma_demand_owner_access(p_buyer_id uuid)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles AS roles
    WHERE roles.user_id = public.nyuma_verified_account_id()
      AND roles.user_id = p_buyer_id
      AND roles.role = 'buyer'
  );
$fn$;

CREATE FUNCTION public.nyuma_commitment_participant(p_commitment_id text)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT EXISTS (
    SELECT 1
    FROM public.commitments AS commitment
    JOIN public.listings AS listing ON listing.id = commitment.listing_id
    JOIN public.buyer_demands AS demand ON demand.id = commitment.buyer_demand_id
    WHERE commitment.id = p_commitment_id
      AND (
        EXISTS (
          SELECT 1 FROM public.user_roles AS roles
          WHERE roles.user_id = public.nyuma_verified_account_id()
            AND roles.user_id = listing.owner_id
            AND roles.role IN ('farmer', 'trader')
        )
        OR EXISTS (
          SELECT 1 FROM public.user_roles AS roles
          WHERE roles.user_id = public.nyuma_verified_account_id()
            AND roles.user_id = demand.buyer_id
            AND roles.role = 'buyer'
        )
      )
  );
$fn$;

CREATE FUNCTION public.nyuma_purchase_participant(p_purchase_id text)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT EXISTS (
    SELECT 1
    FROM public.purchases AS purchase
    JOIN public.commitments AS commitment ON commitment.id = purchase.commitment_id
    WHERE purchase.id = p_purchase_id
      AND public.nyuma_commitment_participant(commitment.id)
  );
$fn$;

CREATE FUNCTION public.nyuma_outcome_listing_owner(p_outcome_id text)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT EXISTS (
    SELECT 1
    FROM public.outcomes AS outcome
    JOIN public.listings AS listing ON listing.id = outcome.listing_id
    WHERE outcome.id = p_outcome_id
      AND public.nyuma_listing_owner_access(listing.owner_id)
  );
$fn$;

CREATE FUNCTION public.nyuma_outcome_buyer(p_outcome_id text)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT EXISTS (
    SELECT 1
    FROM public.outcomes AS outcome
    JOIN public.purchases AS purchase ON purchase.id = outcome.purchase_id
    JOIN public.commitments AS commitment ON commitment.id = purchase.commitment_id
    JOIN public.buyer_demands AS demand ON demand.id = commitment.buyer_demand_id
    WHERE outcome.id = p_outcome_id
      AND outcome.category = 'sold'
      AND public.nyuma_demand_owner_access(demand.buyer_id)
  );
$fn$;

ALTER FUNCTION public.nyuma_listing_owner_access(uuid) OWNER TO nyuma_fn_constraint;
ALTER FUNCTION public.nyuma_demand_owner_access(uuid) OWNER TO nyuma_fn_constraint;
ALTER FUNCTION public.nyuma_commitment_participant(text) OWNER TO nyuma_fn_constraint;
ALTER FUNCTION public.nyuma_purchase_participant(text) OWNER TO nyuma_fn_constraint;
ALTER FUNCTION public.nyuma_outcome_listing_owner(text) OWNER TO nyuma_fn_constraint;
ALTER FUNCTION public.nyuma_outcome_buyer(text) OWNER TO nyuma_fn_constraint;

REVOKE ALL ON FUNCTION public.nyuma_listing_owner_access(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.nyuma_demand_owner_access(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.nyuma_commitment_participant(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.nyuma_purchase_participant(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.nyuma_outcome_listing_owner(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.nyuma_outcome_buyer(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.nyuma_listing_owner_access(uuid) TO nyuma_app;
GRANT EXECUTE ON FUNCTION public.nyuma_demand_owner_access(uuid) TO nyuma_app;
GRANT EXECUTE ON FUNCTION public.nyuma_commitment_participant(text) TO nyuma_app;
GRANT EXECUTE ON FUNCTION public.nyuma_purchase_participant(text) TO nyuma_app;
GRANT EXECUTE ON FUNCTION public.nyuma_outcome_listing_owner(text) TO nyuma_app;
GRANT EXECUTE ON FUNCTION public.nyuma_outcome_buyer(text) TO nyuma_app;
```

Identity source inside every helper is `nyuma_verified_account_id()`. A missing, empty, malformed, or expired assertion makes that function return null. `user_id = NULL` is not true, so every helper returns false and every coordination policy hides the row. A suspended or deactivated account also makes the account function return null, with the same denial. The helpers do not call `nyuma_account_status()`.

### 11.3 Exact policy SQL

Do not execute this SQL. It belongs to migrations 014 through 018. `ENABLE` follows `CREATE POLICY` in the same transaction. `FORCE` is only migration 018.

Invalid assertion: `nyuma_verified_sub()` and `nyuma_verified_account_id()` are null. Every `USING` and `WITH CHECK` below is not true. `INSERT` is rejected. `SELECT`, `UPDATE`, and `DELETE` match zero rows.

Suspended account: `nyuma_verified_sub()` still returns the subject, so the account can `SELECT` its own `users` row and its own role-request rows. `nyuma_verified_account_id()` is null, so `user_roles`, listings, demands, commitments, purchases, and outcomes are hidden. `INSERT` into `users` fails `status = 'active'`.

#### `public.users` — migration 014

```sql
CREATE POLICY users_select_identity ON public.users
  FOR SELECT TO nyuma_fn_identity
  USING (auth_user_id = public.nyuma_verified_sub());

CREATE POLICY users_select_app ON public.users
  FOR SELECT TO nyuma_app
  USING (auth_user_id = public.nyuma_verified_sub());

CREATE POLICY users_insert_app ON public.users
  FOR INSERT TO nyuma_app
  WITH CHECK (
    auth_user_id = public.nyuma_verified_sub()
    AND status = 'active'
    AND active_role IS NULL
  );

CREATE POLICY users_select_request ON public.users
  FOR SELECT TO nyuma_fn_request
  USING (auth_user_id = public.nyuma_verified_sub());

CREATE POLICY users_select_approve ON public.users
  FOR SELECT TO nyuma_fn_approve
  USING (true);

CREATE POLICY users_select_reject ON public.users
  FOR SELECT TO nyuma_fn_reject
  USING (true);

CREATE POLICY users_select_operator ON public.users
  FOR SELECT TO nyuma_operator
  USING (true);

CREATE POLICY users_select_provisioner ON public.users
  FOR SELECT TO nyuma_provisioner
  USING (true);

CREATE POLICY users_update_revoke ON public.users
  FOR UPDATE TO nyuma_fn_revoke
  USING (true)
  WITH CHECK (true);

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
```

`nyuma_verified_account_id()` runs as `nyuma_fn_identity`. Its `SELECT` uses `users_select_identity`, which calls `nyuma_verified_sub()` and does not call `nyuma_verified_account_id()`. That is the recursion break. There is no `UPDATE` or `DELETE` policy for `nyuma_app`.

#### `public.user_roles` — migration 014

```sql
CREATE POLICY user_roles_select_app ON public.user_roles
  FOR SELECT TO nyuma_app
  USING (user_id = public.nyuma_verified_account_id());

CREATE POLICY user_roles_select_request ON public.user_roles
  FOR SELECT TO nyuma_fn_request
  USING (
    user_id IN (
      SELECT users.id FROM public.users AS users
      WHERE users.auth_user_id = public.nyuma_verified_sub()
    )
  );

CREATE POLICY user_roles_select_approve ON public.user_roles
  FOR SELECT TO nyuma_fn_approve
  USING (true);

CREATE POLICY user_roles_insert_approve ON public.user_roles
  FOR INSERT TO nyuma_fn_approve
  WITH CHECK (true);

CREATE POLICY user_roles_select_revoke ON public.user_roles
  FOR SELECT TO nyuma_fn_revoke
  USING (true);

CREATE POLICY user_roles_delete_revoke ON public.user_roles
  FOR DELETE TO nyuma_fn_revoke
  USING (true);

CREATE POLICY user_roles_select_operator ON public.user_roles
  FOR SELECT TO nyuma_operator
  USING (true);

CREATE POLICY user_roles_all_provisioner ON public.user_roles
  FOR ALL TO nyuma_provisioner
  USING (true)
  WITH CHECK (true);

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
```

The request-role subquery reads `users` as `nyuma_fn_request`, which `users_select_request` limits to the verified subject. A suspended account fails `nyuma_verified_account_id()`, so `nyuma_app` sees no role rows. `readAccount` then returns the suspended status with an empty role list, and dispatch raises `account-disabled`.

No `INSERT` policy for `nyuma_app`. An ordinary session cannot grant itself or anyone else a role.

#### `public.profiles` — migration 014

No `CREATE POLICY`. Then:

```sql
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
```

Default deny. Invalid and suspended assertions see nothing. The API has no grant today.

#### `public.role_requests` — migration 014

Ownership is `user_id`. The request role may see and insert only the verified subject's rows. Decision roles may see every row because the operator workflow names a request id, and the functions reject a session whose `session_user` is not `nyuma_operator` before they read.

```sql
CREATE POLICY role_requests_select_request ON public.role_requests
  FOR SELECT TO nyuma_fn_request
  USING (
    user_id IN (
      SELECT users.id FROM public.users AS users
      WHERE users.auth_user_id = public.nyuma_verified_sub()
    )
  );

CREATE POLICY role_requests_insert_request ON public.role_requests
  FOR INSERT TO nyuma_fn_request
  WITH CHECK (
    user_id IN (
      SELECT users.id FROM public.users AS users
      WHERE users.auth_user_id = public.nyuma_verified_sub()
    )
  );

CREATE POLICY role_requests_select_approve ON public.role_requests
  FOR SELECT TO nyuma_fn_approve
  USING (true);

CREATE POLICY role_requests_update_approve ON public.role_requests
  FOR UPDATE TO nyuma_fn_approve
  USING (true)
  WITH CHECK (true);

CREATE POLICY role_requests_select_reject ON public.role_requests
  FOR SELECT TO nyuma_fn_reject
  USING (true);

CREATE POLICY role_requests_update_reject ON public.role_requests
  FOR UPDATE TO nyuma_fn_reject
  USING (true)
  WITH CHECK (true);

CREATE POLICY role_requests_select_operator ON public.role_requests
  FOR SELECT TO nyuma_operator
  USING (true);

ALTER TABLE public.role_requests ENABLE ROW LEVEL SECURITY;
```

`nyuma_api` cannot execute `nyuma_approve_role_request` or `nyuma_reject_role_request`. That was rechecked: both have `operator_execute = true` and `api_execute = false`. A direct `INSERT` by `nyuma_app` has no grant and no policy.

#### `public.role_revocations` — migration 014

```sql
CREATE POLICY role_revocations_insert_revoke ON public.role_revocations
  FOR INSERT TO nyuma_fn_revoke
  WITH CHECK (true);

CREATE POLICY role_revocations_select_operator ON public.role_revocations
  FOR SELECT TO nyuma_operator
  USING (true);

ALTER TABLE public.role_revocations ENABLE ROW LEVEL SECURITY;
```

#### `public.listings` and `public.buyer_demands` — migration 015

```sql
CREATE POLICY listings_select_app ON public.listings
  FOR SELECT TO nyuma_app
  USING (public.nyuma_listing_owner_access(owner_id));

CREATE POLICY listings_insert_app ON public.listings
  FOR INSERT TO nyuma_app
  WITH CHECK (public.nyuma_listing_owner_access(owner_id));

CREATE POLICY listings_update_app ON public.listings
  FOR UPDATE TO nyuma_app
  USING (public.nyuma_listing_owner_access(owner_id))
  WITH CHECK (public.nyuma_listing_owner_access(owner_id));

CREATE POLICY listings_delete_app ON public.listings
  FOR DELETE TO nyuma_app
  USING (public.nyuma_listing_owner_access(owner_id));

CREATE POLICY demands_select_app ON public.buyer_demands
  FOR SELECT TO nyuma_app
  USING (public.nyuma_demand_owner_access(buyer_id));

CREATE POLICY demands_insert_app ON public.buyer_demands
  FOR INSERT TO nyuma_app
  WITH CHECK (public.nyuma_demand_owner_access(buyer_id));

CREATE POLICY demands_update_app ON public.buyer_demands
  FOR UPDATE TO nyuma_app
  USING (public.nyuma_demand_owner_access(buyer_id))
  WITH CHECK (public.nyuma_demand_owner_access(buyer_id));

CREATE POLICY demands_delete_app ON public.buyer_demands
  FOR DELETE TO nyuma_app
  USING (public.nyuma_demand_owner_access(buyer_id));

ALTER TABLE public.listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.buyer_demands ENABLE ROW LEVEL SECURITY;
```

An update that changes `owner_id` or `buyer_id` fails `WITH CHECK` because the new value is not the verified account. `nyuma_listings_guard` and `nyuma_demands_guard` also reject that change.

#### `public.commitments`, `public.purchases`, `public.outcomes` — migration 016

These tables have no account column. Ownership is the helper join, not a policy subquery. A policy subquery would itself be under RLS and would hide the counterparty.

```sql
CREATE POLICY commitments_select_app ON public.commitments
  FOR SELECT TO nyuma_app
  USING (public.nyuma_commitment_participant(id));

CREATE POLICY purchases_select_app ON public.purchases
  FOR SELECT TO nyuma_app
  USING (public.nyuma_purchase_participant(id));

CREATE POLICY outcomes_select_app ON public.outcomes
  FOR SELECT TO nyuma_app
  USING (public.nyuma_outcome_listing_owner(id));

ALTER TABLE public.commitments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outcomes ENABLE ROW LEVEL SECURITY;
```

No `INSERT`, `UPDATE`, or `DELETE` policy. The API grants are `SELECT` only. Writes stay on `nyuma_insert_commitment`, `nyuma_set_commitment_status`, `nyuma_insert_purchase`, and `nyuma_insert_outcome`.

A third account's helper result is false. Pointing a new commitment at two other accounts' ids fails inside `nyuma_insert_commitment` before the insert. The rolled-back model returned `third_account_can_link = false` for account C against A's listing and B's demand. Direct table writes stay denied by the missing grant and the missing policy.

#### `public.coordination_ids` — migration 017

No `CREATE POLICY`.

```sql
ALTER TABLE public.coordination_ids ENABLE ROW LEVEL SECURITY;
```

#### `FORCE` — migration 018

```sql
ALTER TABLE public.users FORCE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles FORCE ROW LEVEL SECURITY;
ALTER TABLE public.profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE public.listings FORCE ROW LEVEL SECURITY;
ALTER TABLE public.buyer_demands FORCE ROW LEVEL SECURITY;
ALTER TABLE public.commitments FORCE ROW LEVEL SECURITY;
ALTER TABLE public.purchases FORCE ROW LEVEL SECURITY;
ALTER TABLE public.outcomes FORCE ROW LEVEL SECURITY;
ALTER TABLE public.role_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE public.role_revocations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.coordination_ids FORCE ROW LEVEL SECURITY;
```

`schema_migrations` and every `nyuma_private` table stay without `ENABLE` and without `FORCE`.

### 11.4 BYPASSRLS audit

Every function owned by `nyuma_fn_constraint` has `BYPASSRLS` through its owner. RLS, including `FORCE`, does not filter the body. Safety is the function's own check plus the `EXECUTE` grant. "Callable" means `has_function_privilege('nyuma_api', ..., 'EXECUTE')` on a real `nyuma_api` login.

#### Safe to keep, callable by `nyuma_api`

| Function | Identifiers from the caller | Verified account | Entitlement | Disclosure | After RLS |
| --- | --- | --- | --- | --- | --- |
| `nyuma_lock_user(uuid)` | account id | yes, unless `session_user` is operator or provisioner | The id must equal the verified account. The API is neither operator nor provisioner. | Wrong id and missing id both raise `42501` with no existence distinction. Returns void. | Safe. The bypass still locks the caller's row. |
| `nyuma_set_active_role(uuid, text)` | account id and role | yes | `p_user_id` must equal the verified account, and that account must hold the role. | A mismatch raises `P0001` before the update. The not-found text names the verified id, which is the caller's own. | Safe. The update is not filtered by RLS, and the equality check is the tenant check. |
| `nyuma_insert_commitment(...)` | listing id, demand id, terms | yes | Caller must own the listing as farmer/trader or own the demand as buyer. The other record must be open and `live` unless the caller owns it. | Returns void. Failure is `23503` `The agreement does not exist.` | Safe. Bypass writes a row the party check already accepted. A third account cannot link the other two records. |
| `nyuma_insert_purchase(...)` | commitment id, listing id, terms | yes | Same party test as the commitment helper, repeated after the lock. Listing id must equal the commitment's listing. | Returns void. Missing and unauthorized commitments share `Commitment % does not exist.` | Safe. |
| `nyuma_insert_outcome(...)` | listing id, purchase id, notes | yes | Listing `owner_id` must be the verified account and that account must hold farmer or trader. A purchase id must already belong to that listing. | Returns void. Non-owners get `The outcome does not exist.` A purchase on another listing gets `The purchase does not exist.` | Safe. Notes are written only onto the caller's listing. |
| `nyuma_set_commitment_status(text, text)` | commitment id, status | yes | Party test, then lock, then the party test again. | Returns void. Same missing/unauthorized message. | Safe. It updates status only. |

#### Safe to keep, not callable by `nyuma_api`

These return void or a number and accept an id. If `EXECUTE` were granted later, the exceptions and return values would disclose another account's quantities or confirm that an id exists. The live ACL does not grant them to `nyuma_app` or `nyuma_api`.

| Function | Reads | Returns | Why it stays privileged |
| --- | --- | --- | --- |
| `nyuma_lock_listing(text)` | `listings` | void | Existence error names the supplied id. Internal lock. |
| `nyuma_lock_demand(text)` | `buyer_demands` | void | Same. |
| `nyuma_lock_for_commitment(text, text)` | both | void | Orders the two locks. |
| `nyuma_lock_for_purchase(text)` | commitments, listings, demands | void | Same. |
| `nyuma_lock_for_outcome(text, text)` | listings, purchases | void | Confirms a purchase belongs to the supplied listing. |
| `nyuma_listing_held_grams(text)` | commitments, purchases | bigint | Aggregate of every party. ACL is owner-only. |
| `nyuma_listing_accounted_grams(text)` | purchases, outcomes | bigint | Same. |
| `nyuma_listing_outcome_grams(text)` | outcomes | bigint | Same. |
| `nyuma_demand_held_grams(text)` | commitments, purchases | bigint | Same. |
| `nyuma_assert_listing_quantities(text)` | listings plus the gram helpers | void | Exception text does not include the other account's id or the raw total. |
| `nyuma_assert_demand_hold(text)` | demands plus helper | void | Same. |
| `nyuma_assert_commitment_purchases(text)` | commitments, purchases | void | Same. |
| `nyuma_assert_sold_link(text)` | purchases, outcomes | void | Same. |

No correction to these bodies is required before 013. A later grant to `nyuma_app` would be a new vulnerability. The 013 migration must not grant them.

#### Trigger functions

All of these are `SECURITY DEFINER`, owned by `nyuma_fn_constraint`, and `EXECUTE` is granted to `nyuma_app`. A real `nyuma_api` call does not enter the body. PostgreSQL 18 raises `0A000` first. They remain the quantity and history backstop when a real table statement fires them.

| Function | What a fired trigger does | Tenant check |
| --- | --- | --- |
| `nyuma_claim_coordination_id()` | Inserts `NEW.id` into `coordination_ids`. | None. The id is not an account. |
| `nyuma_release_coordination_id()` | Deletes that id. | For listings and demands, the verified account must equal `OLD.owner_id` or `OLD.buyer_id` unless the session is operator or provisioner. |
| `nyuma_listings_check()`, `nyuma_demands_check()`, `nyuma_commitments_check()`, `nyuma_purchases_check()`, `nyuma_outcomes_check()` | Call the assert helpers. | They see every child row. That is required. They do not return those rows. |
| `nyuma_commitments_guard()` | Reads both the listing and the demand, rejects delete and term changes. | The insert function has already required the caller to be a party. The guard does not return the row. |
| `nyuma_purchases_guard()` | Reads the commitment, including its status, in an exception. | Reached only after `nyuma_insert_purchase` accepts the party. |
| `nyuma_outcomes_guard()` | Reads listing, commitment, and purchase ids. | Same, after `nyuma_insert_outcome`. |
| `nyuma_guard_role_removal()` | Reads whether the account still has a listing or demand, then calls `nyuma_clear_active_role`. | Fires on `DELETE` of `user_roles`. `nyuma_api` has no `DELETE` grant. The message tells the operator that listings exist. It does not return the rows. |

`nyuma_clear_active_role` is owned by `nyuma_fn_revoke`, not by the constraint role. Its ACL is `{nyuma_fn_revoke=X/nyuma_fn_revoke,nyuma_fn_constraint=X/nyuma_fn_revoke}`. It updates whichever `p_user_id` it is given and does not call `nyuma_verified_account_id()`. That is safe only while `nyuma_api` cannot execute it. The role-removal trigger is the intended caller. No body change is required for 013. Migration 014 must include `users_update_revoke`, or this update changes zero rows after RLS and leaves `active_role` set.

#### Functions that do not require a body change

None of the constraint-owned functions need a code change before migration 013. The required corrections are policies, grants that 013 must not widen, and the store joins. The six new helpers are new functions, not edits of these bodies.

### 11.5 Cross-party access matrix

Rolled-back fixture: A owns open live listing `e2a` and holds `farmer`. B owns open live demand `e2b` and holds `buyer`. Commitment `e2c` links them and is `confirmed`. Purchase `e2p` and sold outcome `e2o` with notes `private-note` hang off that commitment. C holds `farmer` and owns neither record.

| Operation | A, listing owner | B, buyer | C, unrelated |
| --- | --- | --- | --- |
| `SELECT` own listing or demand on the base table | A's listing only | B's demand only | neither |
| `SELECT owner_id` or `buyer_id` of the other base row | no row | no row | no row |
| Market view of open live rows | both public columns, no `owner_id` or `buyer_id` | same | same |
| `INSERT` or `UPDATE` the other account's listing or demand | denied | denied | denied |
| `UPDATE` own row onto the other account's id | denied by `WITH CHECK` and the guard | denied | denied |
| `SELECT` commitment `e2c` through the participant policy | yes | yes | no |
| Current store inner join of listing and demand | 0 rows | 0 rows | 0 rows |
| `SELECT` commitment without that join | 1 row | 1 row | no row under the policy |
| `nyuma_insert_commitment` linking A and B | yes, A is the listing owner | yes, B is the buyer | no. Measured `third_account_can_link = false` |
| `nyuma_set_commitment_status` | yes | yes | no |
| `SELECT` purchase `e2p` | yes | yes | no |
| `nyuma_insert_purchase` on `e2c` | yes | yes | no |
| `SELECT` outcome `e2o` on the base table, including `notes` | yes | no | no |
| Buyer outcome view, `notes` omitted | no, A is not the buyer | yes, category `sold` | no |
| `nyuma_insert_outcome` | yes | no. The function requires the listing owner | no |
| Direct `INSERT` into commitments, purchases, or outcomes | no grant, no policy | no grant, no policy | no grant, no policy |

Changing `commitments.listing_id` or `buyer_demand_id` after insert is already rejected by `nyuma_commitments_guard`, and there is no `UPDATE` grant for `nyuma_app`. A purchase whose `listing_id` differs from its commitment is rejected by `nyuma_insert_purchase` and `nyuma_purchases_guard`. An outcome whose `purchase_id` belongs to another listing is rejected by `nyuma_insert_outcome`.

### 11.6 Views

No views exist in the catalog. These are proposed for migration 015, and the outcome view for 016. Do not create them in Stage E2.

```sql
CREATE VIEW public.nyuma_open_listings
WITH (security_barrier = true, security_invoker = false) AS
SELECT id, commodity, quantity, quantity_unit, quantity_kind,
       location, availability_window, asking_price_ksh_per_kg, status
FROM public.listings
WHERE status = 'open' AND origin = 'live';

CREATE VIEW public.nyuma_open_demands
WITH (security_barrier = true, security_invoker = false) AS
SELECT id, commodity, requested_quantity, quantity_unit,
       preferred_location, collection_window, indicative_price_ksh_per_kg, status
FROM public.buyer_demands
WHERE status = 'open' AND origin = 'live';

CREATE VIEW public.nyuma_buyer_outcomes
WITH (security_barrier = true, security_invoker = false) AS
SELECT id, listing_id, commitment_id, purchase_id, category,
       quantity, quantity_unit, recorded_date, recorded_at
FROM public.outcomes
WHERE public.nyuma_outcome_buyer(id);

ALTER VIEW public.nyuma_open_listings OWNER TO nyuma_fn_constraint;
ALTER VIEW public.nyuma_open_demands OWNER TO nyuma_fn_constraint;
ALTER VIEW public.nyuma_buyer_outcomes OWNER TO nyuma_fn_constraint;
REVOKE ALL ON public.nyuma_open_listings, public.nyuma_open_demands, public.nyuma_buyer_outcomes FROM PUBLIC;
GRANT SELECT ON public.nyuma_open_listings, public.nyuma_open_demands, public.nyuma_buyer_outcomes TO nyuma_app;
```

| View | Owner | Invoker | Underlying RLS | Exposed columns | Hidden |
| --- | --- | --- | --- | --- | --- |
| `nyuma_open_listings` | `nyuma_fn_constraint` | `security_invoker = false` | Bypassed, because the owner has `BYPASSRLS` | id, commodity, quantity, unit, kind, location, window, price, status | `owner_id`, `origin`, timestamps |
| `nyuma_open_demands` | `nyuma_fn_constraint` | `security_invoker = false` | Bypassed the same way | id, commodity, quantity, unit, location, window, price, status | `buyer_id`, `origin`, timestamps |
| `nyuma_buyer_outcomes` | `nyuma_fn_constraint` | `security_invoker = false` | Bypassed, then `nyuma_outcome_buyer(id)` keeps the caller's sold rows | outcome ids, category, quantity, dates | `notes` |

`security_barrier = true` applies the view filter before a caller's `WHERE`. A caller cannot add a predicate that reads a hidden column, because those columns are not in the view. Joining a view id back to `listings`, `buyer_demands`, or `outcomes` hits the base policies, which do not include the other party's row.

`security_invoker = true` would run the view as `nyuma_api`. The owner-only base policies would then hide every other account's open rows, and the market would show only the caller's own open records. The caller would also need its existing `SELECT` on the base table, which it has, but the policy would still filter. The views must stay `security_invoker = false`. They are not a path to another tenant's `owner_id`, `buyer_id`, or `notes`. They are a path to the public market columns of open live rows, and to a buyer's own sold outcome without notes.

The listing owner keeps reading `outcomes` on the base table, where the owner policy includes `notes`.

### 11.7 Role-request workflow under RLS

| Step | Function | Owner bypass | What RLS must allow | Ordinary user |
| --- | --- | --- | --- | --- |
| Submit | `nyuma_submit_role_requests(uuid, text[])` | no | `SELECT` own `users` and `user_roles`; `SELECT` and `INSERT` own `role_requests`. The function already requires `p_auth_user_id = nyuma_verified_sub()` and an active status from `nyuma_account_status()`. | Callable. Another subject's id raises `invalid-request` before any insert. A suspended subject raises `account-disabled`. |
| List | `nyuma_list_role_requests(uuid)` | no | `SELECT` own `users`, `user_roles`, and `role_requests`. Returns `decision_note` for that subject only. | Callable. A different subject raises `invalid-request`. |
| Approve | `nyuma_approve_role_request(uuid, text)` | no | `SELECT` and `UPDATE` any `role_requests`; `SELECT` and `INSERT` `user_roles`; `SELECT` `users`. | Not executable. The body also requires operator `session_user`. |
| Reject | `nyuma_reject_role_request(uuid, text)` | no | `SELECT` and `UPDATE` any `role_requests`. | Not executable. Same operator check. |
| Revoke | `nyuma_revoke_ordinary_role(uuid, text, text)` | no | `SELECT` and `DELETE` any `user_roles`; `INSERT` `role_revocations`; `nyuma_lock_user` for the operator path. | Not executable. |
| Clear active role | `nyuma_clear_active_role(uuid, text)` | no | `UPDATE` `users` as `nyuma_fn_revoke`. | Not executable. No internal identity check, so the grant must stay limited to `nyuma_fn_revoke` and `nyuma_fn_constraint`. |

`nyuma_guard_role_request` is an invoker trigger. During submit it runs as `nyuma_fn_request`. During approve and reject it runs as the decision owner. Its `SELECT` of `user_roles` on approval is why `nyuma_fn_approve` needs `user_roles_select_approve`. `nyuma_guard_administrator_role` still blocks an administrator insert unless `current_user` is the provisioner. `nyuma_fn_approve` is not the provisioner.

### 11.8 Concrete tests

Every API case uses a real `nyuma_api` login. Setup and `FORCE` observations that need the owner use a real `nyuma_owner` login. The superuser is only for fixture insert and for the final catalog read. Each test rolls back, or deletes the fixture rows it committed. Do not leave assertion keys.

1. **A cannot read B.** As A, `SELECT` from `users`, `user_roles`, `listings`, `buyer_demands`, `commitments`, `purchases`, `outcomes` returns none of B's private rows. B's open listing appears only in `nyuma_open_listings`, and that view has no `owner_id` column.
2. **A cannot write B.** `UPDATE` and `DELETE` of B's listing and demand match zero rows. `INSERT` of a listing with B's `owner_id`, a demand with B's `buyer_id`, or a user with B's `auth_user_id` fails `WITH CHECK`.
3. **A cannot reassign ownership.** `UPDATE listings SET owner_id = B WHERE id = A's listing` fails. The row's `owner_id` is still A.
4. **Both parties see the commitment.** After the store selects `commitments` without joining the other base table, A and B each receive `e2c`. C receives no row. The same split applies to `nyuma_purchase_participant` and purchase `e2p`.
5. **Outcome split.** A can `SELECT notes` from `outcomes` for `e2o`. B's base-table `SELECT` returns zero rows. B's `SELECT` from `nyuma_buyer_outcomes` returns the sold row and has no `notes` column. C sees neither.
6. **Foreign keys.** As C, `nyuma_insert_commitment` on A's listing and B's demand raises `23503`. As A, `nyuma_insert_purchase` with a listing id that is not the commitment's listing raises. As B, `nyuma_insert_outcome` on A's listing raises `23503`. As A, an outcome whose `purchase_id` is on another listing raises `23503`.
7. **Direct table versus view.** `SELECT owner_id FROM listings WHERE status = 'open' AND origin = 'live'` returns only A's id when the session is A. `SELECT * FROM nyuma_open_listings` includes B's open listing and does not offer `owner_id`.
8. **Every API-callable bypass function.** As A: `nyuma_lock_user(B)` raises `42501`; `nyuma_set_active_role(B, 'farmer')` raises `P0001`; `nyuma_insert_commitment`, `nyuma_insert_purchase`, `nyuma_insert_outcome`, and `nyuma_set_commitment_status` on C's ids raise `23503`. `nyuma_lock_listing`, the gram helpers, and the assert helpers raise `42501` on `EXECUTE`. `SELECT nyuma_claim_coordination_id()` raises `0A000`.
9. **Role requests.** As A, `nyuma_submit_role_requests(B's subject, ...)` raises `invalid-request`. As A, approve, reject, and revoke raise `42501` on `EXECUTE`. An operator login can approve A's pending request and the grant appears only on A's `user_roles` row. As A, `SELECT` from `role_requests` directly returns zero rows because `nyuma_app` has no policy; the list function still returns A's own requests.
10. **Suspended and invalid.** Suspended A with a valid `nya1` can `SELECT` its own `users.status` and gets `suspended`, and gets zero listings. `nyuma_account_status()` returns `suspended`. An empty setting, a bad MAC, and an expired `nya1` make both functions null and every protected `SELECT` empty.
11. **Owner before and after `FORCE`.** Before `FORCE`, a real `nyuma_owner` session reads A's and B's listings. After `FORCE`, the same session reads zero listings, because no policy names `nyuma_owner`. `SET ROLE nyuma_fn_constraint` on that login reads both, because `BYPASSRLS` still applies. The superuser reads both in either state. `nyuma_api` cannot `ALTER TABLE ... DISABLE ROW LEVEL SECURITY` or `NO FORCE` (`42501`).
12. **Pool cleanup.** On one `nyuma_api` pool, roll back A's assertion, check out again, and read `current_setting('nyuma.access_token', true)` before the next `set_config`. The value is `''` and `nyuma_verified_sub()` is null.

### 11.9 Outstanding risks and the 013 decision

Required before 014, not inside 013:

- Use the `users` `SELECT` policy from this section, not `id = nyuma_verified_account_id()`.
- Create the request, approve, reject, revoke, operator, and provisioner policies before `ENABLE`, or those functions see zero rows.
- Do not add `USING (true)` for `nyuma_fn_constraint`.

Required before 015:

- Ship the two market views and switch `listOpenListings` and `listOpenDemands`.
- Remove the inner joins to `listings` and `buyer_demands` from agreement, purchase, and outcome reads. A commitment `SELECT` filtered by `nyuma_commitment_participant` is enough for the columns the store already returns.
- Ship `nyuma_buyer_outcomes` before buyers are expected to read sold outcomes. The owner path can stay on the base table.

Unresolved, and not a reason to refuse 013:

- Whether to `REVOKE EXECUTE` on trigger functions from `nyuma_app`. Direct calls already fail with `0A000`.
- Whether a provisioner `WITH CHECK` should allow only `administrator`. Today's grant allows the provisioner to insert any role. The RLS policy preserves that grant.
- `nyuma_clear_active_role` trusts its caller. The ACL is the boundary. Tightening the body can be a separate patch. It is not required for a helper-only 013.

**Migration 013 has been applied** on the local database. It is the six helpers, the owner changes, the `REVOKE` from `PUBLIC`, and the `GRANT EXECUTE` to `nyuma_app` in section 11.2. See section 11.10.

**NO-GO** for 014 until the suspended-account `users` policy and the decision-role policies in this section are the SQL that ships. **NO-GO** for 015 until the store no longer inner-joins the counterparty base tables.

### 11.10 Migration 013 result

Applied file: `server/migrations/013_rls_predicates.sql`. Rollback file, not executed: `server/migrations/rollback/013_rls_predicates_rollback.sql`.

The six functions are `nyuma_listing_owner_access(uuid)`, `nyuma_demand_owner_access(uuid)`, `nyuma_commitment_participant(text)`, `nyuma_purchase_participant(text)`, `nyuma_outcome_listing_owner(text)`, and `nyuma_outcome_buyer(text)`. Each is `VOLATILE`, `SECURITY DEFINER`, owned by `nyuma_fn_constraint`, with `search_path=pg_catalog, public, pg_temp`. `EXECUTE` is granted to `nyuma_app`, which `nyuma_api` inherits. `PUBLIC` does not have `EXECUTE`. No existing table grant or role membership was changed.

The rollback guard uses numeric prefix 13, requires `013_rls_predicates.sql` to be recorded, and refuses a later prefix. It then drops the three dependent helpers before the three they call, and deletes only the 013 migration row. The ordering test executes that guard's `DO` block inside a transaction and rolls it back. It does not execute the `DROP FUNCTION` statements.

Local verification after the suite, on `nyuma_dev` port 5433, PostgreSQL 18.4:

- 28 test files, 171 tests passed. `tsc --noEmit` exited 0.
- 16 application tables remain. Zero policies. RLS is disabled and unforced on all of them.
- `local_hs256_enabled` is false. Assertion keys and local HMAC keys are empty. The `h013` fixture rows are gone.
- The rollback script was not executed. No connection was made to port 5432 or to live Supabase.

The helper tests delete their own history rows with `SET LOCAL session_replication_role = replica` because the outcome, purchase, and commitment triggers reject `DELETE`. That setting ends with the cleanup transaction. It is not part of the migration.
