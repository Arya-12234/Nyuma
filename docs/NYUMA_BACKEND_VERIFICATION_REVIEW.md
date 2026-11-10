# Nyuma backend foundation — verification review

Follow-up after the corrections: [11B.1 verification, 5 November 2026](NYUMA_BACKEND_VERIFICATION_REVIEW_2026-11-05.md). The findings below are the original review. They are not the current state of the schema.

Read-only review of `server/` against the SQL, the backend tests, and the existing domain rules in `src/`. No application file, migration, test, configuration, or environment file was changed. The migration was not applied. No database connection was opened.

This review does not treat `docs/NYUMA_BACKEND_IMPLEMENTATION.md` as evidence. Claims below were checked in the source named with each finding.

## 1. Overall assessment

**Approve with conditions.**

The table shape, foreign keys, and the intended hold, purchase, and accounted-quantity rules match the current domain. For a normal insert, the listing or purchase row is locked before the aggregate quantity is read, so two concurrent commitment or purchase inserts on the same parent should not both commit an over-allocation. That behaviour is visible in the trigger order. It has never been executed.

Approval waits on two conditions:

1. Apply `server/migrations/001_foundation.sql` to a local PostgreSQL 14 or newer database and pass the integration tests in section 8. Static string checks do not prove that this SQL parses or that the triggers fire.
2. Do not treat `nyuma_guard_administrator_role` as authorization. Any session that can insert into `user_roles` can set `nyuma.allow_admin_grant` and grant administrator. That has to be replaced before any role-writing API exists.

No frontend change is required by this review. Sample login does not read or write these tables.

## 2. Verified strengths

The migration creates `users`, `profiles`, `user_roles`, `coordination_ids`, `listings`, `buyer_demands`, `commitments`, `purchases`, and `outcomes`. It inserts no sample accounts and no produce rows. Every `REFERENCES` clause in `001_foundation.sql` is paired with `ON DELETE RESTRICT`. There is no `ON DELETE CASCADE`, so deleting a user or a parent row cannot silently remove commitments, purchases, or outcomes. Child rows block the delete. `purchases_guard` and `outcomes_guard` also reject `UPDATE` and `DELETE`, so those histories cannot be rewritten in place while the triggers are enabled.

`user_roles` uses primary key `(user_id, role)`. One account can hold farmer and trader together. `users` has no single role column.

Coordination ids use the same text pattern as the prototype. `coordination_ids` plus `nyuma_claim_coordination_id` rejects the same id on two coordination tables. User ids are UUIDs and are not those text ids.

Quantity columns are `numeric(14,3)` and price columns are `numeric(14,2)`, with checks that stored values are greater than zero. Optional prices may be null. `listings.quantity_kind` is `available` or `expected`.

`GET /health` in `server/src/index.ts` can start with no database. There is no listing, commitment, purchase, or outcome route. Root `package.json` scripts are still `vite`, `vitest run`, and `tsc --noEmit && vite build`. `src/` does not import `server/`.

### Commitments

`commitments_guard` runs before insert, update, and delete.

- Delete raises `Commitments are kept for history` and does not remove the row.
- Update allows only a status change. Proposed may become confirmed or cancelled. Confirmed may become fulfilled or cancelled. Fulfilled and cancelled have no outgoing transition. This matches `COMMITMENT_TRANSITIONS` in `src/domain/coordinationRepository.ts`. A direct update from proposed to fulfilled is rejected by this trigger, not by a `CHECK` constraint.
- Cancel is rejected when any purchase exists for that commitment. `nyuma_assert_commitment_purchases` repeats that check after the write.
- Before the compatibility reads, the guard calls `nyuma_lock_for_commitment`, which locks the listing with `FOR UPDATE` and then the buyer demand with `FOR UPDATE`.
- Insert then requires both parents to be open, the same commodity, the same `kg` unit, and `nyuma_is_time_compatible(listing.availability_window, demand.collection_window)`.
- `nyuma_is_time_compatible` matches `isTimeCompatible` in `src/lib/decisionEngine.ts` for all 25 pairs of the five windows: Today fits every listing window, Tomorrow fits only Tomorrow, and an hour window fits only when its limit is less than or equal to the listing limit (2, 3, 4, 18, 36). This was compared by reading both functions. The SQL function was not executed.
- After the row is visible, `commitments_check` calls `nyuma_assert_listing_quantities` and `nyuma_assert_demand_hold`. Those sums include the new row. `nyuma_listing_held_grams` and `nyuma_demand_held_grams` use the same cases as `heldMilli` in `src/lib/coordinationActivity.ts`: proposed and confirmed hold agreed quantity, fulfilled holds the sum of purchases for that commitment, and every other status, including cancelled, holds zero.
- The demand sum is stricter than `checkDocumentInvariants` in `src/domain/relationships.ts`, which compares each commitment with the full requested quantity and does not sum commitments. It matches `remainingDemandKg` in the workflow. Two proposed commitments of 60 kg against a 100 kg requirement fail the sum. That is the rule that prevents over-allocation.
- A second insert on the same listing waits on the listing lock. A second insert on the same demand and a different listing waits on the demand lock. After the first transaction commits, the second sum sees the first commitment. On inspection, both cannot pass. This was not run under concurrency.
- Recording a purchase does not update `commitments.status`. `purchases_guard` only inserts a purchase.

Insert may start at `confirmed`, `fulfilled`, or `cancelled`. The transition table applies to update, not insert. `recordCommitment` in the repository also stores the draft status it is given, so this matches the domain. A row inserted as `fulfilled` holds zero until purchases exist, and a purchase requires `confirmed`, so that row can never receive a purchase. The later API should insert `proposed`.

Window and produce checks run on insert only. Commodity cannot change later. `availability_window` and `collection_window` can. A later window edit can leave an existing commitment incompatible. The prototype checks the window when the agreement is recorded and does not recheck it on a listing edit, so the database matches that behaviour.

### Purchases

`purchases_guard` rejects update and delete before any quantity change. An update cannot raise `actual_quantity` around the cap, and a delete cannot drop a purchase out of the held or accounted totals.

On insert the guard calls `nyuma_lock_for_purchase`. That function reads `commitments.listing_id`, locks that listing, then locks the commitment. `listing_id` is immutable in `nyuma_commitments_guard`, so the unlocked read cannot observe a changed listing. The guard then requires `status = 'confirmed'`, `NEW.listing_id = commitment.listing_id`, and the same quantity unit. A purchase that names another listing is rejected here. There is no composite foreign key for that pair; see section 4.

`purchases_check` then calls `nyuma_assert_commitment_purchases` and `nyuma_assert_listing_quantities`. The purchase sum is compared with agreed quantity while the commitment lock is held. A second purchase on that commitment must take the same listing lock first, so it waits and then sees the first purchase. On inspection, the two inserts cannot both exceed the agreed quantity.

The purchase path does not lock the buyer demand. It does not need to while the commitment stays confirmed, because confirmed hold is the agreed quantity, not the purchased quantity. Fulfilment changes that hold and goes through `commitments_guard`, which locks the demand before `nyuma_assert_demand_hold`.

### Outcomes

`outcomes_guard` rejects update and delete. On insert, `nyuma_lock_for_outcome` locks the listing and, when `purchase_id` is set, locks that purchase and requires `purchases.listing_id` to equal the outcome listing. The guard repeats the listing check, requires a named commitment to belong to the same listing, requires category `sold` when a purchase is set, and requires that purchase's commitment when the outcome also names a commitment. `outcomes_purchase_is_sold` is a `CHECK` constraint for the category rule, so a non-sold outcome cannot reference a purchase even if the trigger were the only other copy of the rule. The domain rule in `outcomeBlock` and `checkDocumentInvariants` is the same: only `sold` may point at a purchase.

`outcomes_check` then checks listing totals and, for a linked purchase, `nyuma_assert_sold_link`. That function sums every outcome row for the purchase and rejects a sum above `actual_quantity`. The listing lock serializes outcomes and purchases on that listing. The purchase lock serializes two sold outcomes for one purchase.

`nyuma_listing_accounted_grams` adds every outcome once, plus only the part of each purchase that sold outcomes on that purchase do not already cover. A sold outcome of 80 kg on an 80 kg purchase contributes 80 kg, not 160 kg. That is the formula in `src/lib/outcomeAccounting.ts`. The TypeScript test of that formula does not execute this SQL function.

The domain does **not** limit a purchase to one sold outcome. `uncoveredGrams` and `checkDocumentInvariants` sum every linked sold row. A 50 kg sold outcome and a 30 kg sold outcome may both point at an 80 kg purchase. The database follows that rule. It does not create a unique constraint on `outcomes.purchase_id`. A second sold row is rejected only when the combined quantity exceeds the purchase, or when the listing accounted total would exceed the listing.

Hold and accounted quantity are separate ceilings. They are not added together. A fulfilled purchase that is also recorded as sold counts once in each ceiling. That matches the prototype, where promised quantity and outcome accounting are different checks.

### Listing and demand quantity changes

`listings_check` and `demands_check` run after update, not after insert. The updated row is already locked by the `UPDATE` statement before the after-trigger reads holds and accounted quantity. A concurrent commitment insert needs that same parent lock, so it waits and then sees the reduced quantity. Owner, commodity, quantity unit, and origin cannot change. Buyer, commodity, quantity unit, and origin on a demand cannot change.

### What is enforced by PostgreSQL constraints rather than triggers

Enforced by primary keys, foreign keys, unique constraints, and `CHECK` constraints even if triggers are disabled:

- Row existence for users, profiles, roles, listings, demands, commitments, purchases, and outcomes.
- Allowed commodities, locations, windows, statuses, categories, units, positive quantities, positive prices, note length, and `outcomes_purchase_is_sold`.
- `ON DELETE RESTRICT` on every foreign key.
- One row per `(user_id, role)`.
- Unique `users.auth_user_id` when it is not null.
- Distinct coordination ids only if `nyuma_claim_coordination_id` is still enabled. The cross-table rule is a trigger, not a foreign key from each record to `coordination_ids`.

Enforced only while triggers are enabled:

- Role required to own a listing or a demand.
- Administrator insert guard.
- Commitment transitions, open parents, produce match, collection window, and hold sums.
- Purchase confirmation, same-listing purchase, and purchase cap.
- Outcome listing and commitment match, accounted cap, and sold-link cap.
- Immutability of owner, commodity, unit, and commitment terms.
- Rejection of purchase, outcome, and commitment deletes, and of purchase and outcome updates.

`session_replication_role = replica`, or an owner disabling triggers, bypasses the second list. The foreign keys remain.

## 3. Critical findings

### Administrator grant is a session variable the inserting session can set

`nyuma_guard_administrator_role`, trigger `user_roles_guard_admin`, on `BEFORE INSERT` of `user_roles`.

The trigger rejects `role = 'administrator'` unless `current_setting('nyuma.allow_admin_grant', true)` is the text `true`. PostgreSQL lets any session set a custom variable. There is no `GRANT` that reserves this setting for a trusted role, and there is no check of `current_user`.

Practical failure: a connection that can `INSERT INTO user_roles` runs `SELECT set_config('nyuma.allow_admin_grant', 'true', true)` and inserts `administrator` for its own user id or for any other user id. The error text says a user cannot grant that role. The database does not identify which user is asking. The skipped integration test itself does this `set_config` and expects the insert to succeed, which confirms the bypass.

There is no authenticated API user today, and no frontend check is involved. The control is not safe to keep in front of a later role endpoint. Farmer, trader, and buyer inserts have no actor check at all: any writer can assign those roles to any account, including another person's account.

### Concurrent over-allocation was not disproven by execution

The lock-then-sum order in `nyuma_commitments_guard`, `nyuma_purchases_guard`, and `nyuma_outcomes_guard` is the right shape, and this review did not find a path where two ordinary inserts both commit an over-allocation. That conclusion is from reading the functions. PostgreSQL has not run them. A syntax error, a trigger that does not attach, or a lock that does not block would not be visible to the current tests. Until section 8 has passed on a local database, the concurrency behaviour is not proven.

## 4. Important findings

### Role removal and a new listing can pass each other

`nyuma_listings_guard` checks `user_roles` with a plain `SELECT` on insert. `nyuma_guard_role_removal` checks `listings` with a plain `EXISTS` on delete. Neither takes a `FOR UPDATE` or `FOR SHARE` lock on the other table.

Practical failure: one transaction deletes the account's only farmer role and sees no listing yet. Another transaction still sees the farmer role, inserts a listing, and commits. The role delete then commits. The listing remains, owned by an account with no farmer or trader role. The same race exists between `nyuma_demands_guard` and deletion of the buyer role.

This does not over-allocate quantity. It breaks the ownership rule the insert trigger is there to enforce.

### A direct commitment update locks rows in the opposite order from a purchase insert

`UPDATE` locks the commitment row before `commitments_guard` runs. The guard then locks the listing and the demand. `nyuma_lock_for_purchase` locks the listing and then the commitment.

Practical failure: a status change and a purchase on the same commitment can deadlock. PostgreSQL aborts one transaction with `40P01`. The aborted transaction does not commit, so this is not an over-allocation. The caller loses a valid request unless it retries the whole transaction. `server/src/db/operations.ts` documents that retry. The trigger cannot lock the listing before the commitment on a raw `UPDATE`, because PostgreSQL locks the updated row first. The later API has to call `nyuma_lock_for_commitment` or `nyuma_lock_for_purchase` in the same transaction before the `UPDATE`.

### Same-listing rules for purchases and outcomes are triggers, not foreign keys

`purchases.listing_id` and `purchases.commitment_id` are separate foreign keys. They do not require the commitment's listing. `nyuma_purchases_guard` rejects a mismatch on insert. `outcomes.listing_id`, `outcomes.purchase_id`, and `outcomes.commitment_id` are also separate. `nyuma_outcomes_guard` and `nyuma_lock_for_outcome` reject a purchase or commitment from another listing.

Practical failure: a session that disables triggers, or loads with `session_replication_role = replica`, can store a purchase whose `listing_id` is a different real listing from its commitment. Later hold and accounted sums then move quantity against the wrong listing. With triggers left enabled, this review did not find an insert path that does that.

### Purchase accounting is stricter than the repository and matches the outcome workflow

`nyuma_assert_listing_quantities` rejects a purchase when outcomes plus uncovered purchases would exceed the listing. `checkDocumentInvariants` does not apply that sum at purchase time. `outcomeBlock` in `src/lib/outcomeAccounting.ts` does apply it when an outcome is saved.

Practical failure against the prototype's repository: a 100 kg listing already has a 30 kg spoiled outcome, and a confirmed commitment agrees 80 kg. The repository can store an 80 kg purchase. The database rejects it because accounted quantity would be 110 kg. The database fails closed. It will refuse some states the current repository can store. That should be an explicit product decision before the API writes purchases, not a surprise during migration.

### `users.status` is not read by any write trigger

`users.status` allows `active`, `suspended`, and `deactivated`. No trigger consults it. A suspended account can still own a new listing or demand if the writer inserts one. Nothing in the current API does that insert. The column does not yet suspend anything.

### Collection-window compatibility is not rechecked after insert

Covered in section 2. A listing changed from `3 hours` to `2 hours` keeps a commitment whose demand collects in `3 hours`. That matches the prototype. It means the database does not guarantee that every stored commitment remains window-compatible.

### `/health` reports configuration, not database readiness

`healthBody` in `server/src/index.ts` returns `ok: true` whenever the process handles the request. `database` is `configured` when `DATABASE_URL` passed `loadConfig`, and `not-configured` when the variable is missing. The handler does not open a connection.

Practical failure: PostgreSQL is stopped, but a process that was started with a local URL still returns HTTP 200 and `database: "configured"`. That response must not be used as proof that migrations ran or that the database can accept a commitment.

### Deletes of empty parents are allowed; truncation is not blocked

A listing or buyer demand with no child rows can be deleted. `listings_release_id` and `buyer_demands_release_id` remove the coordination id. Commitments, purchases, and outcomes cannot be deleted through row `DELETE` while their triggers are enabled. `TRUNCATE` does not run those row triggers. A table owner can still empty the tables with `TRUNCATE`. That is outside the application path, and no application path exists yet.

### Numeric precision is rounded by PostgreSQL, not rejected

The column types and the comments on `listings.quantity` and `listings.asking_price_ksh_per_kg` state this. An insert of `1.2345` kilograms is not rejected by a check; PostgreSQL rounds it to three decimal places. The domain function `readQuantity` rejects that input. A writer that bypasses the future API can store a quantity the prototype would refuse. The later API still has to reject extra fractional digits before `INSERT`.

## 5. Test coverage and unverified SQL behaviour

This review did not run Vitest and did not apply the migration. No `.env` file is present in the project. The integration test skips itself when `DATABASE_URL` is unset, which is the case this review left unchanged.

The 13 tests that run without a database are the `it` blocks in the files below. They do not open PostgreSQL.

`server/tests/schema.static.test.ts` (7):

1. The only migration file is `001_foundation.sql`, and the file text does not contain `INSERT INTO` for the eight data tables or the sample account ids and localStorage keys.
2. The nine `CREATE TABLE` statements exist, `users` has no role column, `user_roles` has the composite primary key, and selected foreign keys are present as text.
3. The number of `REFERENCES` tokens equals the number of `ON DELETE RESTRICT` tokens after comment stripping.
4. The file contains five `numeric(14, 3)` tokens and four `numeric(14, 2)` tokens, plus the quantity-kind check and two price checks.
5. Status and category lists appear in the matching `CREATE TABLE` bodies, and the administrator error string appears somewhere in the file.
6. Lock function names from `transactionalOperations` appear, along with `FOR UPDATE` and several rule sentences.
7. Nine index names appear as text.

`server/tests/config.test.ts` (3):

1. A missing URL yields a null database and the local host and port defaults. Local `127.0.0.1`, `localhost`, and `[::1]` URLs are accepted. `change-me`, a non-local host, an `https` Supabase-style URL, host `0.0.0.0`, and port `70000` are rejected.
2. `loadEnvFile` parses a comment and two assignments. It does not read a file in this test.
3. `.env.example` contains `change-me` and `127.0.0.1` and does not contain `supabase.co` or `service_role`. `.gitignore` contains `.env` and `!.env.example`. Root frontend scripts are unchanged.

`server/tests/rules.test.ts` (2):

1. A TypeScript copy of the intended window branches matches `isTimeCompatible` for all 25 pairs. The SQL text is checked only for the Today branch, the Tomorrow branch, and the `4 hours` branch. The `2 hours` and `3 hours` SQL branches are not read by the test. This review read them and they match the engine. The test would not catch a mistake in those two SQL branches.
2. `listingOutcomeAccount` keeps an 80 kg purchase linked to an 80 kg sold outcome at 80 kg accounted and 20 kg unaccounted. This calls the frontend function, not `nyuma_listing_accounted_grams`.

`server/tests/server.test.ts` (1):

1. A process bound to port 0 returns the not-configured health body and 404 for `GET /listings`.

`server/tests/schema.integration.test.ts` is the skipped test. The skip reason in the source is that `DATABASE_URL` is not set. The test body, if a local URL were present, would apply the migration and then check ownership, the administrator setting, zero quantity, a bad status, gram and cent values, duplicate ids, one incompatible window, a produce mismatch, listing over-allocation, cancel releasing hold, purchase-before-confirm, purchase cap, accounted overlap, a 40 kg sold link reported as 40000 grams, delete rejection, and one blocked `nyuma_lock_listing`. None of that ran. This review does not treat that file as a passing test.

Static checks cannot validate SQL syntax or trigger behaviour. They search the file for strings. A function body can be syntactically invalid and still contain `FOR UPDATE`. They do not prove locks block, that `AFTER` triggers see the new row, that `ROLLBACK TO SAVEPOINT` works in the integration helper, or that `node-pg` applies the multi-statement migration inside the surrounding transaction.

`loadConfig` in `server/src/config/env.ts` refuses hosts other than `localhost`, `127.0.0.1`, and `::1`, rejects placeholder markers, and rejects a missing database name. `npm run migrate` exits when the URL is missing or invalid and redacts the URL in the error. `npm start` stays up when the URL is absent. No remote connection is attempted by those paths. This review did not connect.

`.gitignore` lists `.env` and `**/.env`, and un-ignores `.env.example`. No `.env` file is in the workspace. `.env.example` contains only `change-me` and `127.0.0.1`. No service-role key or Supabase host is committed in the project source. `server/tests/config.test.ts` uses the dummy password `secret` in a unit-test URL and does not connect with it.

## 6. Exact files and SQL functions and triggers reviewed

Application and configuration:

- `server/package.json`
- `server/tsconfig.json`
- `server/vitest.config.ts`
- `server/src/index.ts`
- `server/src/config/env.ts`
- `server/src/db/client.ts`
- `server/src/db/migrate.ts`
- `server/src/db/operations.ts`
- `server/migrations/001_foundation.sql`
- `server/tests/schema.static.test.ts`
- `server/tests/schema.integration.test.ts`
- `server/tests/rules.test.ts`
- `server/tests/config.test.ts`
- `server/tests/server.test.ts`
- `.env.example`
- `.gitignore`
- `docs/NYUMA_BACKEND_IMPLEMENTATION.md` (compared with source, not used as proof)
- Root `package.json` scripts only

Domain rules used as the comparison:

- `src/lib/decisionEngine.ts` — `isTimeCompatible`, `WINDOW_LIMIT_HOURS`
- `src/lib/coordinationActivity.ts` — `heldMilli`
- `src/lib/outcomeAccounting.ts` — `listingOutcomeAccount`, `outcomeBlock`, `uncoveredGrams`
- `src/domain/relationships.ts` — `checkDocumentInvariants`, `heldMilli`
- `src/domain/coordinationRepository.ts` — `COMMITMENT_TRANSITIONS`, `recordCommitment`, `recordPurchase`
- `src/domain/records.ts` — status and category sets
- `src/domain/validateRecords.ts` — quantity and price decimal limits

SQL functions:

- `nyuma_grams`
- `nyuma_is_time_compatible`
- `nyuma_lock_listing`
- `nyuma_lock_demand`
- `nyuma_lock_for_commitment`
- `nyuma_lock_for_purchase`
- `nyuma_lock_for_outcome`
- `nyuma_listing_held_grams`
- `nyuma_demand_held_grams`
- `nyuma_listing_outcome_grams`
- `nyuma_listing_accounted_grams`
- `nyuma_assert_listing_quantities`
- `nyuma_assert_demand_hold`
- `nyuma_assert_commitment_purchases`
- `nyuma_assert_sold_link`
- `nyuma_claim_coordination_id`
- `nyuma_release_coordination_id`
- `nyuma_guard_administrator_role`
- `nyuma_user_roles_no_update`
- `nyuma_guard_role_removal`
- `nyuma_listings_guard`
- `nyuma_listings_check`
- `nyuma_demands_guard`
- `nyuma_demands_check`
- `nyuma_commitments_guard`
- `nyuma_commitments_check`
- `nyuma_purchases_guard`
- `nyuma_purchases_check`
- `nyuma_outcomes_guard`
- `nyuma_outcomes_check`

Triggers:

- `user_roles_guard_admin`
- `user_roles_no_update`
- `user_roles_guard_removal`
- `listings_claim_id`
- `listings_release_id`
- `listings_guard`
- `listings_check`
- `buyer_demands_claim_id`
- `buyer_demands_release_id`
- `buyer_demands_guard`
- `buyer_demands_check`
- `commitments_claim_id`
- `commitments_guard`
- `commitments_check`
- `purchases_claim_id`
- `purchases_guard`
- `purchases_check`
- `outcomes_claim_id`
- `outcomes_guard`
- `outcomes_check`

## 7. Recommended corrections

These are recommendations only. This review did not change the SQL.

1. Replace `nyuma_guard_administrator_role` before any role API. The inserting role must not be able to satisfy the check by itself. A session variable does not do that. Keep farmer, trader, and buyer assignment on the same trusted path. Do not add a login design in that change.
2. In `nyuma_listings_guard` and `nyuma_demands_guard`, lock the owner's matching `user_roles` rows `FOR SHARE` before accepting ownership. In `nyuma_guard_role_removal`, lock that account's listings or buyer demands `FOR UPDATE` before deciding the role can be removed.
3. Add a database constraint that `purchases.listing_id` equals the commitment's listing, and that an outcome's purchase and commitment belong to `outcomes.listing_id`. Triggers can stay as the source of the error text. The constraint should remain if triggers are off.
4. Keep `GET /health` as process liveness. Do not treat `database: "configured"` as a successful migration or a live connection.
5. Extend the static window test so a missing or altered `2 hours` or `3 hours` branch in `nyuma_is_time_compatible` fails the test. Execution on PostgreSQL should still compare the function with `isTimeCompatible` for all 25 pairs.
6. Leave `users.status` unused until a later milestone reads it on every write, or document that suspension does not yet block writes.

No correction is recommended to the hold formula, the separate accounted formula, or the decision to allow more than one sold outcome per purchase. Those match the current domain.

## 8. Minimum PostgreSQL integration tests required before approval

Run these on a local PostgreSQL 14 or newer database only. Do not point them at Supabase or any other remote host. Apply `001_foundation.sql` through `applyMigrations`, and roll the fixture back or delete it afterward. The existing skipped test is not enough even after it runs.

1. Migration applies once, a second run applies nothing, and the nine tables exist. No sample listing or sample user id is present after a clean apply.
2. Two sessions insert proposed commitments of 60 kg against one 100 kg open listing and one 100 kg open demand. Exactly one commit succeeds. The committed hold is 60 kg, not 120 kg.
3. Two sessions insert 60 kg commitments against different listings and the same 100 kg demand. Exactly one succeeds.
4. A 3-hour listing rejects a 4-hour demand. A Today listing accepts a 4-hour demand. A Today listing rejects a Tomorrow demand. A Tomorrow listing accepts a Tomorrow demand. Run the SQL function for all 25 window pairs and compare it with `isTimeCompatible`.
5. Different commodities are rejected. A closed listing and a closed demand are rejected.
6. Proposed holds agreed quantity. After cancel, that quantity is available again. Cancel is rejected after a purchase exists. Confirmed holds agreed quantity, not agreed plus purchased. Fulfilled holds only the purchased quantity. A purchase insert does not change commitment status.
7. A purchase before confirm is rejected. A purchase whose `listing_id` is a different listing is rejected. Two concurrent purchases that would exceed agreed quantity result in one rejection. Update and delete of a purchase are rejected.
8. A non-sold outcome with a `purchase_id` is rejected by the check constraint. A sold outcome for another listing's purchase is rejected. Two sold outcomes of 50 kg and 30 kg on an 80 kg purchase are both stored, and `nyuma_listing_accounted_grams` returns 80 kg, not 160 kg. A further 1 g sold outcome is rejected. A spoiled outcome that makes outcomes plus uncovered purchases exceed the listing is rejected.
9. Direct update from proposed to fulfilled is rejected. Insert of status `bogus` is rejected. Quantity `0` and a negative price are rejected. `0.001` kg and `10.25` shillings survive as those values.
10. Deleting a user, listing, demand, or commitment that still has dependent rows is rejected. A purchase row and an outcome row are still present after those rejected deletes.
11. An account can have farmer and trader at the same time. A buyer-only account cannot own a listing. A supplier without buyer cannot own a demand. Inserting administrator without the extra setting is rejected. The same session setting the custom variable and then inserting administrator must be treated as a known hole until correction 1 in section 7 is done, and the test should fail once that hole is closed.
12. One session holds `nyuma_lock_listing` and a second session's call does not finish until the first rolls back. Then repeat the test with two real commitment inserts, which is test 2, rather than stopping at the lock call.

Until those tests have been executed locally, this review does not say that the migration succeeded or that the integration test passed.
