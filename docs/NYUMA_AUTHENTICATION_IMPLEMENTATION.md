# Nyuma authentication and identity foundation

Date: 5 November 2026. This milestone adds server-side Supabase Auth integration and links a verified Supabase user to a Nyuma account. It does not add coordination endpoints, and it does not connect the React prototype to Supabase or to this API.

No Supabase project is configured. Nothing in this milestone called a live Supabase Auth service. Registration, login, logout, and refresh are implemented against the Supabase Auth client and are covered with a mock gateway. Token checks use locally signed tokens. PostgreSQL checks ran on the local verification database as `nyuma_app`, not as a superuser.

## Files created and modified

Created:

- `server/migrations/002_identity.sql`
- `server/src/auth/tokens.ts`
- `server/src/auth/supabaseAuth.ts`
- `server/src/auth/identity.ts`
- `server/src/db/applicationRole.ts`
- `server/src/http/dispatch.ts`
- `server/tests/auth.test.ts`
- `server/tests/identity.integration.test.ts`
- `docs/NYUMA_AUTHENTICATION_IMPLEMENTATION.md`

Modified:

- `server/package.json` and `server/package-lock.json` (`jose` 6.2.15 and `@supabase/supabase-js` 2.119.0)
- `server/src/index.ts`
- `server/src/config/env.ts`
- `server/src/db/ready.ts`
- `server/vitest.config.ts`
- `server/tests/config.test.ts`
- `server/tests/server.test.ts`
- `server/tests/schema.static.test.ts`
- `server/tests/schema.integration.test.ts`
- `.env.example`

Not modified:

- `src/`, including sample accounts, workspaces, navigation, the decision engine, the practice scenario, and the coordination workflow.
- Root `package.json`.
- Browser storage. `nyuma.coordination.v1` and `nyuma.decisionSupport.scenario.v1` were not read or written.

## Authentication flow

The API is the only component that talks to Supabase Auth.

- `POST /auth/register` accepts an email and a password and calls `supabase.auth.signUp`. Extra fields, including `role`, `userId`, and `user_metadata`, are ignored. The password is not written to PostgreSQL and is not logged.
- `POST /auth/login` calls `signInWithPassword`. A failure is `401` with `invalid-credentials`. The response does not say whether the email exists.
- `POST /auth/refresh` exchanges a refresh token.
- `POST /auth/logout` requires a verified access token, then calls Supabase `POST /auth/v1/logout` with that token and the anon key. It does not use the admin API.
- `GET /auth/health` reports whether the auth URL and anon key are present, and whether token verification can be configured. It does not return the URL, the key, or the JWT secret.

If `SUPABASE_URL` or `SUPABASE_ANON_KEY` is missing or still a placeholder, register, login, logout, and refresh return `503` `auth-not-configured`. They do not open a network connection.

The anon key stays in server environment. `SUPABASE_SERVICE_ROLE_KEY` is rejected at startup if it is set. `.env.example` contains placeholders only. `.env` stays ignored.

Login returns the user's access token and refresh token in the JSON body so a later client can hold them. The architecture recommends an httpOnly cookie when the API and the site can share one, and it forbids `localStorage`. Cookie delivery is not implemented. That choice waits on the deployment hostname. The prototype session in `nyuma.session.v1` is unchanged.

Password recovery is the provider's email flow. This milestone does not add a recovery endpoint and does not verify passwords itself.

There is no Supabase project, so the issuer, audience, and signing key of a real project were not confirmed against a dashboard. The code expects the documented project shape:

- Issuer: `https://<project-ref>.supabase.co/auth/v1`
- Audience: `authenticated`
- Current signing: ES256 or RS256, public keys at `https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json`
- Legacy signing: HS256 with `SUPABASE_JWT_SECRET`

`SUPABASE_URL` must be `https://<project-ref>.supabase.co`. It is not used as a database connection. `DATABASE_URL` and `APP_DATABASE_URL` still have to be local PostgreSQL URLs.

## Token verification

Verification uses `jose` `jwtVerify`. The library checks the signature, the issuer, the audience, and the expiry. A decoded payload is not accepted on its own.

The token header selects the key. `HS256` uses the server JWT secret. `ES256` and `RS256` use the project JWKS. `none` and any other algorithm are rejected. A token whose `role` claim is `service_role` or `anon` is rejected. Nyuma does not read `user_metadata` or `app_metadata` for authorization.

The authenticated Supabase user id is the verified `sub` claim. Request bodies, query strings, and untrusted headers are not accepted as that id. Missing, malformed, badly signed, expired, wrong-issuer, and wrong-audience tokens return `401` `unauthenticated`. The body does not echo the token.

The JWKS request was not executed. No project URL was available. ES256 was tested with a key pair generated in the test process. HS256 was tested with a local secret.

## Identity linking

`POST /me/bootstrap` inserts `users.auth_user_id` from the verified `sub`. The column is already unique. A second bootstrap for the same `sub` returns the same Nyuma account. Two concurrent bootstraps were run against PostgreSQL and returned one id.

A body field named `userId` or `authUserId` is ignored. The application role cannot `UPDATE` `users`, so it cannot point an existing row at a different Supabase user. A direct update of `auth_user_id` is also rejected by `nyuma_users_guard` when a role that can update the table attempts it. The test covered both.

`GET /me` returns the Nyuma account id, `users.status`, the roles stored in `user_roles`, and `active_role`. It returns `404` `account-not-bootstrapped` when the verified identity has no row yet.

## Ordinary role assignment

This part is not implemented. It needs a product decision.

The architecture says a role is chosen at registration and that the client cannot send a role and have it trusted. Milestone 11B also made roles a set, not one column. Those two statements do not pick a safe registration rule. The API therefore creates the Nyuma account with no roles.

Options for approval:

1. During onboarding, the person asks for one or more of farmer, trader, and buyer. The API inserts only those values. Administrator is never in the set. This trusts the person's choice of ordinary role.
2. A trusted operator inserts farmer, trader, and buyer rows outside the request path. The account has no workspace until that happens. This matches "do not trust a role supplied by the browser."
3. A later reviewed endpoint accepts exactly one ordinary role at registration. Adding another role stays a separate decision. Administrator stays impossible on that path.

Until one of these is chosen, `PUT /me/workspace` cannot create a role. Selecting `administrator`, or any role the account does not already hold, returns `403` `workspace-not-assigned` and inserts nothing.

## Multiple roles and the active workspace

`user_roles` is unchanged. An account can hold farmer and trader together. Roles are read from PostgreSQL, not from the token.

`users.active_role` stores the selected workspace. `nyuma_set_active_role` updates it only when that role is already in `user_roles`. The check is repeated by `nyuma_users_guard`. Removing the selected role clears `active_role`. The tests covered a farmer-and-trader account, a successful trader selection, a rejected buyer selection, a rejected administrator selection, and clearing the workspace when the farmer role was removed.

The API does not pick a workspace automatically when the account has one role or several.

## Administrator provisioning

`nyuma_grant_administrator` is not called by any route. `nyuma_app` is not a member of `nyuma_provisioner` and cannot `SET ROLE` to it. That was tested again with the identity login role. Registration, token metadata, the bootstrap body, and workspace selection cannot insert an administrator row.

The ordinary API connection is `APP_DATABASE_URL`. On each checkout the pool runs `assertApplicationRole`. A superuser session, or a member of `nyuma_provisioner`, is refused. `GET /ready` uses that check. The operator URL used for migrations is reported `unavailable` by that check. The `nyuma_it_identity` login, which only inherits `nyuma_app`, is reported `ready`.

`002_identity.sql` revokes `UPDATE` on `users` from `nyuma_app` and revokes `TRUNCATE` on the coordination tables from `PUBLIC` and `nyuma_app`. The identity login could not `TRUNCATE users` and could not change `users.status`.

## Disabled accounts

`suspended` and `deactivated` are not `active`. `GET /me`, bootstrap, and workspace selection return `403` `account-disabled` before any workspace change. The suspended case was executed on PostgreSQL. The application role could not set the status back to `active`. Historical rows are not deleted.

## Tests

Backend, from `server/`, with `DATABASE_URL=postgres://nyuma@127.0.0.1:5433/nyuma_dev`:

- `npx tsc --noEmit` exited 0.
- Vitest 3.2.7: 8 files, 33 tests, 33 passed, 0 skipped.

Mocked, and labelled as such in `server/tests/auth.test.ts`:

- Missing, malformed, wrong-signature, expired, wrong-issuer, and wrong-audience tokens.
- A valid HS256 token whose metadata says administrator. The verified id is the `sub`. The metadata is not a role.
- An ES256 token checked with the matching public key, and rejected with a different public key.
- Registration that sends `role: administrator` does not create a Nyuma role and does not call the identity store.
- Repeated bootstrap on a mock store returns one account.
- A bootstrap body that names another account does not move the link.
- Multiple roles, an invalid workspace, and an administrator workspace selection.
- A suspended mock account is rejected.
- A thrown login error that contains the password and the access token is not copied into the response or the log. `GET /auth/health` does not contain the anon key or the JWT secret.

PostgreSQL, in `server/tests/identity.integration.test.ts`. Supabase was not called. Tokens were signed locally.

- The operator connection fails the application-role check. `applicationReadiness` on that URL is `unavailable`. The app login is `ready`.
- Two concurrent bootstraps return one account and one `auth_user_id` row.
- An HTTP bootstrap that posts another user id and `role: administrator` returns the original account and no administrator row.
- Changing `auth_user_id` is rejected. `UPDATE` and `TRUNCATE` by the app login are permission denied. `SET ROLE nyuma_provisioner` is permission denied.
- Farmer and trader can both be held. Buyer and administrator workspace selections fail. Removing the active role clears it.
- A suspended account is rejected, and the app login cannot unsuspend it.

`002_identity.sql` applied at 2026-11-05 14:05:04+03. PostgreSQL 18.4, `server_version_num` 180004. The database was the local verification cluster on `127.0.0.1:5433`. The installed service on port 5432 was not used.

`npm audit --omit=dev` reported 0 vulnerabilities. The dev dependency `vitest` 3.2.4 has published advisories whose fix is Vitest 5. That upgrade was not made here.

Frontend, from the repository root, with no `src/` change:

- `npx tsc --noEmit` exited 0.
- `npm test`: 143 passed, 14 files.
- `npm run build` exited 0. `dist/assets/index-r8a95rou.js` 339.79 kB, gzip 90.55 kB. `dist/assets/index-_U5LYdja.css` 15.57 kB, gzip 4.10 kB.

## Remaining decisions

- Choose how the first farmer, trader, or buyer role is granted. The three options are above. No option is implemented.
- Create a Supabase project before any live registration test. Confirm the signing key is JWKS (ES256 or RS256) or legacy HS256, and set only the matching server variables.
- Decide whether the later frontend receives tokens in JSON or in an httpOnly cookie. Do not put them in `localStorage`.
- Password recovery, display name, and phone remain out of this API.
- `deactivated` uses the same rejection as `suspended`. Only `suspended` was inserted in the integration test.
- The JWKS HTTP fetch was not run. Asymmetric verification was tested with a local ES256 key.
- A person who can connect as the migration superuser can still pass `pg_has_role` and can still grant administrator. The API refuses that connection.
- Row Level Security is still not enabled. The browser has no database connection.
- Vitest's dev-tooling advisories remain until a planned upgrade.

The temporary cluster was stopped after this verification. Coordination endpoints and frontend integration are not started.
