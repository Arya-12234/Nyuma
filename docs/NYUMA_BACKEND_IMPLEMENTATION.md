# Nyuma backend foundation

This milestone adds a separate TypeScript API and a PostgreSQL schema for Nyuma's coordination records. It does not add authentication, registration, frontend API calls, listing or demand endpoints, matching, commitments, purchases, outcomes, WhatsApp, or deployment.

The approved architecture still stands: the React application remains the frontend, a small TypeScript API will be the only writer of coordination rows, and PostgreSQL is the shared store, with Supabase as the later host and identity provider. Two points in the architecture proposal are settled here rather than left open:

- An account can hold more than one role. The proposal had left one-role and multi-role unresolved. `user_roles` stores each assignment separately.
- Commitment produce, collection window, and quantity checks are enforced in the database as well as in the existing TypeScript rules. The proposal preferred to keep those rules only in TypeScript. An application check before insert cannot stop two concurrent requests from allocating the same kilograms, so the schema now locks the parent rows and rejects a write that no longer fits. The SQL window function is a backstop of `isTimeCompatible` in `src/lib/decisionEngine.ts`. It is not a second matching engine. Surplus, exposure, and match ranking stay in the existing TypeScript modules.

## Files created and modified

Created:

- `server/package.json`
- `server/package-lock.json`
- `server/tsconfig.json`
- `server/vitest.config.ts`
- `server/src/index.ts`
- `server/src/config/env.ts`
- `server/src/db/client.ts`
- `server/src/db/migrate.ts`
- `server/src/db/operations.ts`
- `server/migrations/000_roles.sql`
- `server/migrations/001_foundation.sql`
- `server/src/db/ready.ts`
- `server/src/db/transaction.ts`
- `server/tests/config.test.ts`
- `server/tests/server.test.ts`
- `server/tests/rules.test.ts`
- `server/tests/schema.static.test.ts`
- `server/tests/schema.integration.test.ts`
- `server/tests/transaction.test.ts`
- `.env.example`

Modified:

- `.gitignore`, so `.env` files are ignored and `.env.example` is not.

Not modified:

- Root `package.json`, its scripts, and its dependencies.
- `src/`, including domain records, the coordination repository, the matching adapter, surplus, outcome accounting, role workspaces, sample authentication, and navigation.
- `docs/NYUMA_BACKEND_ARCHITECTURE_PROPOSAL.md` and `docs/NYUMA_PILOT_READINESS_AUDIT.md`.
- Browser storage. This work did not read, write, delete, migrate, rename, or reset `nyuma.coordination.v1` or `nyuma.decisionSupport.scenario.v1`. No sample records were inserted.

## Backend framework and database library

The API is a Node.js `http` server in `server/`. It does not use Express or another web framework. `GET /health` reports that the process is running and does not mention the database. `GET /ready` opens the configured local database and runs `SELECT 1`. A missing URL is `not-configured`. A connection failure is `unavailable`. Neither route is a coordination API.

PostgreSQL access uses `pg` (node-postgres). Schema changes are SQL files in `server/migrations/`, applied in file-name order by `server/src/db/migrate.ts`. `000_roles.sql` is marked `-- nyuma:no-transaction` because `CREATE ROLE` cannot run inside a transaction. The migrator runs that file statement by statement and ignores a duplicate role (`42710`). `001_foundation.sql` runs in one transaction. Applied file names are recorded in `schema_migrations`.

From `server/`:

- `npm start` starts the API.
- `npm run migrate` applies pending migrations.
- `npm test` runs the backend tests.
- `npm run typecheck` runs `tsc --noEmit`.

The root `dev`, `test`, and `build` scripts are unchanged. Root Vitest still includes only `src/**/*.test.ts`, so frontend tests do not open a database.

## Database schema and relationships

PostgreSQL 14 or newer is required. The migration creates no accounts and no produce rows.

| Table | Purpose |
| --- | --- |
| `users` | Account shell. `id` is a UUID. `auth_user_id` is a nullable unique column reserved for Supabase Auth later. Status is `active`, `suspended`, or `deactivated`. |
| `profiles` | One profile per account: display name and an optional phone. Phone is not a login and is not copied onto listings. |
| `user_roles` | Explicit role assignments. The primary key is `(user_id, role)`, so one account can be both farmer and trader. Roles are `farmer`, `trader`, `buyer`, and `administrator`. |
| `coordination_ids` | One id across listings, buyer demands, commitments, purchases, and outcomes. This preserves the prototype rule that one id cannot be reused by two coordination records. |
| `listings` | Produce offered by a farmer or trader. Includes quantity kind `available` or `expected`. |
| `buyer_demands` | Quantity requested by a buyer. There is no draft status. |
| `commitments` | One listing and one buyer requirement, with an agreed quantity and price. |
| `purchases` | Quantity actually purchased against a confirmed commitment. |
| `outcomes` | Sold, recovered, spoiled, donated, or disposed quantity for a listing. A purchase link is optional. |

Ownership and links:

- A listing's `owner_id` references `users`. On insert, that account must already have the farmer or trader role. Administrator alone is not enough.
- A buyer demand's `buyer_id` references `users`. On insert, that account must have the buyer role.
- A commitment references one listing and one buyer demand.
- A purchase references one commitment and must name that commitment's listing.
- An outcome references one listing. Its commitment and purchase are optional. When a purchase is set, the category must be `sold`, and the purchase must belong to the same listing. A commitment named on that outcome must be the purchase's commitment.
- Every foreign key uses `ON DELETE RESTRICT`.
- Listing owner, commodity, and quantity unit cannot change. Buyer, commodity, and quantity unit on a demand cannot change. A commitment can change status only. Purchases and outcomes cannot be updated or deleted. Commitments cannot be deleted; cancellation is the retained history.
- `origin` is `live` by default, or `demonstration-import` later. Nothing was imported.

Coordination record ids use the existing text pattern: a letter or number, then up to 63 letters, numbers, hyphens, or underscores. User ids are UUIDs because accounts are new. Sample string ids such as `sample-trader` are not users in this database.

`quantity_kind` keeps expected harvest separate from produce that is available now. Expected quantity is not rewritten as available. Commitments can still refer to an expected listing, which is the same rule the prototype uses. Exposure for expected harvest stays a display rule in the existing TypeScript code, where that value is null.

## Constraints and indexes

Checks:

- Commodities: Watermelon, Mango, Tomato, Banana, Other.
- Locations: Kitui, Nairobi, Other.
- Windows: `2 hours`, `3 hours`, `4 hours`, Today, Tomorrow.
- Listing status: draft, open, closed, withdrawn.
- Buyer-demand status: open, closed, withdrawn.
- Commitment status: proposed, confirmed, fulfilled, cancelled.
- Outcome category: sold, recovered, spoiled, donated, disposed.
- Quantity unit is `kg`.
- Quantities are `numeric(14,3)` and must be greater than zero.
- Prices are `numeric(14,2)` and must be greater than zero. Listing asking price and buyer indicative price may be null.
- Outcome notes are at most 500 characters.
- A purchase-linked outcome must use category `sold`.

Relationship checks run in triggers:

- A new commitment requires an open listing and an open buyer demand, the same produce, the same quantity unit, and a collection window that passes `nyuma_is_time_compatible`. That function follows `isTimeCompatible`: Today fits every listing window, Tomorrow fits only Tomorrow, and an hour window fits only when its hour limit is less than or equal to the listing window. The limits are 2, 3, 4, 18, and 36.
- Proposed and confirmed commitments hold their agreed quantity. Fulfilled commitments hold purchased quantity only. Cancelled commitments hold nothing. The sum of those holds must stay within the listing quantity and within the buyer requirement, including the sum across commitments. One commitment also cannot agree more than the full requested quantity.
- A purchase is allowed only while its commitment is confirmed, must use that commitment's listing, and must not push the purchased total above the agreed quantity.
- A cancelled commitment cannot have a purchase, and a commitment that already has a purchase cannot be cancelled.
- Commitment status can move from proposed to confirmed or cancelled, and from confirmed to fulfilled or cancelled. Fulfilled and cancelled are terminal.
- Outcome quantities on a listing cannot exceed the listing. Sold outcomes linked to one purchase cannot exceed that purchase.
- Accounted quantity is every outcome once, plus the part of each purchase that no sold outcome already covers. A sold outcome linked to a purchase is stored as its own row and is not added again. Accounted quantity cannot exceed the listing. This is the write-time form of the formula in `src/lib/outcomeAccounting.ts`. Display totals remain in that TypeScript module.

Indexes:

- `listings_owner_idx`, `listings_open_match_idx` on open commodity and window.
- `buyer_demands_buyer_idx`, `buyer_demands_open_match_idx` on open commodity and collection window.
- `commitments_listing_idx`, `commitments_demand_idx`, `commitments_status_idx`.
- `purchases_commitment_idx`, `purchases_listing_idx`.
- `outcomes_listing_idx`, `outcomes_commitment_idx`, `outcomes_purchase_idx`.
- `user_roles_role_idx`.
- Primary keys and the unique `users.auth_user_id` column.

Administrator assignment is rejected unless `current_user` is a member of the database role `nyuma_provisioner`. A session variable cannot grant that membership. Farmer, trader, and buyer assignment is unchanged. Removing the last farmer or trader role is rejected while the account still owns a listing. Removing the buyer role is rejected while the account still owns buyer demand. A role row cannot be rewritten in place. The privilege boundary is described under Milestone 11B.1 below.

## Quantity and price precision

Quantities are stored in kilograms as `numeric(14,3)`, which is gram precision. Prices are stored in Kenyan shillings per kilogram as `numeric(14,2)`, which is cent precision. Checks reject zero and negative values. Optional prices reject a non-null value that is not greater than zero.

`numeric(14,3)` and `numeric(14,2)` round extra fractional digits when a value is assigned. They do not, by themselves, reject `1.2345` kilograms or `10.129` shillings. The later API must reject those values before insert, using the same 3-decimal and 2-decimal checks already in `src/domain/validateRecords.ts`. Hold and accounted comparisons convert stored quantities with `round(quantity * 1000)` so the comparison unit is grams.

## Concurrent commitment safety

`server/src/db/operations.ts` names the later operations that must run in one transaction:

- Creating a listing or buyer demand, and removing a role, lock the account row in `users` first.
- Recording a commitment locks the listing, then the buyer demand.
- Changing a commitment status locks the listing, then the buyer demand, then the commitment, and then updates the status. The ordinary application role cannot `UPDATE` `commitments` directly. It calls `nyuma_set_commitment_status`.
- Recording a purchase locks the listing, then the buyer demand, then the commitment, and then inserts. The ordinary application role calls `nyuma_insert_purchase`.
- Recording an outcome locks the listing, then the purchase when there is one.
- Reducing a listing or buyer-demand quantity locks that parent row.

The lock helpers are `SECURITY DEFINER` with `search_path` fixed to `pg_catalog, public`. They use `SELECT … FOR UPDATE`. A transaction that already holds those locks does not deadlock with itself.

The after-insert and after-update triggers recalculate holds and accounted quantity while those locks are held. A second transaction waits, then sees the first transaction's committed rows. If the remaining quantity is no longer enough, the trigger raises an exception and the transaction rolls back. A check in application code before the insert is not the control that prevents over-allocation.

Lock order is users, listings, buyer demands, commitments, purchases, then outcomes. `runTransaction` in `server/src/db/transaction.ts` retries only SQLSTATE `40P01` (deadlock) and `40001` (serialization failure), at most three attempts, and only after `ROLLBACK`. It does not retry validation or constraint failures.

The commitment HTTP API is not implemented in this milestone. The functions and triggers are the prepared database path for it.

## Environment configuration

`.env.example` contains placeholders only:

- `DATABASE_URL=postgres://postgres:change-me@127.0.0.1:5432/nyuma`
- `PORT=8787`
- `HOST=127.0.0.1`

Copy it to `.env` or `server/.env` and replace `change-me` only when a local database exists. The process environment wins, then `server/.env`, then the root `.env`. A missing file is ignored.

`loadConfig` accepts a missing database URL. The API then starts. `GET /health` returns `{ ok: true, service: "nyuma-api" }` and does not claim the database is ready. `GET /ready` returns 503 `{ ok: false, database: "not-configured" }` when the URL is missing, and 503 `{ ok: false, database: "unavailable" }` when a connection fails. It rejects a placeholder password, a non-PostgreSQL scheme, a URL without a database name, and any database host other than `localhost`, `127.0.0.1`, or `::1`. `HOST` must be `127.0.0.1` or `localhost`, so this process does not bind a public interface. Migrate refuses to run without a valid local URL. Connection errors are printed with the URL redacted. Readiness errors do not include the connection string.

No Supabase project, service-role key, or production database URL was created or stored. `.gitignore` ignores `.env` and does not ignore `.env.example`.

## Whether migrations were executed

Milestone 11B did not execute them. Milestone 11B.1 did, on a local database only. The result is in the section below. No Supabase project was created. The installed PostgreSQL service on `127.0.0.1:5432` was not used, because that cluster requires a password and none was supplied.

## Tests and results

The current results are in Milestone 11B.1 below. The earlier 11B run, before these corrections, was typecheck exit 0 and Vitest 13 passed with 1 integration test skipped. That skipped test is not the result of this milestone.

## Unresolved risks and decisions

- `numeric` columns round extra decimal places instead of rejecting them. The later API must reject those values first.
- `users.status` is stored and is not read by any write trigger. Suspension does not block a listing, demand, commitment, purchase, or outcome.
- Row Level Security is not enabled. The proposal's deny-by-default policies need Supabase's `anon` and `authenticated` roles, and this milestone does not add Supabase Auth. Database constraints are the current backstop. RLS remains a later hosting step.
- A listing or buyer-demand window can change after a commitment is saved. Existing commitments are not rechecked. The prototype checks the window when the agreement is recorded, and the database does the same.
- A commitment inserted with status `fulfilled` holds nothing and can never receive a purchase, because a purchase requires `confirmed` and fulfilled is terminal. The later API should create commitments as `proposed`.
- `TRUNCATE` bypasses row triggers. The application role is not granted that command by this migration, and the later API must not issue it.
- A superuser satisfies `pg_has_role` for every role. The ordinary application role is not a superuser. The table owner can still `UPDATE` a commitment directly, which locks that row before the listing. `nyuma_app` cannot.
- Purchase `listing_id` is checked by the purchase trigger, not by a composite foreign key. The cross-listing insert was rejected in the integration test.
- The prototype repository can still save a purchase that overlaps kilograms an existing outcome already covers. The database rejects that state. Changing `checkDocumentInvariants` would change existing frontend domain behaviour, so it was not done. The proposed change is in Milestone 11B.1.
- Region, legal hosting, phone login, and whether an open requirement shows a buyer name remain open from the architecture proposal. They do not change this schema. Purchase and outcome correction remains a later product choice: these tables reject in-place edits so a correction has to be an explicit later design.

## Frontend and stored prototype data

The frontend source was not changed. Root scripts and dependencies were not changed. The production bundle hashes match the build from before this work. Neither `nyuma.coordination.v1` nor `nyuma.decisionSupport.scenario.v1` was read or written. No sample Nyuma records were loaded into a database.

Authentication, registration, and frontend integration are not started.

## Milestone 11B.1 — security remediation and PostgreSQL verification

Date: 5 November 2026. This section supersedes the earlier statements that the migration had not been executed and that administrator assignment used `nyuma.allow_admin_grant`. That session variable has been removed.

### Administrator provisioning

Two cluster roles are created by `000_roles.sql`. Neither can log in, and neither has a password.

- `nyuma_provisioner` is the only role that may grant or remove `administrator`.
- `nyuma_app` is the ordinary application role. It is not a member of `nyuma_provisioner`.

`nyuma_guard_administrator_role` allows an administrator insert only when `pg_has_role(current_user, 'nyuma_provisioner', 'MEMBER')` is true. `nyuma_guard_role_removal` uses the same membership check before deleting an administrator row. `nyuma_grant_administrator(uuid)` is `SECURITY INVOKER`. Execute permission is revoked from `PUBLIC` and from `nyuma_app`, and granted only to `nyuma_provisioner`. The function inserts into `user_roles`, so a member must `SET ROLE nyuma_provisioner` first. The migration grants `nyuma_provisioner` to the user that applies it (`GRANT nyuma_provisioner TO CURRENT_USER`) and grants that role `SELECT`, `INSERT`, and `DELETE` on `user_roles` only.

There is no HTTP route for this. The role has no password, so none is in frontend code, a committed file, or `.env.example`. Farmer, trader, and buyer inserts do not use this check.

A PostgreSQL superuser passes `pg_has_role` for every role. The application connection must be `nyuma_app`, or a login role that inherits only `nyuma_app`, and must not be a superuser.

### Role-removal races

`nyuma_lock_user` takes `SELECT … FOR UPDATE` on the `users` row. Listing insert calls it before the farmer-or-trader check. Buyer-demand insert calls it before the buyer check. Role removal calls it before the ownership check. The two operations then wait on the same account row. After one commits, the other reads the committed roles or the committed listing or demand. The integration test held each lock and observed the other session still waiting, then checked that the losing write did not leave a listing without a supplier role or a demand without a buyer role.

### Lock order and deadlocks

The order is `users`, `listings`, `buyer_demands`, `commitments`, `purchases`, `outcomes`.

A direct `UPDATE` of a commitment locks that row before the trigger can lock the listing. `nyuma_app` has `UPDATE` revoked on `commitments`. Status changes go through `nyuma_set_commitment_status`, which locks the listing, then the buyer demand, then the commitment, and only then updates. `nyuma_insert_purchase` uses that same order before insert. `nyuma_lock_for_purchase` also locks the buyer demand, so a trigger that locks again follows the same order.

`runTransaction` retries only `40P01` and `40001`. Twelve concurrent pairs of cancellation and purchase creation, on separate connections, finished without either code escaping. Each pair ended as cancelled with no purchase, or confirmed with the one purchase. Purchased grams stayed within the agreed 30 kg. The retry helper itself was unit-tested with a fake client: a deadlock was retried, and a validation error was not.

### Purchase and outcome consistency

The database rule was kept. `nyuma_listing_accounted_grams` counts every outcome once and adds only the uncovered part of each purchase. Two sold outcomes of 20 kg on a 40 kg purchase account as 40 kg. A further 0.001 kg sold outcome is rejected. A purchase of 80 kg after an existing spoiled outcome of 30 kg on a 100 kg listing is rejected, and the accounted total stays 30 kg.

`checkDocumentInvariants` in `src/domain/relationships.ts` does not apply that sum when a purchase is saved, so the prototype repository can still store the overlapping state. Changing that function would change existing frontend domain behaviour. It was not changed. No saved record and neither localStorage key was read or written.

Proposed later change, not implemented: when `checkDocumentInvariants` validates a purchase or an outcome, reject the document if accounted kilograms would exceed the listing quantity, using `listingOutcomeAccount`. That would stop a direct repository write from storing a state the database already rejects. It must not change the meaning of records already stored under `nyuma.coordination.v1`.

### PostgreSQL version and migration

Verification used a temporary cluster created with the local PostgreSQL 18 binaries. It listened only on `127.0.0.1:5433`, with trust authentication, database `nyuma_dev`, and no customer data. It is not the installed service on port 5432.

- Version: PostgreSQL 18.4 on x86_64-windows, compiled by msvc-19.44.35226, 64-bit. `server_version_num` is 180004.
- Fresh database. `applyMigrations` returned `000_roles.sql`, then `001_foundation.sql`.
- `schema_migrations` recorded both at 2026-11-05 13:22:46+03.
- The second call in that same run returned no files.

### Integration results

`DATABASE_URL` was `postgres://nyuma@127.0.0.1:5433/nyuma_dev`. The integration file throws if that variable is missing. No test was skipped. Concurrent cases used separate connections and `Promise.all`.

Vitest 3.2.7, from `server/`, after `tsc --noEmit` exited 0:

- Test files: 6 passed.
- Tests: 25 passed, 0 skipped.

Integration tests, all executed:

- Schema created. The integration query found `users`, `user_roles`, `listings`, `buyer_demands`, `commitments`, `purchases`, and `outcomes`. Readiness against the live connection was `ready`.
- `nyuma_it_app`, a non-superuser login member of `nyuma_app` only, inserted farmer and trader. Setting `nyuma.allow_admin_grant` and another custom variable, calling `nyuma_grant_administrator`, `SET ROLE nyuma_provisioner`, and `GRANT nyuma_provisioner` all failed. The administrator row was absent. After `SET ROLE nyuma_provisioner`, the migration user granted administrator. The application role could not delete that row.
- A locked account lost the farmer role before a waiting listing insert. The insert failed and the account owned no listing. A listing insert that already held the account lock made a waiting role delete fail, and the farmer role remained. The same happened for buyer demand.
- `nyuma_is_time_compatible` matched `isTimeCompatible` for all 25 window pairs.
- Two concurrent 60 kg commitments on one 100 kg listing: exactly one committed, hold 60000 grams.
- Two concurrent 60 kg commitments on different listings and one 100 kg demand: exactly one committed, demand hold 60000 grams.
- Purchase before confirm failed. Purchase against a cancelled commitment failed. A proposed commitment could not become fulfilled. After confirm, 40 kg was stored and a further 21 kg was rejected. A purchase naming another listing was rejected. Status stayed confirmed until fulfilment. Fulfilment by `nyuma_app` through `nyuma_set_commitment_status` changed the hold from 60000 grams to 40000 grams. A direct `UPDATE` by `nyuma_app` was permission denied. Purchase update and delete were rejected. Commitment delete was rejected. Listing delete was rejected while a commitment existed.
- A failed second insert inside an open transaction, followed by `ROLLBACK`, left the first uncommitted commitment absent.
- A non-sold outcome linked to a purchase was rejected. Two sold outcomes of 20 kg on a 40 kg purchase accounted as 40000 grams, not 80000. An extra 0.001 kg sold outcome was rejected. A 70 kg spoiled outcome on that 100 kg listing was rejected. Outcome delete was rejected. `0.001` kg and `10.25` shillings were stored as those values, with quantity kind `expected`.
- Spoiled 30 kg followed by a purchase of 80 kg was rejected. Accounted grams stayed 30000.
- Twelve concurrent cancellation and purchase pairs: no deadlock or serialization code escaped, no cancelled commitment kept a purchase, and purchased quantity did not exceed the agreed quantity.

The application password used for `nyuma_it_app` was a random value held in the test process and dropped with the role. It was not written to a file.

### Backend and frontend commands

Backend, from `server/`: `npx tsc --noEmit` exited 0, then Vitest 25 passed.

Frontend, from the repository root, with no source change in `src/`:

- `npx tsc --noEmit` exited 0.
- `npm test`: 143 passed, 14 files.
- `npm run build` exited 0. `dist/assets/index-r8a95rou.js` 339.79 kB, gzip 90.55 kB. `dist/assets/index-_U5LYdja.css` 15.57 kB, gzip 4.10 kB. These are the same asset names as the build before the backend work.

`npm` printed `Unknown env config "devdir"`. That warning comes from the local npm configuration.

### Remaining limitations

The items in Unresolved risks still apply. In addition, the integration run did not insert a closed listing, a mismatched commodity, a zero quantity, or a negative price, and it did not run two purchases concurrently against one commitment. Those paths are still enforced by the existing checks and triggers. The real deadlock retry was not observed, because the ordered locks did not deadlock; the retry behaviour was proven with a fake client.

The temporary cluster was stopped after this verification. Trust authentication on port 5433 should not be left running.
