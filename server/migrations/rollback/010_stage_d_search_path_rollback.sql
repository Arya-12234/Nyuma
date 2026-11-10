-- Stage D search-path rollback. This file is not a forward migration.
-- Run with: psql -v ON_ERROR_STOP=1 -f server/migrations/rollback/010_stage_d_search_path_rollback.sql
--
-- Restores the previous function bodies and search_path settings from before 010.
-- Does not drop coordination rows and does not enable or disable row-level security.
-- Stop the API before running this.

DO $$
DECLARE
  v_migration_version text;
  v_migration_prefix numeric;
  v_migration_target constant integer := 10;
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'schema_migrations is missing. Refusing to guess at a rollback.';
  END IF;
  FOR v_migration_version IN
    SELECT applied.version FROM public.schema_migrations AS applied
  LOOP
    IF v_migration_version !~ '^[0-9]+_.+$' THEN
      RAISE EXCEPTION 'Unparseable migration version: %', v_migration_version;
    END IF;
    v_migration_prefix := substring(v_migration_version FROM '^([0-9]+)')::numeric;
    IF v_migration_prefix <> trunc(v_migration_prefix)
       OR v_migration_prefix < 0
       OR v_migration_prefix > 2147483647 THEN
      RAISE EXCEPTION 'Unparseable migration version: %', v_migration_version;
    END IF;
    IF v_migration_prefix::integer > v_migration_target THEN
      RAISE EXCEPTION 'A later migration is recorded. Do not roll this change back with this script.';
    END IF;
  END LOOP;
END;
$$;

-- The forward migration replaced these bodies. Restoring them returns the previous text.
-- Qualified names in functions that 010 did not rewrite stay qualified.

CREATE OR REPLACE FUNCTION public.nyuma_lock_listing(p_listing_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $fn$
BEGIN
  PERFORM 1 FROM listings WHERE id = p_listing_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Listing % does not exist.', p_listing_id USING ERRCODE = '23503';
  END IF;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.nyuma_lock_demand(p_demand_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $fn$
BEGIN
  PERFORM 1 FROM buyer_demands WHERE id = p_demand_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Buyer demand % does not exist.', p_demand_id USING ERRCODE = '23503';
  END IF;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.nyuma_lock_for_commitment(p_listing_id text, p_demand_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $fn$
BEGIN
  PERFORM nyuma_lock_listing(p_listing_id);
  PERFORM nyuma_lock_demand(p_demand_id);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.nyuma_lock_for_purchase(p_commitment_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_listing_id text;
  v_demand_id text;
BEGIN
  SELECT listing_id, buyer_demand_id INTO v_listing_id, v_demand_id
  FROM commitments WHERE id = p_commitment_id;
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

CREATE OR REPLACE FUNCTION public.nyuma_lock_for_outcome(p_listing_id text, p_purchase_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_listing_id text;
BEGIN
  PERFORM nyuma_lock_listing(p_listing_id);
  IF p_purchase_id IS NULL THEN RETURN; END IF;
  SELECT listing_id INTO v_listing_id FROM purchases WHERE id = p_purchase_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Purchase % does not exist.', p_purchase_id USING ERRCODE = '23503';
  END IF;
  IF v_listing_id IS DISTINCT FROM p_listing_id THEN
    RAISE EXCEPTION 'That purchase is not recorded against this listing.';
  END IF;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.nyuma_listing_held_grams(p_listing_id text) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $fn$
  SELECT COALESCE(SUM(
    CASE
      WHEN c.status IN ('proposed', 'confirmed') THEN nyuma_grams(c.agreed_quantity)::numeric
      WHEN c.status = 'fulfilled' THEN (
        SELECT COALESCE(SUM(nyuma_grams(p.actual_quantity)), 0)
        FROM purchases p WHERE p.commitment_id = c.id
      )
      ELSE 0
    END
  ), 0)::bigint
  FROM commitments c WHERE c.listing_id = p_listing_id;
$fn$;

CREATE OR REPLACE FUNCTION public.nyuma_demand_held_grams(p_demand_id text) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $fn$
  SELECT COALESCE(SUM(
    CASE
      WHEN c.status IN ('proposed', 'confirmed') THEN nyuma_grams(c.agreed_quantity)::numeric
      WHEN c.status = 'fulfilled' THEN (
        SELECT COALESCE(SUM(nyuma_grams(p.actual_quantity)), 0)
        FROM purchases p WHERE p.commitment_id = c.id
      )
      ELSE 0
    END
  ), 0)::bigint
  FROM commitments c WHERE c.buyer_demand_id = p_demand_id;
$fn$;

CREATE OR REPLACE FUNCTION public.nyuma_listing_outcome_grams(p_listing_id text) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $fn$
  SELECT COALESCE(SUM(nyuma_grams(quantity)), 0)::bigint
  FROM outcomes WHERE listing_id = p_listing_id;
$fn$;

CREATE OR REPLACE FUNCTION public.nyuma_listing_accounted_grams(p_listing_id text) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $fn$
  SELECT (
    COALESCE((SELECT SUM(nyuma_grams(quantity)) FROM outcomes WHERE listing_id = p_listing_id), 0)
    + COALESCE((
      SELECT SUM(GREATEST(
        nyuma_grams(p.actual_quantity)::numeric - COALESCE((
          SELECT SUM(nyuma_grams(o.quantity)) FROM outcomes o
          WHERE o.purchase_id = p.id AND o.category = 'sold'
        ), 0), 0)
      ))
      FROM purchases p WHERE p.listing_id = p_listing_id
    ), 0)
  )::bigint;
$fn$;

CREATE OR REPLACE FUNCTION public.nyuma_assert_listing_quantities(p_listing_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $fn$
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

CREATE OR REPLACE FUNCTION public.nyuma_assert_demand_hold(p_demand_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $fn$
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

CREATE OR REPLACE FUNCTION public.nyuma_assert_commitment_purchases(p_commitment_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_status text;
  agreed bigint;
  purchased bigint;
BEGIN
  SELECT status, nyuma_grams(agreed_quantity) INTO v_status, agreed
  FROM commitments WHERE id = p_commitment_id;
  SELECT COALESCE(SUM(nyuma_grams(actual_quantity)), 0) INTO purchased
  FROM purchases WHERE commitment_id = p_commitment_id;
  IF v_status = 'cancelled' AND purchased > 0 THEN
    RAISE EXCEPTION 'A cancelled commitment must not hold a purchase.';
  END IF;
  IF purchased > agreed THEN
    RAISE EXCEPTION 'Purchases would exceed the remaining agreed quantity.';
  END IF;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.nyuma_assert_sold_link(p_purchase_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $fn$
DECLARE
  purchased bigint;
  linked bigint;
BEGIN
  SELECT nyuma_grams(actual_quantity) INTO purchased FROM purchases WHERE id = p_purchase_id;
  SELECT COALESCE(SUM(nyuma_grams(quantity)), 0) INTO linked
  FROM outcomes WHERE purchase_id = p_purchase_id;
  IF linked > purchased THEN
    RAISE EXCEPTION 'Sold outcomes linked to this purchase would exceed the purchased quantity.';
  END IF;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.nyuma_claim_coordination_id() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $fn$
BEGIN
  INSERT INTO coordination_ids (id, collection) VALUES (NEW.id, TG_ARGV[0]);
  RETURN NEW;
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'The id % is already used by a coordination record.', NEW.id USING ERRCODE = '23505';
END;
$fn$;

CREATE OR REPLACE FUNCTION public.nyuma_clear_active_role(p_user_id uuid, p_role text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $fn$
BEGIN
  UPDATE users
  SET active_role = NULL, updated_at = clock_timestamp()
  WHERE id = p_user_id AND active_role = p_role;
END;
$fn$;

-- Guard and check functions keep the schema-qualified bodies from 010.
-- The statements above restore the previous lock, quantity, claim, and clear-role text.
-- The loop below restores search_path for every other privileged function.

ALTER FUNCTION public.nyuma_verified_sub() SET search_path = pg_catalog, nyuma_private;
ALTER FUNCTION public.nyuma_account_status() SET search_path = pg_catalog;
ALTER FUNCTION public.nyuma_verified_account_id() SET search_path = pg_catalog;
ALTER FUNCTION public.nyuma_identity_verification_mode() SET search_path = pg_catalog;

DO $path$
DECLARE
  signature text;
  function_name text;
BEGIN
  FOR signature, function_name IN
    SELECT p.oid::regprocedure::text, p.proname
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef
      AND p.proname NOT IN (
        'nyuma_verified_sub',
        'nyuma_account_status',
        'nyuma_verified_account_id',
        'nyuma_identity_verification_mode'
      )
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, public', signature);
  END LOOP;
END;
$path$;

DELETE FROM schema_migrations WHERE version = '010_stage_d_search_path.sql';
