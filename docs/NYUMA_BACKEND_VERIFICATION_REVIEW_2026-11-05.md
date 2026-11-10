# Nyuma backend verification — 5 November 2026

Follow-up to `docs/NYUMA_BACKEND_VERIFICATION_REVIEW.md`. This records Milestone 11B.1. The implementation detail is in `docs/NYUMA_BACKEND_IMPLEMENTATION.md` under Milestone 11B.1.

## Assessment

The two conditions in the original review are met for this local database.

The migration was applied to PostgreSQL 18.4 (`server_version_num` 180004) on `127.0.0.1:5433`, database `nyuma_dev`. `applyMigrations` applied `000_roles.sql` and `001_foundation.sql`. The second call applied nothing. The integration tests executed. None were skipped.

`nyuma.allow_admin_grant` is gone. Administrator assignment requires membership of `nyuma_provisioner`. A non-superuser login role that only inherits `nyuma_app` could not grant administrator by setting custom session variables, by calling `nyuma_grant_administrator`, by `SET ROLE nyuma_provisioner`, or by granting that role to itself. Farmer and trader assignment still succeeded.

## What changed since the original review

- Account-row locks close the role-removal race with listing and buyer-demand creation. The concurrent tests waited on the lock, then the losing transaction failed and left no inconsistent owner.
- Commitment status changes and purchase inserts lock the listing, then the buyer demand, then the commitment. `nyuma_app` cannot update a commitment directly. `runTransaction` retries only deadlock `40P01` and serialization `40001`. Twelve concurrent cancel-and-purchase pairs did not leave a cancelled commitment with a purchase, and did not exceed the agreed quantity.
- The database still rejects a purchase that overlaps existing outcomes. The prototype repository was not changed. The proposed later change is to teach `checkDocumentInvariants` the accounted-kilogram cap, without rewriting records already stored in the browser.
- `GET /health` reports the process only. `GET /ready` runs `SELECT 1` and reports `unavailable` when the connection fails.

## Results

Backend typecheck exited 0. Vitest 3.2.7: 6 files, 25 tests, 25 passed, 0 skipped.

Frontend typecheck exited 0. Vitest: 14 files, 143 tests, 143 passed. Production build: `dist/assets/index-r8a95rou.js` 339.79 kB, gzip 90.55 kB, and `dist/assets/index-_U5LYdja.css` 15.57 kB, gzip 4.10 kB.

`src/` was not modified. `nyuma.coordination.v1` and `nyuma.decisionSupport.scenario.v1` were not read or written. No sample records were inserted.

## Still open

`users.status` does not block writes. `numeric` columns still round extra digits. There is no composite foreign key from a purchase to its commitment's listing. `TRUNCATE` still bypasses row triggers. A superuser still passes `pg_has_role`. The repository can still store an overlapping purchase and outcome until the deferred domain change is made. Row Level Security, authentication, and the coordination API are not started.

The verification cluster used trust authentication and was stopped after the tests. The installed service on port 5432 was not used.
