# Nyuma backend architecture proposal

Design date: 5 November 2026.
Status: proposal only. No backend, database, package, environment file, or application code was changed for this document.
Pilot context: watermelon coordination on the Kitui–Nairobi route, starting with about 20 traders, plus farmers and buyers. The shared platform has to come before WhatsApp.

This document separates **verified facts** about the current prototype from **recommendations**. Assumptions are marked as assumptions.

## 1. Executive recommendation

Keep the React application and the existing TypeScript domain rules. Add a small Nyuma API, written in TypeScript, in front of a PostgreSQL database. Use Supabase only as the managed PostgreSQL host and as the identity provider that issues sessions.

The React app must not write coordination tables with a public database key. Every listing, requirement, agreement, purchase, and outcome write goes through the API. The API checks the caller’s session, role, and ownership, then runs the existing domain checks inside a database transaction. PostgreSQL enforces foreign keys, allowed statuses, positive quantities, and immutable ownership and commodity. The hold, overlap, and matching rules stay in the TypeScript modules that already implement them. They are not copied into SQL and they are not copied into React.

Supabase Auth replaces the sample catalogue for real accounts. Row Level Security on the database is a backstop: the browser roles cannot write coordination rows. It is not the only access check.

The practice scenario stays in the browser under `nyuma.decisionSupport.scenario.v1`. It is not imported into live coordination tables.

This is the smallest design that gives shared records, relational integrity, and server-side rejection of an unauthorized request, without throwing away `CoordinationRepository` or the decision engine.

## 2. Findings from actual code inspection

### Stack and deployment

Verified in `package.json`, `package-lock.json`, `vite.config.ts`, and `tsconfig.json`:

- The app is a private Vite 6 and React 18 SPA. TypeScript is strict. The production build is `tsc --noEmit && vite build`. Tests are Vitest 3, environment `node`, including `src/**/*.test.ts` and `src/**/*.test.tsx`.
- Runtime dependencies are only `react` and `react-dom`. There is no router library, no data client, no auth SDK, and no database driver.
- `src/main.tsx` mounts `App` into `#root`. Navigation is hash-based in `src/App.tsx` and `src/lib/access.ts`. There is no service worker and no `fetch` call under `src`.
- No `.env` file, no deployment config, and no application CI workflow are present in the project. Nothing in the repo assumes a host, region, or secret name.

### Identity

Verified in `src/lib/auth.ts` and `src/lib/sampleUsers.ts`:

- Sign-in compares the password in the browser to four sample accounts. The session type is `SampleSession`. The password is not stored in the session.
- The session is written to `nyuma.session.v1`. A session that does not match the sample catalogue is rejected by `readSampleSession`.
- There is no registration, no expiry timer, no password recovery, and no server. Logout removes only the session key.
- Roles are a single value: `farmer`, `trader`, `buyer`, or `administrator`. One account has one role.

### Access control today

Verified in `src/lib/access.ts` and `src/lib/coordinationWorkflow.ts`:

- Page access is `authorizeSection`. Button and workflow access is `authorizeAction` and `authorizeOwnRecord`. Those checks run in the browser.
- Farmers and traders may create and edit their own listings, record outcomes on their own listings, and take part in an agreement when they own the listing.
- Buyers may create and edit their own requirements, and take part in an agreement when they own the requirement.
- Buyers and administrators cannot record outcomes. Administrators cannot create agreements, cancel them, or record purchases.
- `commitmentParty` allows a buyer only through their own requirement, and a farmer or trader only through their own listing. An administrator fails that check.
- Hiding a nav link is not what stops a direct hash: `viewForHash` sends another role to the denied view. A person who can read `localStorage` still sees every coordination record. `browserCoordinationRepository()` returns the whole document. `listListings`, `listBuyerDemands`, `listCommitments`, `listPurchases`, and `listOutcomes` do not filter by caller.

### Domain records

Verified in `src/domain/records.ts`. These are separate types and must stay separate:

| Record | Identity | Meaning in the current code |
|---|---|---|
| `Listing` | `ownerId` | Supply. `quantityKind` is `available` or `expected`. Status is `draft`, `open`, `closed`, or `withdrawn`. Commodity and owner are not in the update patch. |
| `BuyerDemand` | `buyerId` | A requirement. Status is `open`, `closed`, or `withdrawn`. There is no demand draft. It is not an order. |
| `Commitment` | `listingId` and `buyerDemandId` | An agreement. Status is `proposed`, `confirmed`, `fulfilled`, or `cancelled`. The UI creates `confirmed` only. There is no initiator field. |
| `Purchase` | `commitmentId`, and `listingId` copied from the commitment | Kilograms actually bought. No update or delete method. |
| `Outcome` | `listingId`, optional `commitmentId` and `purchaseId` | `sold`, `recovered`, `spoiled`, `donated`, or `disposed`. Notes up to 500 characters. No update or delete method. |

A match is not one of these records. `matchListingToDemand` in `src/domain/matchListing.ts` returns a `ListingMatch` in memory. The trader Matches screen calls it and does not save the result. Only `src/domain/matchListing.test.ts` and `src/lib/traderRecords.ts` import the adapter.

### Persistence

Verified in `src/domain/coordinationDocument.ts`, `src/domain/coordinationRepository.ts`, and `src/lib/coordinationClient.ts`:

- Coordination JSON lives at `nyuma.coordination.v1`, schema version 1. `COORDINATION_MIGRATIONS` is empty. An unknown version or an invalid document is left byte-for-byte unchanged.
- The document keys are `version`, `listings`, `buyerDemands`, `commitments`, `purchases`, and `outcomes`.
- `createInMemoryCoordinationRepository` and `createLocalCoordinationRepository` implement `CoordinationRepository`. A write clones state, validates, runs `checkDocumentInvariants`, and only then replaces memory. If `localStorage.setItem` throws, the local repository rolls memory back.
- The repository is a single-threaded document store. It has no row locks and no multi-user transaction. Two browsers do not share the document.
- The practice scenario lives at `nyuma.decisionSupport.scenario.v1` in `src/lib/scenarioStorage.ts`. It is a form plus selected sample-buyer ids. It is not a listing.

### Rules that already exist, and where they live

Verified by reading `src/domain/relationships.ts`, `src/domain/coordinationRepository.ts`, `src/lib/coordinationActivity.ts`, `src/lib/coordinationWorkflow.ts`, `src/lib/surplus.ts`, and `src/lib/outcomeAccounting.ts`.

The repository and `checkDocumentInvariants` enforce:

- Unique ids across all five collections.
- A commitment references an existing listing and requirement of the same commodity and unit.
- One commitment’s agreed quantity cannot exceed that requirement’s full requested quantity.
- A purchase references its commitment, uses the commitment’s listing id, and cannot be recorded unless the commitment status is `confirmed`.
- Purchases on one commitment cannot exceed the agreed quantity.
- Held quantity on a listing cannot exceed the listing quantity. Proposed and confirmed hold the agreed quantity. Fulfilled holds only purchased quantity. Cancelled holds nothing.
- A cancelled commitment cannot have a purchase.
- Outcomes cannot exceed the listing quantity. A purchase-linked outcome must be `sold` and cannot exceed that purchase. Commodity cannot change after create. Listing and requirement status must be `open` to record a commitment.
- Commitment status can only move `proposed → confirmed|cancelled`, then `confirmed → fulfilled|cancelled`. Fulfilled and cancelled are terminal.

The workflow, not the repository, also enforces:

- The caller’s role and ownership before a save.
- `agreementBlock`: same produce and `isTimeCompatible` from `src/lib/decisionEngine.ts`. Location is stored and is not a transport or eligibility rule.
- The **sum** of holds against one requirement, through `remainingDemandKg`. The repository checks each commitment against the full requested quantity, not the sum of commitments on that requirement.
- Purchase quantity against `remainingCommitmentKg` before save.
- `outcomeBlock` in `src/lib/outcomeAccounting.ts`, which refuses a non-linked outcome that overlaps uncovered purchase kilograms. A direct `recordOutcome` on the repository can still overlap. The screens use the workflow.

Surplus and outcome totals are derived. They are not stored. `exposureReport` and `listingOutcomeAccount` are the current definitions of still exposed and still unaccounted. Unaccounted quantity is not a spoilage record. Expected harvest has `exposedKg` null.

Dashboard agreement totals use `confirmedQuantityKg`, which ignores proposed, fulfilled, and cancelled. Purchase totals use `purchasedQuantityKg`, which counts each purchase once.

### Weaknesses to carry into the design, not to fix in this milestone

- Anyone with the browser profile can read every coordination row, including outcome notes.
- Role checks are not a security boundary.
- Two clients cannot share records, and the repository cannot lock a listing against a concurrent agreement.
- The demand-level remaining check and the outcome overlap check exist only in the workflow. A future API that called `recordCommitment` or `recordOutcome` alone would be weaker than the screens.
- Sample passwords are in source and on the login screen. They must not be reused as production credentials.
- There is no audit log, backup, or account deactivation.

## 3. Architecture options and comparison

| Criterion | Supabase Postgres and Auth, writes only through a Nyuma API | Custom API and any managed PostgreSQL | Browser Supabase client writing tables directly | Document store such as Firestore |
|---|---|---|---|---|
| Server-side authorization | API checks every request. RLS denies browser writes. | API checks every request. Database role is not exposed to the browser. | RLS must be perfect. A weak policy exposes rows. Easy to get wrong for notes and prices. | Security rules are separate from the current TypeScript rules and easy to drift. |
| Fit with this React app | SPA keeps `CoordinationRepository`. One HTTP implementation. | Same HTTP implementation. | Components would start calling a vendor client. That couples the UI to Supabase. | Would replace the document invariants with a different model. |
| Relational integrity | Foreign keys, checks, and transactions. | Same. | Transactions for an agreement still need a Postgres function. The UI must not do the check itself. | Multi-record quantity rules are awkward and not what this domain already is. |
| Concurrent users | `SELECT … FOR UPDATE` in the API transaction. | Same. | Only if every write is a locked database function. | Not a natural fit for “two agreements on one remaining quantity”. |
| Cost and operations for about 20 users | One managed database and auth bill. API is a small Node service. | Database bill plus host plus our own password and recovery implementation if auth is hand-built. | Lowest build cost, highest risk of a leaked key or a missed policy. | Low setup cost, poor fit, and a later migration. |
| Maintainability | Domain rules stay in the existing TypeScript files and run on the server. | Same, with more identity code to own. | Two copies of the rules: SQL policies and TypeScript. | A third model beside `records.ts`. |
| Backup and recovery | Managed backups on a paid plan, plus our own dumps. | Same, from whichever host is chosen. | Same database, but accidental client writes are harder to reason about. | Vendor export, not row-level relational restore. |
| Later WhatsApp | A webhook on the API creates the same records. | Same. | A bot would also need the service role. That key must not sit in the bot and the browser. | Same coupling problem. |
| Lock-in | Schema is ordinary Postgres. The SPA depends on our HTTP API, not on `@supabase/supabase-js` inside screens. Auth can be replaced later if the API is the only verifier. | Least vendor coupling. More to operate before the pilot. | High. Screens, policies, and auth are all Supabase-shaped. | High, and the data model would have moved. |

Firestore, and any document database, is not suitable. The current rules are foreign keys, shared quantities, and status transitions across five collections.

A browser-only Supabase client is not suitable either. The dangerous writes are agreements, purchases, and outcomes. Those need a locked transaction and the existing TypeScript checks. Putting the service-role key in the SPA would bypass every policy.

A fully custom identity system is a credible alternative, not the primary choice. It would duplicate registration, hashing, recovery, and session rotation before any trader is sharing a listing. The pilot does not need that extra system if the API still owns authorization.

## 4. Recommended architecture and rationale

### What runs where

```text
Android browser
  React SPA
  HttpCoordinationRepository implements CoordinationRepository
        |
        | HTTPS, bearer session, idempotency key on creates
        v
Nyuma API (Node, TypeScript)
  verifies the identity token
  rejects the role or the owner
  calls agreementBlock, remaining quantities, outcomeBlock, validateRecords
  does not reimplement matchListingToDemand
        |
        | one database role, not used by the browser
        v
PostgreSQL, hosted by Supabase
  tables, foreign keys, checks
  RLS: anon and authenticated roles have no write on coordination tables
  API role is the writer
```

Supabase Auth stores the password hash, issues the session, expires it, and sends the recovery message. The Nyuma API is what decides whether that person may change a listing or record a purchase. A request that skips React is still rejected by the API. A request that skips the API and uses the public Supabase key cannot write coordination rows if RLS is deny-by-default.

Matching stays `matchListingToDemand`. The API may run it when a client asks for suggestions. It returns suggestions. It does not insert a commitment. The SPA’s trader Matches screen should call that API, or call the same function on data the API has already filtered. It must not grow a second algorithm.

### Why this fits Nyuma

- The domain is already relational and already expressed in TypeScript. The API can import those modules. SQL should not become a second surplus or matching engine.
- About 20 traders do not justify a large platform team. Managed Postgres and managed passwords remove backup and hashing work. A small API remains small because the rules already exist.
- Commercial prices and outcome notes need a server that can say no. The current `localStorage` document cannot do that.
- WhatsApp can later call the same API. It should not have its own copy of the agreement rules.
- The SPA already depends on `CoordinationRepository`. A second implementation can sit beside `createLocalCoordinationRepository` until the pilot cutover. The local demo and sample accounts can remain for the practice build.

### Trade-offs

- Supabase regions are not in Kenya. **Assumption:** the nearest available region will add latency on a mobile network. The API should stay small and the screens should keep local form state so a slow reply does not wipe what the trader typed. Measure from a Kenyan network before the pilot, and move region if the product allows it.
- The team must run one Node service, not only a hosted database. That is deliberate. Edge functions that reimplement the rules in SQL would create a second source of truth.
- Supabase Auth is a dependency. Mitigation: the SPA never talks to coordination tables, and the API accepts a verified user id. Replacing Auth later does not require rewriting `Listing` or `Commitment`.
- A free database tier is not enough for real trader data. **Recommendation:** use a paid plan with backups before any real account is created. Confirm the current Supabase backup terms at implementation time rather than assuming a retention period here.
- Row Level Security can be misconfigured. Treat a failing authorization test as a release blocker. RLS is the second lock, not the first.

### What validates a write

1. The API authenticates the token.
2. The API checks role and ownership using the same party rules as `commitmentParty`, `authorizeAction`, and `authorizeOwnRecord`.
3. The API runs the existing parsers and the workflow checks that the screens already use, including the demand remaining quantity and `outcomeBlock`.
4. PostgreSQL commits the row only if foreign keys and checks pass, and only while the listing and requirement rows needed for that write are locked.

A failure returns a `DomainResult` error code the SPA already understands: `invalid`, `not-found`, `conflict`, `relationship`, plus HTTP 401 or 403 when the caller is not allowed to attempt the action.

## 5. Proposed data model and relationships

New identity tables are required. They do not exist in `src/domain/records.ts`. Coordination tables follow those types and do not merge them.

### Identity

`users`

- `id` UUID, primary key. This becomes `ownerId` and `buyerId`. It is not the sample id `sample-trader`.
- `auth_user_id` UUID, unique, the Supabase Auth user.
- `role` text, check constraint: `farmer`, `trader`, `buyer`, `administrator`.
- `status` text, check constraint: `active`, `suspended`, `deactivated`.
- `created_at`, `updated_at`.

`profiles`

- `user_id` primary key, foreign key to `users`.
- `display_name`.
- `phone` nullable. Stored for a later WhatsApp opt-in. It is not copied onto a listing.
- Consent timestamps for terms and, separately, for any future messaging. Both nullable until the person agrees.

One person has one role in this design, because that is the current model. A farmer who also trades would need a second account until a later product decision. That limitation is recorded in section 11.

### Coordination

`listings` matches `Listing`: `id`, `owner_id`, `commodity`, `quantity`, `quantity_unit`, `quantity_kind`, `location`, `availability_window`, `asking_price_ksh_per_kg` nullable, `status`, `created_at`, `updated_at`.

`buyer_demands` matches `BuyerDemand`: `id`, `buyer_id`, `commodity`, `requested_quantity`, `quantity_unit`, `preferred_location`, `collection_window`, `indicative_price_ksh_per_kg` nullable, `status`, `created_at`, `updated_at`.

`commitments` matches `Commitment`. `created_at` remains the agreement time. There is still no initiator column.

`purchases` matches `Purchase`. `listing_id` is stored but must equal the commitment’s listing. The API sets it from the commitment, as `recordPurchaseRecord` does today. The database foreign key and a check against the commitment make a mismatched listing fail.

`outcomes` matches `Outcome`, including nullable `commitment_id`, nullable `purchase_id`, and `notes`.

`import_batches` is only for an explicit migration tool: `id`, `created_by`, `created_at`, `source_hash` unique, `record_count`. Coordination rows created by that tool carry `origin` = `demonstration-import` and `import_batch_id`. Live rows use `origin` = `live`. Dashboards and pilot totals include `live` only unless an administrator opens the import batch on purpose.

### Relationships

- A listing belongs to one user. A requirement belongs to one user.
- A commitment belongs to one listing and one requirement.
- A purchase belongs to one commitment.
- An outcome belongs to one listing. It may point at one commitment and one purchase. A purchase link requires category `sold`.
- No table stores a match, an exposed quantity, or an unaccounted quantity.

`quantity_kind = expected` remains “not ready for collection”. Open `available` listings are the only rows that can contribute to still exposed. That calculation stays in `listingExposure`.

### What the database rejects

- Missing parent rows.
- A commodity or unit mismatch between a commitment and its listing or requirement.
- A non-positive quantity, or a non-positive price where the current validators require one.
- A status outside the existing unions.
- A listing or requirement update that changes `owner_id`, `buyer_id`, `commodity`, or `quantity_unit`.
- Duplicate primary keys.
- A purchase whose `listing_id` is not the commitment’s listing.
- An outcome linked to a purchase whose listing or commitment does not match, or whose category is not `sold`.

### What the API transaction rejects, using the current TypeScript rules

These are not re-derived in SQL:

- Collection window incompatibility (`isTimeCompatible`).
- The sum of holds on a listing, and the sum of holds on a requirement. This closes the gap where the repository checks each commitment only against the full requested quantity.
- A purchase above the remaining agreed quantity, or a purchase against a commitment that is not `confirmed`.
- Outcome overlap from `outcomeBlock`, which is stricter than `checkDocumentInvariants`.
- A listing quantity edited below held quantity or below recorded outcomes.
- Cancelling a commitment that has a purchase.
- Illegal status transitions in `COMMITMENT_TRANSITIONS`.

### Transactions and locks

These operations lock the parent rows with `SELECT … FOR UPDATE`, then re-read quantities inside the same transaction:

| Operation | Rows locked | Why |
|---|---|---|
| Record or confirm a commitment | Listing and requirement | Two people must not commit the same remaining kilograms. |
| Cancel a commitment | Commitment and its purchases | A purchase must not land while the cancel commits. |
| Record a purchase | Commitment | Two purchase reports must not exceed the agreed quantity. |
| Record an outcome | Listing, and the purchase if linked | Overlap and listing caps must see concurrent writes. |
| Reduce a listing quantity, or close it | Listing and its commitments | The new quantity cannot fall below what is already held or purchased. |
| Reduce a requirement quantity | Requirement and its commitments | The new quantity cannot fall below what is already held. |

Creating a draft listing or an open requirement needs an ordinary insert transaction. It does not lock anyone else’s row.

Ids should be UUIDs generated by the database or the API, not guesses of `listing-1`. The client may send an idempotency key. The unique key is `(user_id, idempotency_key)` on create operations, so a retried mobile request does not create a second agreement.

## 6. Authentication and authorization design

### Accounts

- Registration collects email, password, display name, and role. Phone is optional and is not a login name in the first shared release.
- Supabase Auth hashes the password. Nyuma never stores or logs it. The sample passwords in `src/lib/sampleUsers.ts` are not migrated.
- Login returns a short-lived access token and a refresh token. The SPA sends the access token to the Nyuma API. Recommended storage is an httpOnly secure cookie set by the API if the deployment can share a site, otherwise memory plus a refresh cookie. **Do not put the token in `localStorage`.** The current session key shows why: anything in that store is readable by script on the page.
- Logout revokes the refresh token and clears the cookie.
- Access tokens expire on the order of one hour. Refresh tokens rotate. A suspended or deactivated user fails the next API call even if the access token has not yet expired, because the API reads `users.status`.
- Password recovery is the provider’s email flow. It does not reveal whether an email is registered beyond the provider’s normal response.
- An administrator can suspend a user. Suspension blocks writes and discovery. It does not delete historical agreements.
- Role is set at registration and stored on `users`. Changing a role is an administrator action, written to the audit log. The client cannot send a role and have it trusted.

### Access matrix

“Discoverable” means an authenticated, active user may see those fields. It does not mean they may change them. Private records return 404 to anyone who is not allowed to know they exist, so a guessed id does not confirm that a private note or a draft is there.

| Action | Farmer | Trader | Buyer | Administrator |
|---|---|---|---|---|
| Create and edit own listing | Yes | Yes | No | No |
| See own drafts, closed, and withdrawn listings | Yes | Yes | No | Yes, read-only |
| See another person’s open listing: commodity, kind, quantity, place, window, asking price, status | Yes | Yes | Yes | Yes |
| See another person’s draft | No | No | No | Yes, read-only |
| Create and edit own requirement | No | No | Yes | No |
| See open requirements: commodity, quantity, place, window, indicative price, status | Yes | Yes | Own requirements in full; other open requirements are discoverable the same way | Yes, read-only |
| See who the counterparty is | Display name only, on discoverable open records | Display name only | Display name only | Profile, including phone |
| Record an agreement on a listing they own | Yes, listing must be theirs | Yes, listing must be theirs | No | No |
| Record an agreement on a requirement they own | No | No | Yes | No |
| See an agreement | Parties only | Parties only | Parties only | Yes, read-only |
| Cancel an agreement with no purchase | Party who could record it, while status is proposed or confirmed | Same | Same | No |
| Record a purchase against a confirmed agreement | Listing owner | Listing owner | Requirement owner | No |
| See purchases and agreed prices | Parties only | Parties only | Parties only | Yes, read-only |
| Record an outcome | Own listing | Own listing | No | No |
| See outcome notes and spoiled, donated, or disposed quantities | Own listings | Own listings | No | Yes, read-only |
| See a sold outcome linked to their own purchase, without notes | No, unless they are the listing owner | No, unless they are the listing owner | Yes, matching today’s `outcomesForBuyer` | Yes |
| Read practice scenario | Local browser only | Local browser only | No | No |
| Change another user’s row | No | No | No | No |

A potential match is computed for the caller from discoverable open rows. It is not stored and it is not an agreement.

An unauthorized API call does not use React. The API returns 401 when the token is missing or expired, 403 when the role cannot perform the action, and 404 when the row exists but is not visible to that caller. The body is a short message. It does not include another user’s notes, phone, or price.

Administrator reads use the API’s admin checks, not a browser role that can select every table. The administrator token is still an ordinary user token with `role = administrator`. There is no shared administrator password.

## 7. API and repository design

### Repository transition

Keep the interface in `src/domain/coordinationRepository.ts`. Add a later implementation, `createHttpCoordinationRepository(config)`, which calls the API and returns `DomainResult`. `createLocalCoordinationRepository` stays for the demo and the unit tests.

The HTTP implementation is the only backend-specific code in the SPA. Screens keep calling `useCoordination` and the workflow functions. Those workflow functions should pass the signed-in user as they do now, but the server must repeat the checks. The client checks are for a clear message. They are not the control.

Do not import a Supabase data client into `ListingManager`, `AgreementDesk`, `SurplusDesk`, or `OutcomeDesk`.

Matching methods can be added beside the repository, not inside the surplus math:

- `suggestMatches(listingId)` runs `matchListingToDemand` on the server for one open listing the caller is allowed to see, against open requirements the caller is allowed to see.
- If the adapter returns a failure, the API returns that message. It does not fill in a quantity.

The practice scenario continues to use `src/lib/scenarioStorage.ts` and `evaluateScenario`. It is not an API resource in the first shared release.

### Operations

Errors below are the domain codes plus 401 and 403. Validation means the existing parsers and the workflow checks named in section 5.

| Operation | Who | Validation | Rows visible | Returns | Errors |
|---|---|---|---|---|---|
| `POST /listings` | Farmer, trader | `parseListingDraft`, owner from the token, not the body | Own new row | `Listing` | 401, 403, `invalid` |
| `PATCH /listings/:id` | Owner | Patch keys only. Commodity, owner, and unit unchanged. Quantity cannot fall below holds or outcomes. | Own row | `Listing` | 401, 403, 404, `conflict`, `relationship` |
| `GET /listings` | Any active user | Filter: own rows, plus open rows for discovery. Drafts of others omitted. | Those rows, without notes | `Listing[]` | 401 |
| `POST /demands` | Buyer | `parseBuyerDemandDraft`, buyer from the token | Own new row | `BuyerDemand` | 401, 403, `invalid` |
| `PATCH /demands/:id` | Owner | Commodity and buyer unchanged. Quantity cannot fall below holds. | Own row | `BuyerDemand` | 401, 403, 404, `relationship` |
| `GET /demands` | Any active user | Own rows, plus open rows. | Discoverable fields and display name | `BuyerDemand[]` | 401 |
| `POST /commitments` | Listing owner or requirement owner, not both invented | Open listing and requirement, `agreementBlock`, remaining listing and remaining demand, idempotency key | Party | `Commitment` with status sent by the client only if it is `confirmed` or `proposed` and the parser allows it. Default remains `confirmed`, matching the form. | 401, 403, 404, `relationship`, `conflict` |
| `PATCH /commitments/:id` | Same party | Status transition only, as `CommitmentPatch` | Party | `Commitment` | 401, 403, 404, `conflict`, `relationship` |
| `GET /commitments` | Party or administrator | Administrator read-only | Own agreements, or all for admin | `Commitment[]` | 401, 403 |
| `POST /purchases` | Same party as the agreement | Commitment `confirmed`, listing id taken from the commitment, remaining quantity, idempotency key | Party | `Purchase` | 401, 403, 404, `relationship` |
| `GET /purchases` | Party or administrator | No body | Own purchases, or all for admin | `Purchase[]` | 401, 403 |
| `POST /outcomes` | Listing owner, farmer or trader | `outcomeBlock`, idempotency key. Does not create a purchase or change the listing quantity. | Owner | `Outcome` | 401, 403, 404, `relationship`, `conflict` |
| `GET /outcomes` | Owner, or buyer for linked sold outcomes only, or administrator | Buyer query strips notes and non-linked rows | Those rows | `Outcome[]` | 401, 403 |
| `GET /dashboard` | Signed-in user | Reuses `summarizeTrader` inputs for a trader, and the existing farmer and buyer helpers. Does not invent a new total. | Caller scope | Counts and kilograms the overview already shows | 401 |
| `GET /listings/:id/matches` | Owner of an open listing, or a buyer viewing their open requirement’s compatible listings | `matchListingToDemand` or `agreementBlock`. No insert. | Suggestion | `ListingMatch` or the adapter’s error message | 401, 403, 404, `invalid` |

Discovery payloads omit phone, outcome notes, agreed prices, and purchase rows. A person who needs those is a party or an administrator and uses the party endpoints.

## 8. LocalStorage migration strategy

### What is imported

**Recommendation:** do not import `nyuma.coordination.v1` automatically, and do not import it in the normal registration flow.

Those rows were created by sample accounts on one browser. They are demonstration activity. The current farmer watermelon listing, trader mango listing, requirement, agreements, and purchases in a developer browser are not the Kitui pilot.

The practice key `nyuma.decisionSupport.scenario.v1` is never imported. Reset and Load saved stay local. A saved mango scenario and the default 800 kg watermelon scenario both remain practice data.

### If a facilitator deliberately imports a prototype file

This is an administrator tool, off by default.

1. The facilitator downloads the JSON from the browser. That file is the backup. The tool does not delete or rewrite `localStorage`.
2. The API parses it with `parseCoordinationDocument`. Invalid JSON, an unknown version, or a failed invariant check rejects the whole file. Nothing is partially written.
3. The tool shows every row and asks for a real user for each `ownerId` and `buyerId`. Sample ids (`sample-farmer`, `sample-trader`, `sample-buyer`, `sample-administrator`) cannot be mapped to a live user without that explicit choice. They are never mapped to a new user silently.
4. The batch is stored with `origin = demonstration-import`. Dashboards, exposure totals, and pilot reports exclude that origin.
5. `source_hash` is unique. Sending the same file again returns the existing batch and does not insert a second copy.
6. The transaction is the whole batch. A failure rolls it back.
7. The success screen lists imported ids and states that they are demonstration data, not market activity.

Live users creating a listing after registration get `origin = live`. The UI can show a small “Imported demonstration” mark on the other rows so nobody quotes them as a sale.

### What users are told

Registration does not say “we found records on this phone”. If the phone has old prototype data, it stays on the phone until a person exports it. After cutover, the SPA’s shared mode stops reading `nyuma.coordination.v1` for the dashboard. It does not erase it.

## 9. Security and operational safeguards

Minimum before a real trader is invited:

- All coordination writes and reads go through the API over HTTPS.
- Server-side validation uses the existing parsers. The client is not trusted for owner, role, listing id on a purchase, or quantity.
- The database password and the Auth secret live in the host’s environment, not in Vite `import.meta.env` shipped to the browser. The SPA receives only the public Auth URL and the public anon key if Auth requires it, and that anon key cannot write coordination tables.
- PostgreSQL accepts connections from the API host, not from the public internet at large.
- List endpoints are filtered in the query. They do not fetch every row and hide some in React.
- Private ids that the caller cannot see return 404.
- Audit log table: actor, action, record type, record id, time, and result. Do not copy outcome notes or passwords into the log.
- Errors returned to the client are the short domain messages. Stack traces and SQL stay in server logs.
- Daily managed backups plus a weekly logical dump stored outside Supabase. Restore is rehearsed once before the pilot.
- Deactivation blocks login and discovery. Rows remain for the other party’s agreement history.
- A simple health check, error count, and failed-login count are enough monitoring for 20 users.
- Terms shown at registration: what is stored, who can see an open listing, and that outcome notes are private. This is a product and legal step, not a database feature. Kenya’s Data Protection Act is relevant because prices, supply, and phone numbers can identify a person’s business. **This proposal is not legal advice.** Where the database region sits, and whether a registration or a cross-border transfer step is required, has to be confirmed before real data is stored.

Commercially sensitive data in this product includes available kilograms, asking and agreed prices, who is buying, and what spoiled. Open listings and open requirements are visible to other signed-in users because coordination requires that. Agreements, purchases, and outcome notes are not a public market board. A bug that treats `listCommitments()` like today’s repository, returning every row to every caller, would publish that business.

## 10. Phased implementation roadmap

WhatsApp is not in these stages. It waits until the API and the shared tables are in use.

### Stage 1. API project and schema

- Scope: Node TypeScript service, Postgres schema, migrations, RLS deny-by-default, API database role, health check. No UI cutover.
- Likely additions: a new server directory, SQL migrations, a test database. `src/domain` is imported, not rewritten.
- Depends on: an approved host and region.
- Tests: schema rejects a commodity mismatch, a bad status, and a purchase on the wrong listing. Anon role cannot insert.
- Acceptance: empty database, migrations reversible, no change to the SPA’s local demo.
- Rollback: drop the unused database. The SPA still uses `localStorage`.

### Stage 2. Authentication

- Scope: Supabase Auth, `users` and `profiles`, registration, login, logout, expiry, recovery, suspend.
- Likely changes later: `src/lib/auth.ts` consumers, `LoginScreen.tsx`. Sample accounts remain for the local build.
- Depends on: stage 1.
- Tests: wrong password, expired token, suspended user, recovery does not leave a session in `localStorage`.
- Acceptance: a real user can sign in and call a health or profile endpoint. They cannot read coordination rows yet.
- Rollback: disable registration. Sample demo unchanged.

### Stage 3. Roles and ownership

- Scope: API guards for the four roles. 401, 403, and 404 behaviour. Audit log on denied and successful writes.
- Depends on: stage 2.
- Tests: each cell of the access matrix, including a direct HTTP call that skips the SPA. Buyer cannot read another buyer’s notes. Administrator cannot post a listing.
- Acceptance: the matrix in section 6 passes against the API.
- Rollback: feature flag the API routes off.

### Stage 4. Listings and requirements

- Scope: shared create, update, and discovery. Commodity immutable. Expected harvest stored as `quantity_kind`, not as available.
- Likely later SPA changes: `ListingManager.tsx`, `DemandManager.tsx`, `useCoordination.ts`, the HTTP repository.
- Depends on: stage 3.
- Tests: owner edit, stranger’s draft hidden, two open listings visible, quantity edit below existing holds rejected when holds exist.
- Acceptance: two browsers, two users, see each other’s open rows and not each other’s drafts.
- Rollback: point the SPA back at `createLocalCoordinationRepository`.

### Stage 5. Matches and commitments

- Scope: suggestion endpoint using `matchListingToDemand` with no insert. Commitment create and cancel in a locked transaction, including the summed demand remaining check and `agreementBlock`.
- Likely later SPA changes: `TraderCoordination.tsx`, `AgreementDesk.tsx`, `src/lib/traderRecords.ts` only as a caller.
- Depends on: stage 4. Domain files stay the source of the rules.
- Tests: incompatible produce and window, partial remaining quantity, two concurrent commitments on one listing, no row created by the match endpoint, sample scenario still local.
- Acceptance: the loser of a race gets `relationship` and the listing is not over-committed.
- Rollback: disable commitment routes. Listings remain.

### Stage 6. Purchases, outcomes, and accounting

- Scope: purchase and outcome writes. Totals still computed by `surplus.ts` and `outcomeAccounting.ts` on the server for dashboard responses. No stored exposed or unaccounted column.
- Likely later SPA changes: `AgreementDesk.tsx`, `OutcomeDesk.tsx`, `SurplusDesk.tsx`.
- Depends on: stage 5.
- Tests: purchase only on `confirmed`, no double count, outcome overlap rejected, expected harvest still has null exposed, buyer does not receive notes.
- Acceptance: the current surplus and outcome tests pass against rows loaded from the API, with the same numbers.
- Rollback: disable those routes. Do not delete committed rows.

### Stage 7. Dashboards and migration

- Scope: role overviews read the API. Optional import tool with `origin` and `source_hash`. Practice scenario untouched.
- Likely later SPA changes: `TraderWorkspace.tsx`, `FarmerWorkspace.tsx`, `BuyerWorkspace.tsx`, `AdminWorkspace.tsx`.
- Depends on: stage 6.
- Tests: empty account has no fictional 800 kg, imported rows do not appear in live totals, second import is a no-op, `localStorage` still present after a failed import.
- Acceptance: a trader with no server rows sees the empty state. A trader with live rows sees those rows. The practice page still shows the default watermelon result when opened fresh.
- Rollback: SPA feature flag returns to local storage for coordination. Server data is left in place.

### Stage 8. Security test and pilot

- Scope: restore drill, phone-network pass, access-matrix regression, confirmation that sample accounts are absent from production Auth.
- Depends on: stage 7 and a paid backup plan.
- Tests: the matrix again, plus a restore onto a scratch database.
- Acceptance: a written go or no-go. Real users only after go.
- Rollback: suspend registration and keep the last dump.

## 11. Risks, trade-offs, and unresolved decisions

- **Region and latency.** The database may sit outside Kenya. Unresolved until a region is chosen and timed from a Kenyan phone.
- **Legal basis and hosting.** Unresolved with a qualified adviser before real names, phones, and prices are stored. This document does not settle it.
- **One role per account.** Matches the code. Unresolved whether one person may be both a farmer and a trader without two logins.
- **How much of an open requirement is public.** This proposal shows commodity, quantity, place, window, indicative price, and display name to other signed-in users, because today’s farmer and trader screens already show open requirements in the browser. A pilot may want the buyer’s name hidden until an agreement. That is a product choice, not a schema change, if the API can omit the display name.
- **Phone login.** Deferred. Email matches the current login form. WhatsApp will need a consented phone later.
- **Correcting a mistaken purchase or outcome.** The current model has no update or delete. This proposal stays append-only. A void or correction flow is a later product decision and must not be improvised as a silent edit.
- **Marking an agreement fulfilled.** The status exists and the UI never sets it. The API allows the existing transition. Whether the pilot UI exposes it is a product choice.
- **Supabase Auth lock-in.** Accepted for the pilot because the API is the authorization boundary. Revisit if the identity provider becomes a constraint.
- **Duplicating rules in SQL.** Rejected, except for foreign keys and simple checks. The remaining risk is that a future change updates `outcomeBlock` and forgets the API caller. The stage 6 tests are the guard.
- **Importing a developer browser by mistake.** Mitigated by leaving import off and excluding `demonstration-import` from totals. Residual risk if someone maps sample ids onto real traders without looking. The tool must require a confirmation per id.

## 12. What must not change during implementation

- `src/lib/decisionEngine.ts`, including `isTimeCompatible` and the 800 kg scenario result.
- The allocation behaviour of `matchListingToDemand`. It may be called from the server. It may not be rewritten in SQL or in a React component.
- The surplus definition in `src/lib/surplus.ts` and the outcome definition in `src/lib/outcomeAccounting.ts`. Dashboard numbers must call them, not a new formula.
- The meanings in `src/domain/records.ts`: match is not a commitment, commitment is not a purchase, purchase is not an outcome, expected is not available, a requirement is not an order, unaccounted is not spoilage.
- `nyuma.coordination.v1` and `nyuma.decisionSupport.scenario.v1` on existing phones. Implementation must not delete or overwrite them as a side effect of login.
- Sample accounts in the local demo, until a separate decision removes the demo. They are not production users.
- Farmer, buyer, and administrator workflows. A shared backend filters rows. It does not give the administrator write actions the prototype withholds.
- Location is still not a transport price and not an eligibility rule.

## Completion note

Files inspected for this proposal include `package.json`, `package-lock.json`, `vite.config.ts`, `tsconfig.json`, `src/main.tsx`, `src/App.tsx`, `src/lib/auth.ts`, `src/lib/sampleUsers.ts`, `src/lib/access.ts`, `src/domain/records.ts`, `src/domain/result.ts`, `src/domain/relationships.ts`, `src/domain/coordinationDocument.ts`, `src/domain/coordinationRepository.ts`, `src/lib/coordinationClient.ts`, `src/lib/coordinationWorkflow.ts`, `src/lib/coordinationActivity.ts`, `src/lib/surplus.ts`, `src/lib/outcomeAccounting.ts`, `src/domain/matchListing.ts`, `src/lib/scenarioStorage.ts`, `src/lib/traderRecords.ts`, the workspace and coordination screens those modules feed, `docs/NYUMA_PILOT_READINESS_AUDIT.md`, and a search for environment files, service workers, and network clients. No application source, dependency, environment file, storage key, or stored record was changed. The only file added is this document.
