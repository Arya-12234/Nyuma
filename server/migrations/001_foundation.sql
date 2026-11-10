-- Nyuma coordination foundation.
-- PostgreSQL 14 or newer. Local databases only. This file seeds no accounts and no produce records.
--
-- Quantity and window checks below are database backstops of the existing TypeScript rules:
--   src/lib/decisionEngine.ts isTimeCompatible
--   src/lib/coordinationActivity.ts held quantity
--   src/domain/relationships.ts purchase, commitment, and per-record outcome caps
--   src/lib/outcomeAccounting.ts accounted kilograms
-- Accounted kilograms reject a purchase that would count kilograms an existing outcome already covers.
-- checkDocumentInvariants does not apply that sum when a purchase is saved. The repository was not changed.
-- Administrator membership is a database role, nyuma_provisioner, not a session setting.
-- They are not a second matching engine. Surplus, exposure, and match ranking stay in TypeScript.
-- WINDOW_LIMIT_HOURS: "2 hours" = 2, "3 hours" = 3, "4 hours" = 4, Today = 18, Tomorrow = 36.

DO $do$
BEGIN
  IF current_setting('server_version_num')::int < 140000 THEN
    RAISE EXCEPTION 'Nyuma requires PostgreSQL 14 or newer.';
  END IF;
END
$do$;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id uuid UNIQUE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deactivated')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE profiles (
  user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE RESTRICT,
  display_name text NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 120),
  phone text CHECK (phone IS NULL OR (char_length(btrim(phone)) BETWEEN 1 AND 32)),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_roles (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('farmer', 'trader', 'buyer', 'administrator')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role)
);

CREATE TABLE coordination_ids (
  id text PRIMARY KEY,
  collection text NOT NULL CHECK (collection IN ('listings', 'buyer_demands', 'commitments', 'purchases', 'outcomes')),
  CONSTRAINT coordination_ids_format CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$')
);

CREATE TABLE listings (
  id text PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  commodity text NOT NULL CHECK (commodity IN ('Watermelon', 'Mango', 'Tomato', 'Banana', 'Other')),
  quantity numeric(14, 3) NOT NULL CHECK (quantity > 0),
  quantity_unit text NOT NULL CHECK (quantity_unit = 'kg'),
  quantity_kind text NOT NULL CHECK (quantity_kind IN ('available', 'expected')),
  location text NOT NULL CHECK (location IN ('Kitui', 'Nairobi', 'Other')),
  availability_window text NOT NULL CHECK (availability_window IN ('2 hours', '3 hours', '4 hours', 'Today', 'Tomorrow')),
  asking_price_ksh_per_kg numeric(14, 2) CHECK (asking_price_ksh_per_kg IS NULL OR asking_price_ksh_per_kg > 0),
  status text NOT NULL CHECK (status IN ('draft', 'open', 'closed', 'withdrawn')),
  origin text NOT NULL DEFAULT 'live' CHECK (origin IN ('live', 'demonstration-import')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT listings_id_format CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$')
);

CREATE TABLE buyer_demands (
  id text PRIMARY KEY,
  buyer_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  commodity text NOT NULL CHECK (commodity IN ('Watermelon', 'Mango', 'Tomato', 'Banana', 'Other')),
  requested_quantity numeric(14, 3) NOT NULL CHECK (requested_quantity > 0),
  quantity_unit text NOT NULL CHECK (quantity_unit = 'kg'),
  preferred_location text NOT NULL CHECK (preferred_location IN ('Kitui', 'Nairobi', 'Other')),
  collection_window text NOT NULL CHECK (collection_window IN ('2 hours', '3 hours', '4 hours', 'Today', 'Tomorrow')),
  indicative_price_ksh_per_kg numeric(14, 2) CHECK (indicative_price_ksh_per_kg IS NULL OR indicative_price_ksh_per_kg > 0),
  status text NOT NULL CHECK (status IN ('open', 'closed', 'withdrawn')),
  origin text NOT NULL DEFAULT 'live' CHECK (origin IN ('live', 'demonstration-import')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT buyer_demands_id_format CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$')
);

CREATE TABLE commitments (
  id text PRIMARY KEY,
  listing_id text NOT NULL REFERENCES listings (id) ON DELETE RESTRICT,
  buyer_demand_id text NOT NULL REFERENCES buyer_demands (id) ON DELETE RESTRICT,
  agreed_quantity numeric(14, 3) NOT NULL CHECK (agreed_quantity > 0),
  quantity_unit text NOT NULL CHECK (quantity_unit = 'kg'),
  agreed_price_ksh_per_kg numeric(14, 2) NOT NULL CHECK (agreed_price_ksh_per_kg > 0),
  expected_fulfilment_date date NOT NULL,
  status text NOT NULL CHECK (status IN ('proposed', 'confirmed', 'fulfilled', 'cancelled')),
  origin text NOT NULL DEFAULT 'live' CHECK (origin IN ('live', 'demonstration-import')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commitments_id_format CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$')
);

CREATE TABLE purchases (
  id text PRIMARY KEY,
  commitment_id text NOT NULL REFERENCES commitments (id) ON DELETE RESTRICT,
  listing_id text NOT NULL REFERENCES listings (id) ON DELETE RESTRICT,
  actual_quantity numeric(14, 3) NOT NULL CHECK (actual_quantity > 0),
  quantity_unit text NOT NULL CHECK (quantity_unit = 'kg'),
  actual_price_ksh_per_kg numeric(14, 2) NOT NULL CHECK (actual_price_ksh_per_kg > 0),
  purchase_date date NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  origin text NOT NULL DEFAULT 'live' CHECK (origin IN ('live', 'demonstration-import')),
  CONSTRAINT purchases_id_format CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$')
);

CREATE TABLE outcomes (
  id text PRIMARY KEY,
  listing_id text NOT NULL REFERENCES listings (id) ON DELETE RESTRICT,
  commitment_id text REFERENCES commitments (id) ON DELETE RESTRICT,
  purchase_id text REFERENCES purchases (id) ON DELETE RESTRICT,
  category text NOT NULL CHECK (category IN ('sold', 'recovered', 'spoiled', 'donated', 'disposed')),
  quantity numeric(14, 3) NOT NULL CHECK (quantity > 0),
  quantity_unit text NOT NULL CHECK (quantity_unit = 'kg'),
  recorded_date date NOT NULL,
  notes text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 500),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  origin text NOT NULL DEFAULT 'live' CHECK (origin IN ('live', 'demonstration-import')),
  CONSTRAINT outcomes_id_format CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  CONSTRAINT outcomes_purchase_is_sold CHECK (purchase_id IS NULL OR category = 'sold')
);

CREATE INDEX listings_owner_idx ON listings (owner_id);
CREATE INDEX listings_open_match_idx ON listings (commodity, availability_window) WHERE status = 'open';
CREATE INDEX buyer_demands_buyer_idx ON buyer_demands (buyer_id);
CREATE INDEX buyer_demands_open_match_idx ON buyer_demands (commodity, collection_window) WHERE status = 'open';
CREATE INDEX commitments_listing_idx ON commitments (listing_id);
CREATE INDEX commitments_demand_idx ON commitments (buyer_demand_id);
CREATE INDEX commitments_status_idx ON commitments (status);
CREATE INDEX purchases_commitment_idx ON purchases (commitment_id);
CREATE INDEX purchases_listing_idx ON purchases (listing_id);
CREATE INDEX outcomes_listing_idx ON outcomes (listing_id);
CREATE INDEX outcomes_commitment_idx ON outcomes (commitment_id);
CREATE INDEX outcomes_purchase_idx ON outcomes (purchase_id);
CREATE INDEX user_roles_role_idx ON user_roles (role);

COMMENT ON COLUMN listings.quantity IS
  'Kilograms stored at gram precision, numeric(14,3). PostgreSQL rounds extra fractional digits on input. The later API must reject more than 3 decimal places before writing, using the same rule as the domain quantity check.';
COMMENT ON COLUMN listings.asking_price_ksh_per_kg IS
  'Kenyan shillings per kilogram at cent precision, numeric(14,2). Null means no asking price. The later API must reject more than 2 decimal places before writing.';
COMMENT ON COLUMN listings.quantity_kind IS
  'available is produce that can be collected now. expected is a harvest that is not yet on hand. Expected quantity is not treated as available-now.';
COMMENT ON TABLE user_roles IS
  'One account may hold more than one role. Administrator is not granted by a normal insert.';

CREATE FUNCTION nyuma_grams(quantity numeric) RETURNS bigint
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT round(quantity * 1000)::bigint;
$fn$;

-- Mirrors src/lib/decisionEngine.ts isTimeCompatible. Not a matching or ranking function.
CREATE FUNCTION nyuma_is_time_compatible(seller_window text, buyer_collection text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE
    WHEN buyer_collection = 'Today' THEN true
    WHEN buyer_collection = 'Tomorrow' THEN seller_window = 'Tomorrow'
    WHEN buyer_collection = '2 hours' THEN seller_window IN ('2 hours', '3 hours', '4 hours', 'Today', 'Tomorrow')
    WHEN buyer_collection = '3 hours' THEN seller_window IN ('3 hours', '4 hours', 'Today', 'Tomorrow')
    WHEN buyer_collection = '4 hours' THEN seller_window IN ('4 hours', 'Today', 'Tomorrow')
    ELSE false
  END;
$fn$;

CREATE FUNCTION nyuma_lock_user(p_user_id uuid) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  PERFORM 1 FROM users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User % does not exist.', p_user_id USING ERRCODE = '23503';
  END IF;
END;
$fn$;

CREATE FUNCTION nyuma_lock_listing(p_listing_id text) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  PERFORM 1 FROM listings WHERE id = p_listing_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Listing % does not exist.', p_listing_id USING ERRCODE = '23503';
  END IF;
END;
$fn$;

CREATE FUNCTION nyuma_lock_demand(p_demand_id text) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  PERFORM 1 FROM buyer_demands WHERE id = p_demand_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Buyer demand % does not exist.', p_demand_id USING ERRCODE = '23503';
  END IF;
END;
$fn$;

-- Lock the listing before the buyer demand.
CREATE FUNCTION nyuma_lock_for_commitment(p_listing_id text, p_demand_id text) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  PERFORM nyuma_lock_listing(p_listing_id);
  PERFORM nyuma_lock_demand(p_demand_id);
END;
$fn$;

-- Lock the listing, then the buyer demand, then the commitment.
-- listing_id and buyer_demand_id on a commitment do not change.
CREATE FUNCTION nyuma_lock_for_purchase(p_commitment_id text) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_listing_id text;
  v_demand_id text;
BEGIN
  SELECT listing_id, buyer_demand_id INTO v_listing_id, v_demand_id
  FROM commitments
  WHERE id = p_commitment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Commitment % does not exist.', p_commitment_id USING ERRCODE = '23503';
  END IF;
  PERFORM nyuma_lock_listing(v_listing_id);
  PERFORM nyuma_lock_demand(v_demand_id);
  PERFORM 1 FROM commitments WHERE id = p_commitment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Commitment % does not exist.', p_commitment_id USING ERRCODE = '23503';
  END IF;
END;
$fn$;

-- Lock the listing before the purchase, when a purchase is linked.
CREATE FUNCTION nyuma_lock_for_outcome(p_listing_id text, p_purchase_id text) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_listing_id text;
BEGIN
  PERFORM nyuma_lock_listing(p_listing_id);
  IF p_purchase_id IS NULL THEN
    RETURN;
  END IF;
  SELECT listing_id INTO v_listing_id FROM purchases WHERE id = p_purchase_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Purchase % does not exist.', p_purchase_id USING ERRCODE = '23503';
  END IF;
  IF v_listing_id IS DISTINCT FROM p_listing_id THEN
    RAISE EXCEPTION 'That purchase is not recorded against this listing.';
  END IF;
END;
$fn$;

-- Proposed and confirmed commitments hold agreed quantity.
-- Fulfilled commitments hold purchased quantity only.
-- Cancelled commitments hold nothing.
CREATE FUNCTION nyuma_listing_held_grams(p_listing_id text) RETURNS bigint
LANGUAGE sql STABLE AS $fn$
  SELECT COALESCE(SUM(
    CASE
      WHEN c.status IN ('proposed', 'confirmed') THEN nyuma_grams(c.agreed_quantity)::numeric
      WHEN c.status = 'fulfilled' THEN (
        SELECT COALESCE(SUM(nyuma_grams(p.actual_quantity)), 0)
        FROM purchases p
        WHERE p.commitment_id = c.id
      )
      ELSE 0
    END
  ), 0)::bigint
  FROM commitments c
  WHERE c.listing_id = p_listing_id;
$fn$;

CREATE FUNCTION nyuma_demand_held_grams(p_demand_id text) RETURNS bigint
LANGUAGE sql STABLE AS $fn$
  SELECT COALESCE(SUM(
    CASE
      WHEN c.status IN ('proposed', 'confirmed') THEN nyuma_grams(c.agreed_quantity)::numeric
      WHEN c.status = 'fulfilled' THEN (
        SELECT COALESCE(SUM(nyuma_grams(p.actual_quantity)), 0)
        FROM purchases p
        WHERE p.commitment_id = c.id
      )
      ELSE 0
    END
  ), 0)::bigint
  FROM commitments c
  WHERE c.buyer_demand_id = p_demand_id;
$fn$;

CREATE FUNCTION nyuma_listing_outcome_grams(p_listing_id text) RETURNS bigint
LANGUAGE sql STABLE AS $fn$
  SELECT COALESCE(SUM(nyuma_grams(quantity)), 0)::bigint
  FROM outcomes
  WHERE listing_id = p_listing_id;
$fn$;

-- Every outcome is counted once. A purchase counts only the part that no sold
-- outcome already covers. A sold outcome linked to a purchase is not added twice.
-- This is the workflow rule in src/lib/outcomeAccounting.ts. It is stricter than
-- checkDocumentInvariants, which does not apply this sum when a purchase is saved.
-- The prototype repository was not changed in this milestone.
CREATE FUNCTION nyuma_listing_accounted_grams(p_listing_id text) RETURNS bigint
LANGUAGE sql STABLE AS $fn$
  SELECT (
    COALESCE((SELECT SUM(nyuma_grams(quantity)) FROM outcomes WHERE listing_id = p_listing_id), 0)
    + COALESCE((
      SELECT SUM(GREATEST(
        nyuma_grams(p.actual_quantity)::numeric - COALESCE((
          SELECT SUM(nyuma_grams(o.quantity))
          FROM outcomes o
          WHERE o.purchase_id = p.id AND o.category = 'sold'
        ), 0),
        0
      ))
      FROM purchases p
      WHERE p.listing_id = p_listing_id
    ), 0)
  )::bigint;
$fn$;

CREATE FUNCTION nyuma_assert_listing_quantities(p_listing_id text) RETURNS void
LANGUAGE plpgsql AS $fn$
DECLARE
  listed bigint;
  held bigint;
  outcome_grams bigint;
  accounted bigint;
BEGIN
  SELECT nyuma_grams(quantity) INTO listed FROM listings WHERE id = p_listing_id;
  held := nyuma_listing_held_grams(p_listing_id);
  outcome_grams := nyuma_listing_outcome_grams(p_listing_id);
  accounted := nyuma_listing_accounted_grams(p_listing_id);
  IF held > listed THEN
    RAISE EXCEPTION 'Promised and purchased quantity would exceed the listing quantity.';
  END IF;
  IF outcome_grams > listed THEN
    RAISE EXCEPTION 'Outcomes would exceed the listing quantity.';
  END IF;
  IF accounted > listed THEN
    RAISE EXCEPTION 'Accounted quantity would exceed the listing quantity.';
  END IF;
END;
$fn$;

CREATE FUNCTION nyuma_assert_demand_hold(p_demand_id text) RETURNS void
LANGUAGE plpgsql AS $fn$
DECLARE
  requested bigint;
  held bigint;
BEGIN
  SELECT nyuma_grams(requested_quantity) INTO requested FROM buyer_demands WHERE id = p_demand_id;
  held := nyuma_demand_held_grams(p_demand_id);
  IF held > requested THEN
    RAISE EXCEPTION 'Promised and purchased quantity would exceed the buyer requirement.';
  END IF;
END;
$fn$;

CREATE FUNCTION nyuma_assert_commitment_purchases(p_commitment_id text) RETURNS void
LANGUAGE plpgsql AS $fn$
DECLARE
  v_status text;
  agreed bigint;
  purchased bigint;
BEGIN
  SELECT status, nyuma_grams(agreed_quantity) INTO v_status, agreed
  FROM commitments
  WHERE id = p_commitment_id;
  SELECT COALESCE(SUM(nyuma_grams(actual_quantity)), 0) INTO purchased
  FROM purchases
  WHERE commitment_id = p_commitment_id;
  IF v_status = 'cancelled' AND purchased > 0 THEN
    RAISE EXCEPTION 'A cancelled commitment must not hold a purchase.';
  END IF;
  IF purchased > agreed THEN
    RAISE EXCEPTION 'Purchases would exceed the remaining agreed quantity.';
  END IF;
END;
$fn$;

CREATE FUNCTION nyuma_assert_sold_link(p_purchase_id text) RETURNS void
LANGUAGE plpgsql AS $fn$
DECLARE
  purchased bigint;
  linked bigint;
BEGIN
  SELECT nyuma_grams(actual_quantity) INTO purchased FROM purchases WHERE id = p_purchase_id;
  SELECT COALESCE(SUM(nyuma_grams(quantity)), 0) INTO linked
  FROM outcomes
  WHERE purchase_id = p_purchase_id;
  IF linked > purchased THEN
    RAISE EXCEPTION 'Sold outcomes linked to this purchase would exceed the purchased quantity.';
  END IF;
END;
$fn$;

CREATE FUNCTION nyuma_claim_coordination_id() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  INSERT INTO coordination_ids (id, collection) VALUES (NEW.id, TG_ARGV[0]);
  RETURN NEW;
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'The id % is already used by a coordination record.', NEW.id USING ERRCODE = '23505';
END;
$fn$;

CREATE FUNCTION nyuma_release_coordination_id() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  DELETE FROM coordination_ids WHERE id = OLD.id AND collection = TG_ARGV[0];
  RETURN OLD;
END;
$fn$;

CREATE FUNCTION nyuma_guard_administrator_role() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  -- Membership is a catalog privilege. A session variable cannot grant it.
  IF NEW.role = 'administrator'
     AND NOT pg_has_role(current_user, 'nyuma_provisioner', 'MEMBER') THEN
    RAISE EXCEPTION 'A user cannot grant the administrator role.';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE FUNCTION nyuma_user_roles_no_update() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'A role assignment cannot be rewritten. Remove it and add the new role.';
END;
$fn$;

CREATE FUNCTION nyuma_guard_role_removal() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM nyuma_lock_user(OLD.user_id);
  IF OLD.role = 'administrator'
     AND NOT pg_has_role(current_user, 'nyuma_provisioner', 'MEMBER') THEN
    RAISE EXCEPTION 'A user cannot change the administrator role.';
  END IF;
  IF OLD.role IN ('farmer', 'trader')
     AND NOT EXISTS (
       SELECT 1 FROM user_roles
       WHERE user_id = OLD.user_id AND role IN ('farmer', 'trader') AND role <> OLD.role
     )
     AND EXISTS (SELECT 1 FROM listings WHERE owner_id = OLD.user_id) THEN
    RAISE EXCEPTION 'This account still owns a listing, so the farmer or trader role cannot be removed.';
  END IF;
  IF OLD.role = 'buyer' AND EXISTS (SELECT 1 FROM buyer_demands WHERE buyer_id = OLD.user_id) THEN
    RAISE EXCEPTION 'This account still owns buyer demand, so the buyer role cannot be removed.';
  END IF;
  RETURN OLD;
END;
$fn$;

CREATE FUNCTION nyuma_listings_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
       OR NEW.commodity IS DISTINCT FROM OLD.commodity
       OR NEW.quantity_unit IS DISTINCT FROM OLD.quantity_unit
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.origin IS DISTINCT FROM OLD.origin THEN
      RAISE EXCEPTION 'Listing id, owner, commodity, quantity unit, and origin cannot change.';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM nyuma_lock_user(NEW.owner_id);
    IF NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.owner_id) THEN
      RAISE EXCEPTION 'Listing owner does not exist.' USING ERRCODE = '23503';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_id = NEW.owner_id AND role IN ('farmer', 'trader')
    ) THEN
      RAISE EXCEPTION 'A listing belongs to an account with the farmer or trader role.';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE FUNCTION nyuma_listings_check() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM nyuma_assert_listing_quantities(NEW.id);
  RETURN NULL;
END;
$fn$;

CREATE FUNCTION nyuma_demands_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.buyer_id IS DISTINCT FROM OLD.buyer_id
       OR NEW.commodity IS DISTINCT FROM OLD.commodity
       OR NEW.quantity_unit IS DISTINCT FROM OLD.quantity_unit
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.origin IS DISTINCT FROM OLD.origin THEN
      RAISE EXCEPTION 'Buyer demand id, buyer, commodity, quantity unit, and origin cannot change.';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM nyuma_lock_user(NEW.buyer_id);
    IF NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.buyer_id) THEN
      RAISE EXCEPTION 'Buyer demand owner does not exist.' USING ERRCODE = '23503';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM user_roles WHERE user_id = NEW.buyer_id AND role = 'buyer'
    ) THEN
      RAISE EXCEPTION 'Buyer demand belongs to an account with the buyer role.';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE FUNCTION nyuma_demands_check() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM nyuma_assert_demand_hold(NEW.id);
  RETURN NULL;
END;
$fn$;

CREATE FUNCTION nyuma_commitments_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  listing listings%ROWTYPE;
  demand buyer_demands%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Commitments are kept for history. Cancel a commitment instead of deleting it.';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.listing_id IS DISTINCT FROM OLD.listing_id
       OR NEW.buyer_demand_id IS DISTINCT FROM OLD.buyer_demand_id
       OR NEW.agreed_quantity IS DISTINCT FROM OLD.agreed_quantity
       OR NEW.quantity_unit IS DISTINCT FROM OLD.quantity_unit
       OR NEW.agreed_price_ksh_per_kg IS DISTINCT FROM OLD.agreed_price_ksh_per_kg
       OR NEW.expected_fulfilment_date IS DISTINCT FROM OLD.expected_fulfilment_date
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.origin IS DISTINCT FROM OLD.origin THEN
      RAISE EXCEPTION 'Only the status of a commitment can change.';
    END IF;
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'The commitment is already %.', OLD.status;
    END IF;
    IF NOT (
      (OLD.status = 'proposed' AND NEW.status IN ('confirmed', 'cancelled'))
      OR (OLD.status = 'confirmed' AND NEW.status IN ('fulfilled', 'cancelled'))
    ) THEN
      RAISE EXCEPTION 'A % commitment cannot become %.', OLD.status, NEW.status;
    END IF;
    IF NEW.status = 'cancelled' AND EXISTS (
      SELECT 1 FROM purchases WHERE commitment_id = OLD.id
    ) THEN
      RAISE EXCEPTION 'This commitment has a recorded purchase, so it cannot be cancelled.';
    END IF;
  END IF;
  PERFORM nyuma_lock_for_commitment(NEW.listing_id, NEW.buyer_demand_id);
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO listing FROM listings WHERE id = NEW.listing_id;
    SELECT * INTO demand FROM buyer_demands WHERE id = NEW.buyer_demand_id;
    IF listing.status <> 'open' THEN
      RAISE EXCEPTION 'Record a commitment only while the listing is open.';
    END IF;
    IF demand.status <> 'open' THEN
      RAISE EXCEPTION 'Record a commitment only while the buyer demand is open.';
    END IF;
    IF listing.commodity <> demand.commodity THEN
      RAISE EXCEPTION 'An agreement needs the same produce.';
    END IF;
    IF NEW.quantity_unit <> listing.quantity_unit OR demand.quantity_unit <> listing.quantity_unit THEN
      RAISE EXCEPTION 'The commitment must use the same quantity unit as the listing and buyer demand.';
    END IF;
    IF NOT nyuma_is_time_compatible(listing.availability_window, demand.collection_window) THEN
      RAISE EXCEPTION 'The requirement collection window does not fit the listing window.';
    END IF;
    IF nyuma_grams(NEW.agreed_quantity) > nyuma_grams(demand.requested_quantity) THEN
      RAISE EXCEPTION 'The agreed quantity is more than the buyer demand requested.';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE FUNCTION nyuma_commitments_check() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM nyuma_assert_listing_quantities(NEW.listing_id);
  PERFORM nyuma_assert_demand_hold(NEW.buyer_demand_id);
  PERFORM nyuma_assert_commitment_purchases(NEW.id);
  RETURN NULL;
END;
$fn$;

CREATE FUNCTION nyuma_purchases_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  commitment commitments%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Purchases are kept for history and cannot be deleted.';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Purchases cannot be changed in place.';
  END IF;
  PERFORM nyuma_lock_for_purchase(NEW.commitment_id);
  SELECT * INTO commitment FROM commitments WHERE id = NEW.commitment_id;
  IF commitment.status <> 'confirmed' THEN
    RAISE EXCEPTION 'Record a purchase only against a confirmed commitment. This commitment is %.', commitment.status;
  END IF;
  IF NEW.listing_id IS DISTINCT FROM commitment.listing_id THEN
    RAISE EXCEPTION 'The purchase must reference the same listing as its commitment.';
  END IF;
  IF NEW.quantity_unit IS DISTINCT FROM commitment.quantity_unit THEN
    RAISE EXCEPTION 'The purchase must use the same quantity unit as its commitment.';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE FUNCTION nyuma_purchases_check() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM nyuma_assert_commitment_purchases(NEW.commitment_id);
  PERFORM nyuma_assert_listing_quantities(NEW.listing_id);
  RETURN NULL;
END;
$fn$;

CREATE FUNCTION nyuma_outcomes_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  listing listings%ROWTYPE;
  commitment_listing text;
  purchase_listing text;
  purchase_commitment text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Outcomes are kept for history and cannot be deleted.';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Outcomes cannot be changed in place.';
  END IF;
  PERFORM nyuma_lock_for_outcome(NEW.listing_id, NEW.purchase_id);
  SELECT * INTO listing FROM listings WHERE id = NEW.listing_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Outcome listing does not exist.' USING ERRCODE = '23503';
  END IF;
  IF NEW.quantity_unit IS DISTINCT FROM listing.quantity_unit THEN
    RAISE EXCEPTION 'The outcome must use the same quantity unit as its listing.';
  END IF;
  IF NEW.commitment_id IS NOT NULL THEN
    SELECT listing_id INTO commitment_listing FROM commitments WHERE id = NEW.commitment_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Outcome commitment does not exist.' USING ERRCODE = '23503';
    END IF;
    IF commitment_listing IS DISTINCT FROM NEW.listing_id THEN
      RAISE EXCEPTION 'That commitment is not recorded against this listing.';
    END IF;
  END IF;
  IF NEW.purchase_id IS NOT NULL THEN
    IF NEW.category <> 'sold' THEN
      RAISE EXCEPTION 'An outcome linked to a purchase must use the sold category.';
    END IF;
    SELECT listing_id, commitment_id INTO purchase_listing, purchase_commitment
    FROM purchases
    WHERE id = NEW.purchase_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Outcome purchase does not exist.' USING ERRCODE = '23503';
    END IF;
    IF purchase_listing IS DISTINCT FROM NEW.listing_id THEN
      RAISE EXCEPTION 'That purchase is not recorded against this listing.';
    END IF;
    IF NEW.commitment_id IS NOT NULL AND purchase_commitment IS DISTINCT FROM NEW.commitment_id THEN
      RAISE EXCEPTION 'That purchase is not part of the selected commitment.';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE FUNCTION nyuma_outcomes_check() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM nyuma_assert_listing_quantities(NEW.listing_id);
  IF NEW.purchase_id IS NOT NULL THEN
    PERFORM nyuma_assert_sold_link(NEW.purchase_id);
  END IF;
  RETURN NULL;
END;
$fn$;

CREATE FUNCTION nyuma_grant_administrator(p_user_id uuid) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF NOT pg_has_role(current_user, 'nyuma_provisioner', 'MEMBER') THEN
    RAISE EXCEPTION 'A user cannot grant the administrator role.';
  END IF;
  INSERT INTO user_roles (user_id, role) VALUES (p_user_id, 'administrator');
END;
$fn$;

-- Lock listing, buyer demand, then commitment before the status row lock is taken by UPDATE.
CREATE FUNCTION nyuma_set_commitment_status(p_id text, p_status text) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_listing_id text;
  v_demand_id text;
BEGIN
  SELECT listing_id, buyer_demand_id INTO v_listing_id, v_demand_id
  FROM commitments
  WHERE id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Commitment % does not exist.', p_id USING ERRCODE = '23503';
  END IF;
  PERFORM nyuma_lock_listing(v_listing_id);
  PERFORM nyuma_lock_demand(v_demand_id);
  PERFORM 1 FROM commitments WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Commitment % does not exist.', p_id USING ERRCODE = '23503';
  END IF;
  UPDATE commitments
  SET status = p_status, updated_at = clock_timestamp()
  WHERE id = p_id;
END;
$fn$;

-- Lock in the same order as a status change, then insert. The purchase trigger locks again.
CREATE FUNCTION nyuma_insert_purchase(
  p_id text,
  p_commitment_id text,
  p_listing_id text,
  p_actual_quantity numeric,
  p_quantity_unit text,
  p_actual_price_ksh_per_kg numeric,
  p_purchase_date date
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  PERFORM nyuma_lock_for_purchase(p_commitment_id);
  INSERT INTO purchases (
    id, commitment_id, listing_id, actual_quantity, quantity_unit, actual_price_ksh_per_kg, purchase_date
  ) VALUES (
    p_id, p_commitment_id, p_listing_id, p_actual_quantity, p_quantity_unit, p_actual_price_ksh_per_kg, p_purchase_date
  );
END;
$fn$;

CREATE TRIGGER user_roles_guard_admin
  BEFORE INSERT ON user_roles
  FOR EACH ROW EXECUTE FUNCTION nyuma_guard_administrator_role();

CREATE TRIGGER user_roles_no_update
  BEFORE UPDATE ON user_roles
  FOR EACH ROW EXECUTE FUNCTION nyuma_user_roles_no_update();

CREATE TRIGGER user_roles_guard_removal
  BEFORE DELETE ON user_roles
  FOR EACH ROW EXECUTE FUNCTION nyuma_guard_role_removal();

CREATE TRIGGER listings_claim_id
  BEFORE INSERT ON listings
  FOR EACH ROW EXECUTE FUNCTION nyuma_claim_coordination_id('listings');

CREATE TRIGGER listings_release_id
  BEFORE DELETE ON listings
  FOR EACH ROW EXECUTE FUNCTION nyuma_release_coordination_id('listings');

CREATE TRIGGER listings_guard
  BEFORE INSERT OR UPDATE ON listings
  FOR EACH ROW EXECUTE FUNCTION nyuma_listings_guard();

CREATE TRIGGER listings_check
  AFTER UPDATE ON listings
  FOR EACH ROW EXECUTE FUNCTION nyuma_listings_check();

CREATE TRIGGER buyer_demands_claim_id
  BEFORE INSERT ON buyer_demands
  FOR EACH ROW EXECUTE FUNCTION nyuma_claim_coordination_id('buyer_demands');

CREATE TRIGGER buyer_demands_release_id
  BEFORE DELETE ON buyer_demands
  FOR EACH ROW EXECUTE FUNCTION nyuma_release_coordination_id('buyer_demands');

CREATE TRIGGER buyer_demands_guard
  BEFORE INSERT OR UPDATE ON buyer_demands
  FOR EACH ROW EXECUTE FUNCTION nyuma_demands_guard();

CREATE TRIGGER buyer_demands_check
  AFTER UPDATE ON buyer_demands
  FOR EACH ROW EXECUTE FUNCTION nyuma_demands_check();

CREATE TRIGGER commitments_claim_id
  BEFORE INSERT ON commitments
  FOR EACH ROW EXECUTE FUNCTION nyuma_claim_coordination_id('commitments');

CREATE TRIGGER commitments_guard
  BEFORE INSERT OR UPDATE OR DELETE ON commitments
  FOR EACH ROW EXECUTE FUNCTION nyuma_commitments_guard();

CREATE TRIGGER commitments_check
  AFTER INSERT OR UPDATE ON commitments
  FOR EACH ROW EXECUTE FUNCTION nyuma_commitments_check();

CREATE TRIGGER purchases_claim_id
  BEFORE INSERT ON purchases
  FOR EACH ROW EXECUTE FUNCTION nyuma_claim_coordination_id('purchases');

CREATE TRIGGER purchases_guard
  BEFORE INSERT OR UPDATE OR DELETE ON purchases
  FOR EACH ROW EXECUTE FUNCTION nyuma_purchases_guard();

CREATE TRIGGER purchases_check
  AFTER INSERT ON purchases
  FOR EACH ROW EXECUTE FUNCTION nyuma_purchases_check();

CREATE TRIGGER outcomes_claim_id
  BEFORE INSERT ON outcomes
  FOR EACH ROW EXECUTE FUNCTION nyuma_claim_coordination_id('outcomes');

CREATE TRIGGER outcomes_guard
  BEFORE INSERT OR UPDATE OR DELETE ON outcomes
  FOR EACH ROW EXECUTE FUNCTION nyuma_outcomes_guard();

CREATE TRIGGER outcomes_check
  AFTER INSERT ON outcomes
  FOR EACH ROW EXECUTE FUNCTION nyuma_outcomes_check();

-- The migration user can provision administrators. nyuma_app cannot.
-- nyuma_provisioner has no login and no password. A member must SET ROLE before the
-- security-invoker grant function can insert, because that function does not run as its owner.
GRANT nyuma_provisioner TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO nyuma_provisioner;
GRANT SELECT, INSERT, DELETE ON user_roles TO nyuma_provisioner;

GRANT USAGE ON SCHEMA public TO nyuma_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  users,
  profiles,
  user_roles,
  coordination_ids,
  listings,
  buyer_demands,
  commitments,
  purchases,
  outcomes
TO nyuma_app;
REVOKE UPDATE ON commitments FROM nyuma_app;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO nyuma_app;
REVOKE EXECUTE ON FUNCTION nyuma_grant_administrator(uuid) FROM nyuma_app;

REVOKE ALL ON FUNCTION nyuma_lock_user(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION nyuma_lock_listing(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION nyuma_lock_demand(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION nyuma_lock_for_commitment(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION nyuma_lock_for_purchase(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION nyuma_lock_for_outcome(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION nyuma_set_commitment_status(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION nyuma_insert_purchase(text, text, text, numeric, text, numeric, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION nyuma_grant_administrator(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION nyuma_lock_user(uuid) TO nyuma_app;
GRANT EXECUTE ON FUNCTION nyuma_lock_listing(text) TO nyuma_app;
GRANT EXECUTE ON FUNCTION nyuma_lock_demand(text) TO nyuma_app;
GRANT EXECUTE ON FUNCTION nyuma_lock_for_commitment(text, text) TO nyuma_app;
GRANT EXECUTE ON FUNCTION nyuma_lock_for_purchase(text) TO nyuma_app;
GRANT EXECUTE ON FUNCTION nyuma_lock_for_outcome(text, text) TO nyuma_app;
GRANT EXECUTE ON FUNCTION nyuma_set_commitment_status(text, text) TO nyuma_app;
GRANT EXECUTE ON FUNCTION nyuma_insert_purchase(text, text, text, numeric, text, numeric, date) TO nyuma_app;
GRANT EXECUTE ON FUNCTION nyuma_grant_administrator(uuid) TO nyuma_provisioner;
