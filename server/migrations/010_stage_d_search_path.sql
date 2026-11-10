-- Stage D follow-up. Stop temporary objects from shadowing privileged functions.
-- pg_temp is searched before search_path unless it is listed. Listing it last keeps
-- public and pg_catalog ahead of a caller's temporary tables, views, sequences, and types.
-- Application objects in these functions are schema-qualified as well.
-- This file does not enable or force row-level security, grant privileges to nyuma_api
-- or nyuma_app, or change coordination rows.

CREATE OR REPLACE FUNCTION public.nyuma_lock_listing(p_listing_id text) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  PERFORM 1 FROM public.listings WHERE id = p_listing_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Listing % does not exist.', p_listing_id USING ERRCODE = '23503';
  END IF;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.nyuma_lock_demand(p_demand_id text) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  PERFORM 1 FROM public.buyer_demands WHERE id = p_demand_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Buyer demand % does not exist.', p_demand_id USING ERRCODE = '23503';
  END IF;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.nyuma_lock_for_commitment(p_listing_id text, p_demand_id text) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  PERFORM public.nyuma_lock_listing(p_listing_id);
  PERFORM public.nyuma_lock_demand(p_demand_id);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.nyuma_lock_for_purchase(p_commitment_id text) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_listing_id text;
  v_demand_id text;
BEGIN
  SELECT listing_id, buyer_demand_id INTO v_listing_id, v_demand_id
  FROM public.commitments
  WHERE id = p_commitment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Commitment % does not exist.', p_commitment_id USING ERRCODE = '23503';
  END IF;
  PERFORM public.nyuma_lock_listing(v_listing_id);
  PERFORM public.nyuma_lock_demand(v_demand_id);
  PERFORM 1 FROM public.commitments WHERE id = p_commitment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Commitment % does not exist.', p_commitment_id USING ERRCODE = '23503';
  END IF;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.nyuma_lock_for_outcome(p_listing_id text, p_purchase_id text) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_listing_id text;
BEGIN
  PERFORM public.nyuma_lock_listing(p_listing_id);
  IF p_purchase_id IS NULL THEN
    RETURN;
  END IF;
  SELECT listing_id INTO v_listing_id FROM public.purchases WHERE id = p_purchase_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Purchase % does not exist.', p_purchase_id USING ERRCODE = '23503';
  END IF;
  IF v_listing_id IS DISTINCT FROM p_listing_id THEN
    RAISE EXCEPTION 'That purchase is not recorded against this listing.';
  END IF;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.nyuma_listing_held_grams(p_listing_id text) RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT COALESCE(SUM(
    CASE
      WHEN c.status IN ('proposed', 'confirmed') THEN public.nyuma_grams(c.agreed_quantity)::numeric
      WHEN c.status = 'fulfilled' THEN (
        SELECT COALESCE(SUM(public.nyuma_grams(p.actual_quantity)), 0)
        FROM public.purchases p
        WHERE p.commitment_id = c.id
      )
      ELSE 0
    END
  ), 0)::bigint
  FROM public.commitments c
  WHERE c.listing_id = p_listing_id;
$fn$;

CREATE OR REPLACE FUNCTION public.nyuma_demand_held_grams(p_demand_id text) RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT COALESCE(SUM(
    CASE
      WHEN c.status IN ('proposed', 'confirmed') THEN public.nyuma_grams(c.agreed_quantity)::numeric
      WHEN c.status = 'fulfilled' THEN (
        SELECT COALESCE(SUM(public.nyuma_grams(p.actual_quantity)), 0)
        FROM public.purchases p
        WHERE p.commitment_id = c.id
      )
      ELSE 0
    END
  ), 0)::bigint
  FROM public.commitments c
  WHERE c.buyer_demand_id = p_demand_id;
$fn$;

CREATE OR REPLACE FUNCTION public.nyuma_listing_outcome_grams(p_listing_id text) RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT COALESCE(SUM(public.nyuma_grams(quantity)), 0)::bigint
  FROM public.outcomes
  WHERE listing_id = p_listing_id;
$fn$;

CREATE OR REPLACE FUNCTION public.nyuma_listing_accounted_grams(p_listing_id text) RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT (
    COALESCE((SELECT SUM(public.nyuma_grams(quantity)) FROM public.outcomes WHERE listing_id = p_listing_id), 0)
    + COALESCE((
      SELECT SUM(GREATEST(
        public.nyuma_grams(p.actual_quantity)::numeric - COALESCE((
          SELECT SUM(public.nyuma_grams(o.quantity))
          FROM public.outcomes o
          WHERE o.purchase_id = p.id AND o.category = 'sold'
        ), 0),
        0
      ))
      FROM public.purchases p
      WHERE p.listing_id = p_listing_id
    ), 0)
  )::bigint;
$fn$;

CREATE OR REPLACE FUNCTION public.nyuma_assert_listing_quantities(p_listing_id text) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  listed bigint;
  held bigint;
  outcome_grams bigint;
  accounted bigint;
BEGIN
  SELECT public.nyuma_grams(quantity) INTO listed FROM public.listings WHERE id = p_listing_id;
  held := public.nyuma_listing_held_grams(p_listing_id);
  outcome_grams := public.nyuma_listing_outcome_grams(p_listing_id);
  accounted := public.nyuma_listing_accounted_grams(p_listing_id);
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
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  requested bigint;
  held bigint;
BEGIN
  SELECT public.nyuma_grams(requested_quantity) INTO requested FROM public.buyer_demands WHERE id = p_demand_id;
  held := public.nyuma_demand_held_grams(p_demand_id);
  IF held > requested THEN
    RAISE EXCEPTION 'Promised and purchased quantity would exceed the buyer requirement.';
  END IF;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.nyuma_assert_commitment_purchases(p_commitment_id text) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_status text;
  agreed bigint;
  purchased bigint;
BEGIN
  SELECT status, public.nyuma_grams(agreed_quantity) INTO v_status, agreed
  FROM public.commitments
  WHERE id = p_commitment_id;
  SELECT COALESCE(SUM(public.nyuma_grams(actual_quantity)), 0) INTO purchased
  FROM public.purchases
  WHERE commitment_id = p_commitment_id;
  IF v_status = 'cancelled' AND purchased > 0 THEN
    RAISE EXCEPTION 'A cancelled commitment must not hold a purchase.';
  END IF;
  IF purchased > agreed THEN
    RAISE EXCEPTION 'Purchases would exceed the remaining agreed quantity.';
  END IF;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.nyuma_assert_sold_link(p_purchase_id text) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  purchased bigint;
  linked bigint;
BEGIN
  SELECT public.nyuma_grams(actual_quantity) INTO purchased FROM public.purchases WHERE id = p_purchase_id;
  SELECT COALESCE(SUM(public.nyuma_grams(quantity)), 0) INTO linked
  FROM public.outcomes
  WHERE purchase_id = p_purchase_id;
  IF linked > purchased THEN
    RAISE EXCEPTION 'Sold outcomes linked to this purchase would exceed the purchased quantity.';
  END IF;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.nyuma_commitments_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  listing public.listings%ROWTYPE;
  demand public.buyer_demands%ROWTYPE;
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
      SELECT 1 FROM public.purchases WHERE commitment_id = OLD.id
    ) THEN
      RAISE EXCEPTION 'This commitment has a recorded purchase, so it cannot be cancelled.';
    END IF;
  END IF;
  PERFORM public.nyuma_lock_for_commitment(NEW.listing_id, NEW.buyer_demand_id);
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO listing FROM public.listings WHERE id = NEW.listing_id;
    SELECT * INTO demand FROM public.buyer_demands WHERE id = NEW.buyer_demand_id;
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
    IF NOT public.nyuma_is_time_compatible(listing.availability_window, demand.collection_window) THEN
      RAISE EXCEPTION 'The requirement collection window does not fit the listing window.';
    END IF;
    IF public.nyuma_grams(NEW.agreed_quantity) > public.nyuma_grams(demand.requested_quantity) THEN
      RAISE EXCEPTION 'The agreed quantity is more than the buyer demand requested.';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.nyuma_purchases_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  commitment public.commitments%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Purchases are kept for history and cannot be deleted.';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Purchases cannot be changed in place.';
  END IF;
  PERFORM public.nyuma_lock_for_purchase(NEW.commitment_id);
  SELECT * INTO commitment FROM public.commitments WHERE id = NEW.commitment_id;
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

CREATE OR REPLACE FUNCTION public.nyuma_outcomes_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  listing public.listings%ROWTYPE;
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
  PERFORM public.nyuma_lock_for_outcome(NEW.listing_id, NEW.purchase_id);
  SELECT * INTO listing FROM public.listings WHERE id = NEW.listing_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Outcome listing does not exist.' USING ERRCODE = '23503';
  END IF;
  IF NEW.quantity_unit IS DISTINCT FROM listing.quantity_unit THEN
    RAISE EXCEPTION 'The outcome must use the same quantity unit as its listing.';
  END IF;
  IF NEW.commitment_id IS NOT NULL THEN
    SELECT listing_id INTO commitment_listing FROM public.commitments WHERE id = NEW.commitment_id;
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
    FROM public.purchases
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

CREATE OR REPLACE FUNCTION public.nyuma_listings_check() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  PERFORM public.nyuma_assert_listing_quantities(NEW.id);
  RETURN NULL;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.nyuma_demands_check() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  PERFORM public.nyuma_assert_demand_hold(NEW.id);
  RETURN NULL;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.nyuma_commitments_check() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  PERFORM public.nyuma_assert_listing_quantities(NEW.listing_id);
  PERFORM public.nyuma_assert_demand_hold(NEW.buyer_demand_id);
  PERFORM public.nyuma_assert_commitment_purchases(NEW.id);
  RETURN NULL;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.nyuma_purchases_check() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  PERFORM public.nyuma_assert_commitment_purchases(NEW.commitment_id);
  PERFORM public.nyuma_assert_listing_quantities(NEW.listing_id);
  RETURN NULL;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.nyuma_outcomes_check() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  PERFORM public.nyuma_assert_listing_quantities(NEW.listing_id);
  IF NEW.purchase_id IS NOT NULL THEN
    PERFORM public.nyuma_assert_sold_link(NEW.purchase_id);
  END IF;
  RETURN NULL;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.nyuma_claim_coordination_id() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  INSERT INTO public.coordination_ids (id, collection) VALUES (NEW.id, TG_ARGV[0]);
  RETURN NEW;
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'The id % is already used by a coordination record.', NEW.id USING ERRCODE = '23505';
END;
$fn$;

CREATE OR REPLACE FUNCTION public.nyuma_clear_active_role(p_user_id uuid, p_role text) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  UPDATE public.users
  SET active_role = NULL, updated_at = clock_timestamp()
  WHERE id = p_user_id AND active_role = p_role;
END;
$fn$;

DO $path$
DECLARE
  signature text;
  configured text;
BEGIN
  FOR signature, configured IN
    SELECT p.oid::regprocedure::text, p.proname
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef
  LOOP
    IF configured = 'nyuma_verified_sub' THEN
      EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, nyuma_private, pg_temp', signature);
    ELSIF configured IN ('nyuma_account_status', 'nyuma_verified_account_id', 'nyuma_identity_verification_mode') THEN
      EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, pg_temp', signature);
    ELSE
      EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, public, pg_temp', signature);
    END IF;
  END LOOP;
END;
$path$;
