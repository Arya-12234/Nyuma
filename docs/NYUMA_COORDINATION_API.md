# Nyuma coordination API

Date: 5 November 2026. Authenticated accounts store produce listings, buyer requirements, agreements, purchases, and outcomes through this API. An authenticated workspace uses these routes. The sample workspace does not.

No live Supabase project was called. Tests sign local tokens and use the local PostgreSQL verification database through the `nyuma_app` role. They do not use a service-role key. Row level security is not implemented.

## Endpoints

All of these routes require `Authorization: Bearer <access token>`. The token is verified the same way as `GET /me`. The Nyuma account is the `users` row whose `auth_user_id` is the token `sub`. A missing, malformed, or expired token is `401` `unauthenticated`. An account that has not called `POST /me/bootstrap` is `404` `account-not-bootstrapped`. A suspended or deactivated account is `403` `account-disabled`.

The server assigns record ids. A client `id` is rejected. `origin` is always the column default `live` and cannot be sent by the client.

### Listings

| Method and path | Who can call it | Result |
|---|---|---|
| `POST /me/listings` | Active account with `farmer` or `trader` in `user_roles` | `201` `{ ok, listing }` |
| `GET /me/listings` | That account | `200` `{ ok, listings }` — every status that account owns, including drafts |
| `GET /me/listings/:id` | The owner | `200` `{ ok, listing }` |
| `PATCH /me/listings/:id` | The owner, still holding farmer or trader | `200` `{ ok, listing }` |
| `DELETE /me/listings/:id` | The owner, still holding farmer or trader | `200` `{ ok: true }` |
| `GET /market/listings` | Any active bootstrapped account | `200` `{ ok, listings }` — `status = 'open'` and `origin = 'live'` only |

Create body:

```json
{
  "commodity": "Watermelon",
  "quantity": 10.5,
  "quantityUnit": "kg",
  "quantityKind": "available",
  "location": "Kitui",
  "availabilityWindow": "3 hours",
  "askingPriceKshPerKg": 40.25,
  "status": "draft"
}
```

`commodity` is `Watermelon`, `Mango`, `Tomato`, `Banana`, or `Other`. `quantityKind` is `available` or `expected`. `location` is `Kitui`, `Nairobi`, or `Other`. `availabilityWindow` is `2 hours`, `3 hours`, `4 hours`, `Today`, or `Tomorrow`. `status` is `draft`, `open`, `closed`, or `withdrawn`. `askingPriceKshPerKg` is a number greater than zero, or `null`. Quantity allows at most 3 decimal places. Price allows at most 2. The unit must be `kg`.

A private listing is:

```json
{
  "id": "l…",
  "ownerId": "nyuma users.id",
  "commodity": "Watermelon",
  "quantity": 10.5,
  "quantityUnit": "kg",
  "quantityKind": "available",
  "location": "Kitui",
  "availabilityWindow": "3 hours",
  "askingPriceKshPerKg": 40.25,
  "status": "draft",
  "createdAt": "2026-11-05T00:00:00.000Z",
  "updatedAt": "2026-11-05T00:00:00.000Z"
}
```

`ownerId` is the Nyuma account id taken from the verified token. It is not the Supabase user id. Update accepts any subset of `quantity`, `quantityKind`, `location`, `availabilityWindow`, `askingPriceKshPerKg`, and `status`. At least one of those fields is required. Commodity, unit, owner, id, and origin cannot be changed.

Withdrawing a listing is `PATCH` with `{ "status": "withdrawn" }`. `DELETE` removes the row only when nothing references it. A commitment that still points at the listing returns `409` `relationship`, and the listing stays.

### Buyer requirements

| Method and path | Who can call it | Result |
|---|---|---|
| `POST /me/buyer-requirements` | Active account with `buyer` in `user_roles` | `201` `{ ok, requirement }` |
| `GET /me/buyer-requirements` | That account | `200` `{ ok, requirements }` — open, closed, and withdrawn rows that account owns |
| `GET /me/buyer-requirements/:id` | The owner | `200` `{ ok, requirement }` |
| `PATCH /me/buyer-requirements/:id` | The owner, still holding buyer | `200` `{ ok, requirement }` |
| `DELETE /me/buyer-requirements/:id` | The owner, still holding buyer | `200` `{ ok: true }` |
| `GET /market/requirements` | Any active bootstrapped account | `200` `{ ok, requirements }` — `status = 'open'` and `origin = 'live'` only |

Create body:

```json
{
  "commodity": "Watermelon",
  "requestedQuantity": 8,
  "quantityUnit": "kg",
  "preferredLocation": "Nairobi",
  "collectionWindow": "Today",
  "indicativePriceKshPerKg": 42,
  "status": "open"
}
```

There is no draft status. `status` is `open`, `closed`, or `withdrawn`. The same commodity, location, window, quantity, and price rules apply. Update accepts any subset of `requestedQuantity`, `preferredLocation`, `collectionWindow`, `indicativePriceKshPerKg`, and `status`.

A private requirement includes `buyerId`, which is the same Nyuma account id rule as `ownerId`. A market requirement does not include `buyerId`.

### Agreements

An agreement is a row in `commitments`. There is no public market route. A caller sees an agreement only when they are a participant: the listing owner, and that account holds `farmer` or `trader` in `user_roles`, or the requirement's buyer, and that account holds `buyer`.

| Method and path | Who can call it | Result |
|---|---|---|
| `POST /me/agreements` | A participant with `farmer`, `trader`, or `buyer` | `201` `{ ok, agreement }` |
| `GET /me/agreements` | That account | `200` `{ ok, agreements }` — every status that account participates in |
| `GET /me/agreements/:id` | A participant | `200` `{ ok, agreement }` |
| `PATCH /me/agreements/:id` | A participant still holding `farmer`, `trader`, or `buyer` | `200` `{ ok, agreement }` |

Create body:

```json
{
  "listingId": "l…",
  "buyerDemandId": "d…",
  "agreedQuantity": 6,
  "quantityUnit": "kg",
  "agreedPriceKshPerKg": 40,
  "expectedFulfilmentDate": "2026-11-06",
  "status": "confirmed"
}
```

`listingId` and `buyerDemandId` identify existing records. They are not account ids. `status` on create is `proposed` or `confirmed`. `fulfilled` and `cancelled` are reached only by a later status change. `agreedPriceKshPerKg` is required and greater than zero. The date is `YYYY-MM-DD`. The response does not include an owner id or a buyer id:

```json
{
  "id": "c…",
  "listingId": "l…",
  "buyerDemandId": "d…",
  "agreedQuantity": 6,
  "quantityUnit": "kg",
  "agreedPriceKshPerKg": 40,
  "expectedFulfilmentDate": "2026-11-06",
  "status": "confirmed",
  "createdAt": "2026-11-05T00:00:00.000Z",
  "updatedAt": "2026-11-05T00:00:00.000Z"
}
```

The caller must be the listing owner or the requirement's buyer. The other record must be open and `live`, unless the caller owns that record. A listing or requirement the caller cannot participate in is `404` `not-found`, including when the id does not exist. The database still requires both records to be open, the same commodity, the same `kg` unit, a compatible collection window, and an agreed quantity that fits the requirement and the listing. Those failures are `409` `conflict`, and the insert is rolled back.

Update body is only `{ "status": "confirmed" }`, `{ "status": "fulfilled" }`, or `{ "status": "cancelled" }`. The database allows `proposed` to become `confirmed` or `cancelled`, and `confirmed` to become `fulfilled` or `cancelled`. Any other change, including sending the current status again, is `409` `conflict`. A confirmed agreement that already has a purchase cannot be cancelled. Quantity, price, date, listing, requirement, and origin cannot be sent.

`nyuma_app` cannot `UPDATE` `commitments` directly. The status change calls `nyuma_set_commitment_status` after the participant check. Agreements cannot be deleted. Cancel one instead.

### Purchases

A purchase has no status and cannot be changed or deleted. The database trigger rejects both. There is no `PATCH` or `DELETE`.

| Method and path | Who can call it | Result |
|---|---|---|
| `POST /me/purchases` | A participant in the agreement, with `farmer`, `trader`, or `buyer` | `201` `{ ok, purchase }` |
| `GET /me/purchases` | That account | `200` `{ ok, purchases }` |
| `GET /me/purchases/:id` | A participant in the purchase's agreement | `200` `{ ok, purchase }` |

Create body:

```json
{
  "commitmentId": "c…",
  "actualQuantity": 3,
  "quantityUnit": "kg",
  "actualPriceKshPerKg": 41,
  "purchaseDate": "2026-11-06"
}
```

The listing id is copied from the agreement. A client `listingId` is `400` `invalid-request`. The agreement must be `confirmed`. The purchased quantity cannot exceed the agreed quantity. The insert calls `nyuma_insert_purchase`, which locks the listing, the requirement, and the agreement before the row is written. A failed check rolls the transaction back, so an earlier purchase on that agreement stays and the new row does not.

A purchase response is `{ id, commitmentId, listingId, actualQuantity, quantityUnit, actualPriceKshPerKg, purchaseDate, recordedAt }`.

### Outcomes

An outcome cannot be changed or deleted. There is no `PATCH` or `DELETE`.

| Method and path | Who can call it | Result |
|---|---|---|
| `POST /me/outcomes` | The listing owner, with `farmer` or `trader` | `201` `{ ok, outcome }` |
| `GET /me/outcomes` | The listing owner, or a buyer for a sold outcome linked to that buyer's purchase | `200` `{ ok, outcomes }` |
| `GET /me/outcomes/:id` | The same visibility rule | `200` `{ ok, outcome }` |

Create body:

```json
{
  "listingId": "l…",
  "category": "sold",
  "quantity": 4,
  "quantityUnit": "kg",
  "recordedDate": "2026-11-06",
  "notes": "Collected in Kitui",
  "purchaseId": null
}
```

`category` is `sold`, `recovered`, `spoiled`, `donated`, or `disposed`. `notes` is a string of at most 500 characters and may be empty. `purchaseId` is `null` except for a `sold` outcome linked to a purchase of this listing. A non-sold category with a purchase id is `400` `invalid-request`. The agreement id is copied from that purchase. A client `commitmentId` is rejected. A purchase that is not on this listing is `404` `not-found`.

The listing owner receives `notes`. A buyer who can see the sold outcome receives `notes: null`. A buyer does not receive recovered, spoiled, donated, or disposed rows. An identical outcome for the same listing, category, quantity, date, purchase, agreement, and notes is `409` `conflict`. Quantity that would exceed the listing, or sold quantity that would exceed the purchase, is `409` `conflict` and is rolled back.

There is no market route for agreements, purchases, or outcomes.

## Ownership and market visibility

The handler never reads an owner, buyer, user, or auth id from the body or the query string. Those keys, and any other unknown key, are `400` `invalid-request`. The account id passed into SQL is `users.id` for the verified `sub`.

Every private listing or requirement read, update, and delete includes `owner_id = $account` or `buyer_id = $account` in the SQL. Agreement, purchase, and outcome reads include the participant predicate in the SQL. A known id that the caller cannot access is `404` `not-found`, the same response as an id that does not exist. Listing and requirement updates do not call `nyuma_lock_listing` or `nyuma_lock_demand`, because those functions lock by id alone and would distinguish “exists” from “missing”. The statement locks the owned row with `FOR UPDATE` only after the owner predicate matches. Agreement status changes call `nyuma_set_commitment_status` only after the participant predicate matches. That function locks the listing, then the requirement, then the agreement.

Writes also call `nyuma_lock_user` for that same account and then read `user_roles`. A listing or outcome requires `farmer` or `trader`. A requirement requires `buyer`. An agreement or purchase requires `farmer`, `trader`, or `buyer`, and the participant predicate still has to match. This follows `user_roles`, not the selected workspace. A missing role is `403` `role-not-granted`. An account that has a role but is not a participant receives `404` `not-found`.

Market queries select only coordination fields. They do not select `owner_id`, `buyer_id`, timestamps, or `origin`. They filter `status = 'open' AND origin = 'live'`. Draft, closed, withdrawn, and `demonstration-import` rows are absent. An open expected listing is included, with `quantityKind: "expected"`, so a client can tell it is not produce on hand. Query-string filters are ignored.

A quantity change that would fall below kilograms already held by a commitment is `409` `conflict`. The previous row is unchanged. Invalid JSON, extra decimal places, and values outside the database checks are `400` `invalid-request` and are rejected before the update.

## Tables

No new migration. The routes use `listings`, `buyer_demands`, `commitments`, `purchases`, and `outcomes` from `001_foundation.sql`, `users` and `user_roles` from the identity migrations, `nyuma_lock_user`, `nyuma_set_commitment_status`, and `nyuma_insert_purchase`. Inserts omit `origin`, so the default `live` applies. Existing triggers still reject an owner change, a commodity change, a listing without farmer or trader, a requirement without buyer, an agreement field other than status, a purchase or outcome update or delete, and a quantity that breaks a hold. `nyuma_app` still has no `UPDATE` on `commitments`. Database permissions were not broadened. Row level security is still absent, so a stolen application database password can read every row. The HTTP routes do not.

## Tests

`server/tests/coordination.input.test.ts` checks rejected owner fields, decimal limits, and rejected agreement, purchase, and outcome fields without a database.

`server/tests/coordination.integration.test.ts` uses PostgreSQL. It creates two traders, two buyers, and an account with no role. It covers create, own read, cross-account read, update, and delete, `404` versus `401`, role rejection, a client owner id, market filtering, buyer privacy, invalid input, and a commitment that blocks deletion. It does not call Supabase.

`server/tests/activity.integration.test.ts` uses PostgreSQL with a farmer, a trader, two buyers, and an account with no role. It covers agreement, purchase, and outcome creation and retrieval, participant access, another account's records, role rejection, counterparty fields, invalid status changes, a missing linked record, a suspended account, a missing or expired token, and rollback when a purchase or cancellation fails. It does not call Supabase.

## Not supported by the current schema

Purchases have no status and cannot be updated or deleted. Outcomes cannot be updated or deleted. Agreements cannot be deleted, and only `status` can change. Creating an agreement as `fulfilled` or `cancelled` is rejected because those values are transition targets, not create values. There is no public market view of agreements, purchases, or outcomes. An authenticated workspace reads and writes agreements, purchases, and outcomes through these routes. Purchases and outcomes cannot be edited or deleted from that workspace. The sample workspace still uses `nyuma.coordination.v1`. These routes do not read or write that key.
