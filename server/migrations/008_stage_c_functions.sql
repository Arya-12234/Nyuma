-- Stage C. Privileged functions use the verified bearer token.
-- This file does not enable or force row-level security.
-- nyuma_api is not granted membership in nyuma_fn_constraint.
-- Changing a function owner does not change who an invoker runs as.
-- Quantity and cross-record triggers are SECURITY DEFINER so they execute as nyuma_fn_constraint.
-- Direct table writes by nyuma_app remain until a later grant and RLS stage.
-- Those writes still fire the quantity triggers.
-- A direct INSERT or UPDATE still does not prove the caller's account until row-level security.
-- Listing and demand INSERT call nyuma_lock_user, which rejects an account id that is not the verified account.
-- SELECT of another account's rows is not closed here. That depends on row-level security.

-- SELECT FOR UPDATE needs UPDATE. The role does not receive table ownership or BYPASSRLS grants.
GRANT SELECT ON
  users,
  user_roles,
  coordination_ids,
  listings,
  buyer_demands,
  commitments,
  purchases,
  outcomes
TO nyuma_fn_constraint;
GRANT UPDATE ON users, listings, buyer_demands, commitments, purchases TO nyuma_fn_constraint;
GRANT INSERT ON purchases, coordination_ids TO nyuma_fn_constraint;
GRANT DELETE ON coordination_ids TO nyuma_fn_constraint;
GRANT UPDATE ON users TO nyuma_fn_revoke;
GRANT EXECUTE ON FUNCTION public.nyuma_verified_sub() TO nyuma_fn_constraint, nyuma_fn_request;
GRANT EXECUTE ON FUNCTION public.nyuma_verified_account_id() TO nyuma_fn_constraint, nyuma_fn_request;
GRANT EXECUTE ON FUNCTION public.nyuma_account_status() TO nyuma_fn_constraint, nyuma_fn_request;

CREATE OR REPLACE FUNCTION public.nyuma_lock_user(p_user_id uuid) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  -- Operator and provisioner sessions lock the account named by an audited workflow.
  -- session_user stays the login inside SECURITY DEFINER. Superusers pass pg_has_role.
  -- nyuma_api is not a member of either role. Function-owner membership is not a bypass:
  -- the API login is not a member, and a DEFINER call does not change session_user.
  IF pg_has_role(session_user, 'nyuma_operator', 'MEMBER')
     OR pg_has_role(session_user, 'nyuma_provisioner', 'MEMBER') THEN
    PERFORM 1 FROM public.users WHERE id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'User % does not exist.', p_user_id USING ERRCODE = '23503';
    END IF;
    RETURN;
  END IF;
  IF p_user_id IS DISTINCT FROM public.nyuma_verified_account_id() THEN
    RAISE EXCEPTION 'The account could not be locked.' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The account could not be locked.' USING ERRCODE = '42501';
  END IF;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.nyuma_set_commitment_status(p_id text, p_status text) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_account uuid;
  v_listing_id text;
  v_demand_id text;
BEGIN
  v_account := public.nyuma_verified_account_id();
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'The account could not be verified.' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.commitments AS c
    JOIN public.listings AS l ON l.id = c.listing_id
    JOIN public.buyer_demands AS d ON d.id = c.buyer_demand_id
    WHERE c.id = p_id
      AND (
        (l.owner_id = v_account AND EXISTS (
          SELECT 1 FROM public.user_roles AS ur
          WHERE ur.user_id = v_account AND ur.role IN ('farmer', 'trader')
        ))
        OR (d.buyer_id = v_account AND EXISTS (
          SELECT 1 FROM public.user_roles AS ur
          WHERE ur.user_id = v_account AND ur.role = 'buyer'
        ))
      )
  ) THEN
    RAISE EXCEPTION 'Commitment % does not exist.', p_id USING ERRCODE = '23503';
  END IF;
  SELECT c.listing_id, c.buyer_demand_id INTO v_listing_id, v_demand_id
  FROM public.commitments AS c
  WHERE c.id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Commitment % does not exist.', p_id USING ERRCODE = '23503';
  END IF;
  PERFORM public.nyuma_lock_listing(v_listing_id);
  PERFORM public.nyuma_lock_demand(v_demand_id);
  PERFORM 1 FROM public.commitments WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Commitment % does not exist.', p_id USING ERRCODE = '23503';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.commitments AS c
    JOIN public.listings AS l ON l.id = c.listing_id
    JOIN public.buyer_demands AS d ON d.id = c.buyer_demand_id
    WHERE c.id = p_id
      AND (
        (l.owner_id = v_account AND EXISTS (
          SELECT 1 FROM public.user_roles AS ur
          WHERE ur.user_id = v_account AND ur.role IN ('farmer', 'trader')
        ))
        OR (d.buyer_id = v_account AND EXISTS (
          SELECT 1 FROM public.user_roles AS ur
          WHERE ur.user_id = v_account AND ur.role = 'buyer'
        ))
      )
  ) THEN
    RAISE EXCEPTION 'Commitment % does not exist.', p_id USING ERRCODE = '23503';
  END IF;
  UPDATE public.commitments
  SET status = p_status, updated_at = clock_timestamp()
  WHERE id = p_id;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.nyuma_insert_purchase(
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
DECLARE
  v_account uuid;
  v_listing_id text;
BEGIN
  v_account := public.nyuma_verified_account_id();
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'The account could not be verified.' USING ERRCODE = '42501';
  END IF;
  SELECT c.listing_id INTO v_listing_id
  FROM public.commitments AS c
  WHERE c.id = p_commitment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Commitment % does not exist.', p_commitment_id USING ERRCODE = '23503';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.commitments AS c
    JOIN public.listings AS l ON l.id = c.listing_id
    JOIN public.buyer_demands AS d ON d.id = c.buyer_demand_id
    WHERE c.id = p_commitment_id
      AND (
        (l.owner_id = v_account AND EXISTS (
          SELECT 1 FROM public.user_roles AS ur
          WHERE ur.user_id = v_account AND ur.role IN ('farmer', 'trader')
        ))
        OR (d.buyer_id = v_account AND EXISTS (
          SELECT 1 FROM public.user_roles AS ur
          WHERE ur.user_id = v_account AND ur.role = 'buyer'
        ))
      )
  ) THEN
    RAISE EXCEPTION 'Commitment % does not exist.', p_commitment_id USING ERRCODE = '23503';
  END IF;
  IF v_listing_id IS DISTINCT FROM p_listing_id THEN
    RAISE EXCEPTION 'The purchase must reference the same listing as its commitment.';
  END IF;
  PERFORM public.nyuma_lock_for_purchase(p_commitment_id);
  SELECT c.listing_id INTO v_listing_id
  FROM public.commitments AS c
  WHERE c.id = p_commitment_id;
  IF NOT FOUND OR v_listing_id IS DISTINCT FROM p_listing_id OR NOT EXISTS (
    SELECT 1
    FROM public.commitments AS c
    JOIN public.listings AS l ON l.id = c.listing_id
    JOIN public.buyer_demands AS d ON d.id = c.buyer_demand_id
    WHERE c.id = p_commitment_id
      AND (
        (l.owner_id = v_account AND EXISTS (
          SELECT 1 FROM public.user_roles AS ur
          WHERE ur.user_id = v_account AND ur.role IN ('farmer', 'trader')
        ))
        OR (d.buyer_id = v_account AND EXISTS (
          SELECT 1 FROM public.user_roles AS ur
          WHERE ur.user_id = v_account AND ur.role = 'buyer'
        ))
      )
  ) THEN
    RAISE EXCEPTION 'Commitment % does not exist.', p_commitment_id USING ERRCODE = '23503';
  END IF;
  INSERT INTO public.purchases (
    id, commitment_id, listing_id, actual_quantity, quantity_unit, actual_price_ksh_per_kg, purchase_date
  ) VALUES (
    p_id, p_commitment_id, p_listing_id, p_actual_quantity, p_quantity_unit, p_actual_price_ksh_per_kg, p_purchase_date
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION public.nyuma_set_active_role(p_user_id uuid, p_role text) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  verified uuid;
BEGIN
  verified := public.nyuma_verified_account_id();
  IF verified IS NULL THEN
    RAISE EXCEPTION 'The account could not be verified.' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS DISTINCT FROM verified THEN
    RAISE EXCEPTION 'That workspace is not assigned to this account.' USING ERRCODE = 'P0001';
  END IF;
  IF p_role NOT IN ('farmer', 'trader', 'buyer', 'administrator')
     OR NOT EXISTS (
       SELECT 1 FROM public.user_roles WHERE user_id = verified AND role = p_role
     ) THEN
    RAISE EXCEPTION 'That workspace is not assigned to this account.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.users
  SET active_role = p_role, updated_at = clock_timestamp()
  WHERE id = verified;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Account % does not exist.', verified USING ERRCODE = '23503';
  END IF;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.nyuma_guard_role_removal() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  -- This trigger is SECURITY DEFINER, so current_user is nyuma_fn_constraint.
  -- The provisioner check has to read session_user, which stays the login.
  IF OLD.role = 'administrator'
     AND NOT pg_has_role(session_user, 'nyuma_provisioner', 'MEMBER') THEN
    RAISE EXCEPTION 'A user cannot change the administrator role.';
  END IF;
  PERFORM public.nyuma_lock_user(OLD.user_id);
  IF OLD.role IN ('farmer', 'trader')
     AND NOT EXISTS (
       SELECT 1 FROM public.user_roles
       WHERE user_id = OLD.user_id AND role IN ('farmer', 'trader') AND role <> OLD.role
     )
     AND EXISTS (SELECT 1 FROM public.listings WHERE owner_id = OLD.user_id) THEN
    RAISE EXCEPTION 'This account still owns a listing, so the farmer or trader role cannot be removed.';
  END IF;
  IF OLD.role = 'buyer' AND EXISTS (SELECT 1 FROM public.buyer_demands WHERE buyer_id = OLD.user_id) THEN
    RAISE EXCEPTION 'This account still owns buyer demand, so the buyer role cannot be removed.';
  END IF;
  PERFORM public.nyuma_clear_active_role(OLD.user_id, OLD.role);
  RETURN OLD;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.nyuma_submit_role_requests(p_auth_user_id uuid, p_roles text[])
RETURNS TABLE (
  id uuid,
  role text,
  status text,
  requested_at timestamptz,
  decided_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
#variable_conflict use_column
DECLARE
  v_user_id uuid;
  v_account_status text;
  v_role text;
  v_seen text[] := ARRAY[]::text[];
  v_request_id uuid;
  v_requested_at timestamptz;
  v_decided_at timestamptz;
  v_result_status text;
BEGIN
  IF p_auth_user_id IS NULL OR p_roles IS NULL OR cardinality(p_roles) = 0 OR cardinality(p_roles) > 10 THEN
    RAISE EXCEPTION 'invalid-request' USING ERRCODE = 'P0001';
  END IF;
  IF p_auth_user_id IS DISTINCT FROM public.nyuma_verified_sub() THEN
    RAISE EXCEPTION 'invalid-request' USING ERRCODE = 'P0001';
  END IF;
  v_account_status := public.nyuma_account_status();
  IF v_account_status IS NULL THEN
    RAISE EXCEPTION 'account-not-bootstrapped' USING ERRCODE = 'P0001';
  END IF;
  IF v_account_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'account-disabled' USING ERRCODE = 'P0001';
  END IF;
  FOREACH v_role IN ARRAY p_roles LOOP
    IF v_role IS NULL OR v_role NOT IN ('farmer', 'trader', 'buyer') THEN
      RAISE EXCEPTION 'invalid-request' USING ERRCODE = 'P0001';
    END IF;
    IF NOT v_role = ANY (v_seen) THEN
      v_seen := array_append(v_seen, v_role);
    END IF;
  END LOOP;

  SELECT users.id, users.status
    INTO v_user_id, v_account_status
  FROM public.users
  WHERE users.auth_user_id = p_auth_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'account-not-bootstrapped' USING ERRCODE = 'P0001';
  END IF;
  PERFORM public.nyuma_lock_user(v_user_id);
  SELECT users.status
    INTO v_account_status
  FROM public.users
  WHERE users.id = v_user_id;
  IF v_account_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'account-disabled' USING ERRCODE = 'P0001';
  END IF;

  FOREACH v_role IN ARRAY v_seen LOOP
    v_request_id := NULL;
    v_requested_at := NULL;
    v_decided_at := NULL;
    IF EXISTS (
      SELECT 1
      FROM public.user_roles
      WHERE user_roles.user_id = v_user_id AND user_roles.role = v_role
    ) THEN
      SELECT role_requests.id, role_requests.requested_at, role_requests.decided_at
        INTO v_request_id, v_requested_at, v_decided_at
      FROM public.role_requests
      WHERE role_requests.user_id = v_user_id AND role_requests.role = v_role
      ORDER BY role_requests.requested_at DESC
      LIMIT 1;
      v_result_status := 'granted';
    ELSE
      SELECT role_requests.id, role_requests.requested_at, role_requests.decided_at
        INTO v_request_id, v_requested_at, v_decided_at
      FROM public.role_requests
      WHERE role_requests.user_id = v_user_id
        AND role_requests.role = v_role
        AND role_requests.status = 'pending';
      IF v_request_id IS NULL THEN
        INSERT INTO public.role_requests AS inserted (user_id, role, status)
        VALUES (v_user_id, v_role, 'pending')
        ON CONFLICT (user_id, role) WHERE status = 'pending' DO NOTHING
        RETURNING inserted.id, inserted.requested_at, inserted.decided_at
          INTO v_request_id, v_requested_at, v_decided_at;
        IF v_request_id IS NULL THEN
          SELECT role_requests.id, role_requests.requested_at, role_requests.decided_at
            INTO v_request_id, v_requested_at, v_decided_at
          FROM public.role_requests
          WHERE role_requests.user_id = v_user_id
            AND role_requests.role = v_role
            AND role_requests.status = 'pending';
        END IF;
      END IF;
      v_result_status := 'pending';
    END IF;
    id := v_request_id;
    role := v_role;
    status := v_result_status;
    requested_at := v_requested_at;
    decided_at := v_decided_at;
    RETURN NEXT;
  END LOOP;
  RETURN;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.nyuma_list_role_requests(p_auth_user_id uuid)
RETURNS TABLE (
  id uuid,
  role text,
  status text,
  requested_at timestamptz,
  decided_at timestamptz,
  decision_note text,
  granted boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
#variable_conflict use_column
BEGIN
  IF p_auth_user_id IS NULL OR p_auth_user_id IS DISTINCT FROM public.nyuma_verified_sub() THEN
    RAISE EXCEPTION 'invalid-request' USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY
  SELECT role_requests.id,
         role_requests.role,
         role_requests.status,
         role_requests.requested_at,
         role_requests.decided_at,
         role_requests.decision_note,
         EXISTS (
           SELECT 1
           FROM public.user_roles
           WHERE user_roles.user_id = role_requests.user_id
             AND user_roles.role = role_requests.role
         )
  FROM public.role_requests
  JOIN public.users ON users.id = role_requests.user_id
  WHERE users.auth_user_id = p_auth_user_id
  ORDER BY role_requests.requested_at, role_requests.role;
END;
$fn$;

ALTER FUNCTION public.nyuma_submit_role_requests(uuid, text[]) OWNER TO nyuma_fn_request;
ALTER FUNCTION public.nyuma_list_role_requests(uuid) OWNER TO nyuma_fn_request;

DO $owner$
DECLARE
  signature text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'public.nyuma_lock_user(uuid)',
    'public.nyuma_lock_listing(text)',
    'public.nyuma_lock_demand(text)',
    'public.nyuma_lock_for_commitment(text, text)',
    'public.nyuma_lock_for_purchase(text)',
    'public.nyuma_lock_for_outcome(text, text)',
    'public.nyuma_set_commitment_status(text, text)',
    'public.nyuma_insert_purchase(text, text, text, numeric, text, numeric, date)',
    'public.nyuma_set_active_role(uuid, text)',
    'public.nyuma_listing_held_grams(text)',
    'public.nyuma_demand_held_grams(text)',
    'public.nyuma_listing_outcome_grams(text)',
    'public.nyuma_listing_accounted_grams(text)',
    'public.nyuma_assert_listing_quantities(text)',
    'public.nyuma_assert_demand_hold(text)',
    'public.nyuma_assert_commitment_purchases(text)',
    'public.nyuma_assert_sold_link(text)',
    'public.nyuma_listings_check()',
    'public.nyuma_demands_check()',
    'public.nyuma_commitments_check()',
    'public.nyuma_purchases_check()',
    'public.nyuma_outcomes_check()',
    'public.nyuma_commitments_guard()',
    'public.nyuma_purchases_guard()',
    'public.nyuma_outcomes_guard()',
    'public.nyuma_guard_role_removal()',
    'public.nyuma_claim_coordination_id()',
    'public.nyuma_release_coordination_id()'
  ]
  LOOP
    EXECUTE format('ALTER FUNCTION %s SECURITY DEFINER', signature);
    EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, public', signature);
    EXECUTE format('ALTER FUNCTION %s OWNER TO nyuma_fn_constraint', signature);
  END LOOP;
END;
$owner$;

ALTER FUNCTION public.nyuma_clear_active_role(uuid, text) OWNER TO nyuma_fn_revoke;
ALTER FUNCTION public.nyuma_clear_active_role(uuid, text) SECURITY DEFINER;
ALTER FUNCTION public.nyuma_clear_active_role(uuid, text) SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION public.nyuma_lock_listing(text) FROM PUBLIC, nyuma_app;
REVOKE ALL ON FUNCTION public.nyuma_lock_demand(text) FROM PUBLIC, nyuma_app;
REVOKE ALL ON FUNCTION public.nyuma_lock_for_commitment(text, text) FROM PUBLIC, nyuma_app;
REVOKE ALL ON FUNCTION public.nyuma_lock_for_purchase(text) FROM PUBLIC, nyuma_app;
REVOKE ALL ON FUNCTION public.nyuma_lock_for_outcome(text, text) FROM PUBLIC, nyuma_app;
REVOKE ALL ON FUNCTION public.nyuma_listing_held_grams(text) FROM PUBLIC, nyuma_app;
REVOKE ALL ON FUNCTION public.nyuma_demand_held_grams(text) FROM PUBLIC, nyuma_app;
REVOKE ALL ON FUNCTION public.nyuma_listing_outcome_grams(text) FROM PUBLIC, nyuma_app;
REVOKE ALL ON FUNCTION public.nyuma_listing_accounted_grams(text) FROM PUBLIC, nyuma_app;
REVOKE ALL ON FUNCTION public.nyuma_assert_listing_quantities(text) FROM PUBLIC, nyuma_app;
REVOKE ALL ON FUNCTION public.nyuma_assert_demand_hold(text) FROM PUBLIC, nyuma_app;
REVOKE ALL ON FUNCTION public.nyuma_assert_commitment_purchases(text) FROM PUBLIC, nyuma_app;
REVOKE ALL ON FUNCTION public.nyuma_assert_sold_link(text) FROM PUBLIC, nyuma_app;
REVOKE ALL ON FUNCTION public.nyuma_clear_active_role(uuid, text) FROM PUBLIC, nyuma_app;

GRANT EXECUTE ON FUNCTION public.nyuma_lock_listing(text) TO nyuma_fn_constraint;
GRANT EXECUTE ON FUNCTION public.nyuma_lock_demand(text) TO nyuma_fn_constraint;
GRANT EXECUTE ON FUNCTION public.nyuma_lock_for_commitment(text, text) TO nyuma_fn_constraint;
GRANT EXECUTE ON FUNCTION public.nyuma_lock_for_purchase(text) TO nyuma_fn_constraint;
GRANT EXECUTE ON FUNCTION public.nyuma_lock_for_outcome(text, text) TO nyuma_fn_constraint;
GRANT EXECUTE ON FUNCTION public.nyuma_listing_held_grams(text) TO nyuma_fn_constraint;
GRANT EXECUTE ON FUNCTION public.nyuma_demand_held_grams(text) TO nyuma_fn_constraint;
GRANT EXECUTE ON FUNCTION public.nyuma_listing_outcome_grams(text) TO nyuma_fn_constraint;
GRANT EXECUTE ON FUNCTION public.nyuma_listing_accounted_grams(text) TO nyuma_fn_constraint;
GRANT EXECUTE ON FUNCTION public.nyuma_assert_listing_quantities(text) TO nyuma_fn_constraint;
GRANT EXECUTE ON FUNCTION public.nyuma_assert_demand_hold(text) TO nyuma_fn_constraint;
GRANT EXECUTE ON FUNCTION public.nyuma_assert_commitment_purchases(text) TO nyuma_fn_constraint;
GRANT EXECUTE ON FUNCTION public.nyuma_assert_sold_link(text) TO nyuma_fn_constraint;
GRANT EXECUTE ON FUNCTION public.nyuma_clear_active_role(uuid, text) TO nyuma_fn_revoke, nyuma_fn_constraint;
GRANT EXECUTE ON FUNCTION public.nyuma_guard_role_removal() TO nyuma_fn_revoke, nyuma_app, nyuma_provisioner;
GRANT EXECUTE ON FUNCTION public.nyuma_claim_coordination_id() TO nyuma_app;
GRANT EXECUTE ON FUNCTION public.nyuma_release_coordination_id() TO nyuma_app;
GRANT EXECUTE ON FUNCTION public.nyuma_listings_check() TO nyuma_app;
GRANT EXECUTE ON FUNCTION public.nyuma_demands_check() TO nyuma_app;
GRANT EXECUTE ON FUNCTION public.nyuma_commitments_check() TO nyuma_app;
GRANT EXECUTE ON FUNCTION public.nyuma_purchases_check() TO nyuma_app;
GRANT EXECUTE ON FUNCTION public.nyuma_outcomes_check() TO nyuma_app;
GRANT EXECUTE ON FUNCTION public.nyuma_commitments_guard() TO nyuma_app;
GRANT EXECUTE ON FUNCTION public.nyuma_purchases_guard() TO nyuma_app;
GRANT EXECUTE ON FUNCTION public.nyuma_outcomes_guard() TO nyuma_app;
GRANT EXECUTE ON FUNCTION public.nyuma_lock_user(uuid) TO nyuma_app, nyuma_fn_constraint;
GRANT EXECUTE ON FUNCTION public.nyuma_set_commitment_status(text, text) TO nyuma_app;
GRANT EXECUTE ON FUNCTION public.nyuma_insert_purchase(text, text, text, numeric, text, numeric, date) TO nyuma_app;
GRANT EXECUTE ON FUNCTION public.nyuma_set_active_role(uuid, text) TO nyuma_app;

ALTER FUNCTION public.nyuma_listings_guard() SET search_path = pg_catalog, public;
ALTER FUNCTION public.nyuma_demands_guard() SET search_path = pg_catalog, public;
ALTER FUNCTION public.nyuma_users_guard() SET search_path = pg_catalog, public;
ALTER FUNCTION public.nyuma_guard_administrator_role() SET search_path = pg_catalog, public;
ALTER FUNCTION public.nyuma_user_roles_no_update() SET search_path = pg_catalog, public;
ALTER FUNCTION public.nyuma_grams(numeric) SET search_path = pg_catalog, public;
ALTER FUNCTION public.nyuma_is_time_compatible(text, text) SET search_path = pg_catalog, public;

-- Default PUBLIC execute would let any later login call the trigger and quantity bodies.
REVOKE ALL ON FUNCTION public.nyuma_listings_check() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.nyuma_demands_check() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.nyuma_commitments_check() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.nyuma_purchases_check() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.nyuma_outcomes_check() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.nyuma_commitments_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.nyuma_purchases_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.nyuma_outcomes_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.nyuma_listings_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.nyuma_demands_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.nyuma_users_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.nyuma_guard_role_removal() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.nyuma_claim_coordination_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.nyuma_release_coordination_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.nyuma_guard_administrator_role() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.nyuma_user_roles_no_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.nyuma_grams(numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.nyuma_is_time_compatible(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.nyuma_grams(numeric) TO nyuma_app, nyuma_fn_constraint;
GRANT EXECUTE ON FUNCTION public.nyuma_is_time_compatible(text, text) TO nyuma_app, nyuma_fn_constraint;
GRANT EXECUTE ON FUNCTION public.nyuma_listings_guard() TO nyuma_app;
GRANT EXECUTE ON FUNCTION public.nyuma_demands_guard() TO nyuma_app;
GRANT EXECUTE ON FUNCTION public.nyuma_users_guard() TO nyuma_app;
GRANT EXECUTE ON FUNCTION public.nyuma_guard_administrator_role() TO nyuma_app, nyuma_fn_approve, nyuma_provisioner;
GRANT EXECUTE ON FUNCTION public.nyuma_user_roles_no_update() TO nyuma_app, nyuma_fn_approve, nyuma_fn_revoke, nyuma_provisioner;
