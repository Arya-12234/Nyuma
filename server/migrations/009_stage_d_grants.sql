-- Stage D. Remove direct writes that bypass the verified account.
-- This file does not enable or force row-level security.
-- It does not change coordination rows, JWT algorithms, or sample-workspace storage.
-- nyuma_api remains a member of nyuma_app only. It cannot assume nyuma_fn_constraint.
--
-- Listing and demand INSERT, UPDATE, and DELETE stay with nyuma_app because the API
-- still issues those statements. INSERT already calls nyuma_lock_user. UPDATE and
-- DELETE now require the verified account to own the row, unless the session is an
-- operator or provisioner (maintenance and the migration superuser).
-- Agreement INSERT, purchase INSERT, and outcome INSERT go through checked functions.
-- Those functions run as nyuma_fn_constraint, which receives INSERT on commitments
-- and outcomes for that purpose only.

GRANT INSERT ON public.commitments, public.outcomes TO nyuma_fn_constraint;

CREATE FUNCTION public.nyuma_insert_commitment(
  p_id text,
  p_listing_id text,
  p_demand_id text,
  p_agreed_quantity numeric,
  p_agreed_price_ksh_per_kg numeric,
  p_expected_fulfilment_date date,
  p_status text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_account uuid;
  v_pass integer;
BEGIN
  IF p_status IS DISTINCT FROM 'proposed' AND p_status IS DISTINCT FROM 'confirmed' THEN
    RAISE EXCEPTION 'A new agreement can only be proposed or confirmed.' USING ERRCODE = '23514';
  END IF;
  v_account := public.nyuma_verified_account_id();
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'The account could not be verified.' USING ERRCODE = '42501';
  END IF;
  FOR v_pass IN 1..2 LOOP
    IF v_pass = 2 THEN
      PERFORM public.nyuma_lock_for_commitment(p_listing_id, p_demand_id);
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM public.listings AS listing
      JOIN public.buyer_demands AS demand ON demand.id = p_demand_id
      WHERE listing.id = p_listing_id
        AND (listing.status = 'open' OR listing.owner_id = v_account)
        AND (listing.origin = 'live' OR listing.owner_id = v_account)
        AND (demand.status = 'open' OR demand.buyer_id = v_account)
        AND (demand.origin = 'live' OR demand.buyer_id = v_account)
        AND (
          (
            listing.owner_id = v_account
            AND EXISTS (
              SELECT 1
              FROM public.user_roles
              WHERE user_id = v_account AND role IN ('farmer', 'trader')
            )
          )
          OR (
            demand.buyer_id = v_account
            AND EXISTS (
              SELECT 1
              FROM public.user_roles
              WHERE user_id = v_account AND role = 'buyer'
            )
          )
        )
    ) THEN
      RAISE EXCEPTION 'The agreement does not exist.' USING ERRCODE = '23503';
    END IF;
  END LOOP;
  INSERT INTO public.commitments (
    id, listing_id, buyer_demand_id, agreed_quantity, quantity_unit,
    agreed_price_ksh_per_kg, expected_fulfilment_date, status
  ) VALUES (
    p_id, p_listing_id, p_demand_id, p_agreed_quantity, 'kg',
    p_agreed_price_ksh_per_kg, p_expected_fulfilment_date, p_status
  );
END;
$fn$;

CREATE FUNCTION public.nyuma_insert_outcome(
  p_id text,
  p_listing_id text,
  p_purchase_id text,
  p_category text,
  p_quantity numeric,
  p_recorded_date date,
  p_notes text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_account uuid;
  v_commitment_id text;
  v_pass integer;
BEGIN
  v_account := public.nyuma_verified_account_id();
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'The account could not be verified.' USING ERRCODE = '42501';
  END IF;
  FOR v_pass IN 1..2 LOOP
    IF v_pass = 2 THEN
      PERFORM public.nyuma_lock_listing(p_listing_id);
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM public.listings
      WHERE id = p_listing_id AND owner_id = v_account
    ) OR NOT EXISTS (
      SELECT 1
      FROM public.user_roles
      WHERE user_id = v_account AND role IN ('farmer', 'trader')
    ) THEN
      RAISE EXCEPTION 'The outcome does not exist.' USING ERRCODE = '23503';
    END IF;
  END LOOP;
  v_commitment_id := NULL;
  IF p_purchase_id IS NOT NULL THEN
    SELECT commitment_id
      INTO v_commitment_id
    FROM public.purchases
    WHERE id = p_purchase_id AND listing_id = p_listing_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'The purchase does not exist.' USING ERRCODE = '23503';
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.outcomes
    WHERE listing_id = p_listing_id
      AND category = p_category
      AND quantity = p_quantity
      AND recorded_date = p_recorded_date
      AND purchase_id IS NOT DISTINCT FROM p_purchase_id
      AND commitment_id IS NOT DISTINCT FROM v_commitment_id
      AND notes = COALESCE(p_notes, '')
  ) THEN
    RAISE EXCEPTION 'This outcome is already recorded.' USING ERRCODE = '23505';
  END IF;
  INSERT INTO public.outcomes (
    id, listing_id, commitment_id, purchase_id, category, quantity, quantity_unit, recorded_date, notes
  ) VALUES (
    p_id, p_listing_id, v_commitment_id, p_purchase_id, p_category, p_quantity, 'kg',
    p_recorded_date, COALESCE(p_notes, '')
  );
END;
$fn$;

ALTER FUNCTION public.nyuma_insert_commitment(text, text, text, numeric, numeric, date, text) OWNER TO nyuma_fn_constraint;
ALTER FUNCTION public.nyuma_insert_outcome(text, text, text, text, numeric, date, text) OWNER TO nyuma_fn_constraint;

REVOKE ALL ON FUNCTION public.nyuma_insert_commitment(text, text, text, numeric, numeric, date, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.nyuma_insert_outcome(text, text, text, text, numeric, date, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.nyuma_insert_commitment(text, text, text, numeric, numeric, date, text) TO nyuma_app;
GRANT EXECUTE ON FUNCTION public.nyuma_insert_outcome(text, text, text, text, numeric, date, text) TO nyuma_app;

CREATE OR REPLACE FUNCTION public.nyuma_listings_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NOT (
      pg_has_role(session_user, 'nyuma_operator', 'MEMBER')
      OR pg_has_role(session_user, 'nyuma_provisioner', 'MEMBER')
    ) AND public.nyuma_verified_account_id() IS DISTINCT FROM OLD.owner_id THEN
      RAISE EXCEPTION 'The account could not be verified.' USING ERRCODE = '42501';
    END IF;
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

CREATE OR REPLACE FUNCTION public.nyuma_demands_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NOT (
      pg_has_role(session_user, 'nyuma_operator', 'MEMBER')
      OR pg_has_role(session_user, 'nyuma_provisioner', 'MEMBER')
    ) AND public.nyuma_verified_account_id() IS DISTINCT FROM OLD.buyer_id THEN
      RAISE EXCEPTION 'The account could not be verified.' USING ERRCODE = '42501';
    END IF;
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

CREATE OR REPLACE FUNCTION public.nyuma_users_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT (
      pg_has_role(session_user, 'nyuma_operator', 'MEMBER')
      OR pg_has_role(session_user, 'nyuma_provisioner', 'MEMBER')
    ) THEN
      IF public.nyuma_verified_sub() IS DISTINCT FROM NEW.auth_user_id
         OR NEW.status IS DISTINCT FROM 'active'
         OR NEW.active_role IS NOT NULL THEN
        RAISE EXCEPTION 'The account could not be verified.' USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id THEN
      RAISE EXCEPTION 'The account id cannot change.';
    END IF;
    IF NEW.auth_user_id IS DISTINCT FROM OLD.auth_user_id THEN
      RAISE EXCEPTION 'The linked identity cannot be changed.';
    END IF;
  END IF;
  IF NEW.active_role IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM user_roles WHERE user_id = NEW.id AND role = NEW.active_role
  ) THEN
    RAISE EXCEPTION 'The active workspace must be an assigned role.';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.nyuma_release_coordination_id() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_owner uuid;
BEGIN
  IF NOT (
    pg_has_role(session_user, 'nyuma_operator', 'MEMBER')
    OR pg_has_role(session_user, 'nyuma_provisioner', 'MEMBER')
  ) THEN
    IF TG_ARGV[0] = 'listings' THEN
      v_owner := OLD.owner_id;
    ELSIF TG_ARGV[0] = 'buyer_demands' THEN
      v_owner := OLD.buyer_id;
    ELSE
      v_owner := NULL;
    END IF;
    IF public.nyuma_verified_account_id() IS DISTINCT FROM v_owner THEN
      RAISE EXCEPTION 'The account could not be verified.' USING ERRCODE = '42501';
    END IF;
  END IF;
  DELETE FROM public.coordination_ids WHERE id = OLD.id AND collection = TG_ARGV[0];
  RETURN OLD;
END;
$fn$;

REVOKE INSERT, DELETE ON public.commitments FROM nyuma_app;
REVOKE INSERT, UPDATE, DELETE ON public.purchases FROM nyuma_app;
REVOKE INSERT, UPDATE, DELETE ON public.outcomes FROM nyuma_app;
REVOKE DELETE ON public.users FROM nyuma_app;
REVOKE INSERT, UPDATE, DELETE ON public.coordination_ids FROM nyuma_app;
REVOKE ALL ON TABLE public.profiles FROM nyuma_app;
REVOKE INSERT, UPDATE, DELETE ON public.role_requests FROM nyuma_app;
REVOKE INSERT, UPDATE, DELETE ON public.role_revocations FROM nyuma_app;
REVOKE ALL ON TABLE public.schema_migrations FROM PUBLIC, nyuma_app, nyuma_api;

REVOKE EXECUTE ON FUNCTION public.nyuma_grams(numeric) FROM nyuma_app;
REVOKE EXECUTE ON FUNCTION public.nyuma_is_time_compatible(text, text) FROM nyuma_app;
REVOKE ALL ON FUNCTION public.nyuma_lock_listing(text) FROM nyuma_app;
REVOKE ALL ON FUNCTION public.nyuma_lock_demand(text) FROM nyuma_app;
REVOKE ALL ON FUNCTION public.nyuma_lock_for_commitment(text, text) FROM nyuma_app;
REVOKE ALL ON FUNCTION public.nyuma_lock_for_purchase(text) FROM nyuma_app;
REVOKE ALL ON FUNCTION public.nyuma_lock_for_outcome(text, text) FROM nyuma_app;
REVOKE ALL ON FUNCTION public.nyuma_listing_held_grams(text) FROM nyuma_app;
REVOKE ALL ON FUNCTION public.nyuma_demand_held_grams(text) FROM nyuma_app;
REVOKE ALL ON FUNCTION public.nyuma_listing_outcome_grams(text) FROM nyuma_app;
REVOKE ALL ON FUNCTION public.nyuma_listing_accounted_grams(text) FROM nyuma_app;
REVOKE ALL ON FUNCTION public.nyuma_assert_listing_quantities(text) FROM nyuma_app;
REVOKE ALL ON FUNCTION public.nyuma_assert_demand_hold(text) FROM nyuma_app;
REVOKE ALL ON FUNCTION public.nyuma_assert_commitment_purchases(text) FROM nyuma_app;
REVOKE ALL ON FUNCTION public.nyuma_assert_sold_link(text) FROM nyuma_app;
REVOKE ALL ON FUNCTION public.nyuma_clear_active_role(uuid, text) FROM nyuma_app;
REVOKE ALL ON FUNCTION public.nyuma_approve_role_request(uuid, text) FROM nyuma_app;
REVOKE ALL ON FUNCTION public.nyuma_reject_role_request(uuid, text) FROM nyuma_app;
REVOKE ALL ON FUNCTION public.nyuma_revoke_ordinary_role(uuid, text, text) FROM nyuma_app;
REVOKE ALL ON FUNCTION public.nyuma_grant_administrator(uuid) FROM nyuma_app;

REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, nyuma_app, nyuma_api;

ALTER DEFAULT PRIVILEGES FOR ROLE nyuma_owner IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC, nyuma_app;
ALTER DEFAULT PRIVILEGES FOR ROLE nyuma_owner IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC, nyuma_app;
ALTER DEFAULT PRIVILEGES FOR ROLE nyuma_owner IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM PUBLIC, nyuma_app;
