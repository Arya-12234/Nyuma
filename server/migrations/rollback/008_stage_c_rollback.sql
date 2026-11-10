-- Stage C rollback. This file is not a forward migration.
-- Run with: psql -v ON_ERROR_STOP=1 -f server/migrations/rollback/008_stage_c_rollback.sql
--
-- Restores the Stage B function bodies, invoker triggers, owners, and execute grants.
-- Does not drop users, listings, commitments, purchases, outcomes, or role requests.
-- Does not enable or disable row-level security.
-- Stop the API before running this. An API that still expects the token check will fail closed.

DO $$
DECLARE
  v_migration_version text;
  v_migration_prefix numeric;
  v_migration_target constant integer := 8;
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
      RAISE EXCEPTION 'A later migration is recorded. Do not roll Stage C back with this script.';
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.nyuma_lock_user(p_user_id uuid) RETURNS void
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

CREATE OR REPLACE FUNCTION public.nyuma_set_commitment_status(p_id text, p_status text) RETURNS void
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
BEGIN
  PERFORM nyuma_lock_for_purchase(p_commitment_id);
  INSERT INTO purchases (
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
BEGIN
  IF p_role NOT IN ('farmer', 'trader', 'buyer', 'administrator')
     OR NOT EXISTS (
       SELECT 1 FROM user_roles WHERE user_id = p_user_id AND role = p_role
     ) THEN
    RAISE EXCEPTION 'That workspace is not assigned to this account.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE users
  SET active_role = p_role, updated_at = clock_timestamp()
  WHERE id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Account % does not exist.', p_user_id USING ERRCODE = '23503';
  END IF;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.nyuma_guard_role_removal() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
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
  PERFORM nyuma_clear_active_role(OLD.user_id, OLD.role);
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
  IF p_auth_user_id IS NULL THEN
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
ALTER FUNCTION public.nyuma_guard_role_removal() SECURITY INVOKER;
ALTER FUNCTION public.nyuma_guard_role_removal() OWNER TO nyuma_owner;

DO $owner$
DECLARE
  signature text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
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
    'public.nyuma_claim_coordination_id()',
    'public.nyuma_release_coordination_id()'
  ]
  LOOP
    EXECUTE format('ALTER FUNCTION %s SECURITY INVOKER', signature);
    EXECUTE format('ALTER FUNCTION %s OWNER TO nyuma_owner', signature);
  END LOOP;
END;
$owner$;

ALTER FUNCTION public.nyuma_lock_user(uuid) OWNER TO nyuma_owner;
ALTER FUNCTION public.nyuma_lock_listing(text) OWNER TO nyuma_owner;
ALTER FUNCTION public.nyuma_lock_demand(text) OWNER TO nyuma_owner;
ALTER FUNCTION public.nyuma_lock_for_commitment(text, text) OWNER TO nyuma_owner;
ALTER FUNCTION public.nyuma_lock_for_purchase(text) OWNER TO nyuma_owner;
ALTER FUNCTION public.nyuma_lock_for_outcome(text, text) OWNER TO nyuma_owner;
ALTER FUNCTION public.nyuma_set_commitment_status(text, text) OWNER TO nyuma_owner;
ALTER FUNCTION public.nyuma_insert_purchase(text, text, text, numeric, text, numeric, date) OWNER TO nyuma_owner;
ALTER FUNCTION public.nyuma_set_active_role(uuid, text) OWNER TO nyuma_owner;
ALTER FUNCTION public.nyuma_clear_active_role(uuid, text) OWNER TO nyuma_owner;

GRANT EXECUTE ON FUNCTION public.nyuma_lock_listing(text) TO nyuma_app;
GRANT EXECUTE ON FUNCTION public.nyuma_lock_demand(text) TO nyuma_app;
GRANT EXECUTE ON FUNCTION public.nyuma_lock_for_commitment(text, text) TO nyuma_app;
GRANT EXECUTE ON FUNCTION public.nyuma_lock_for_purchase(text) TO nyuma_app;
GRANT EXECUTE ON FUNCTION public.nyuma_lock_for_outcome(text, text) TO nyuma_app;
GRANT EXECUTE ON FUNCTION public.nyuma_listing_held_grams(text) TO nyuma_app;
GRANT EXECUTE ON FUNCTION public.nyuma_demand_held_grams(text) TO nyuma_app;
GRANT EXECUTE ON FUNCTION public.nyuma_listing_outcome_grams(text) TO nyuma_app;
GRANT EXECUTE ON FUNCTION public.nyuma_listing_accounted_grams(text) TO nyuma_app;
GRANT EXECUTE ON FUNCTION public.nyuma_assert_listing_quantities(text) TO nyuma_app;
GRANT EXECUTE ON FUNCTION public.nyuma_assert_demand_hold(text) TO nyuma_app;
GRANT EXECUTE ON FUNCTION public.nyuma_assert_commitment_purchases(text) TO nyuma_app;
GRANT EXECUTE ON FUNCTION public.nyuma_assert_sold_link(text) TO nyuma_app;
GRANT EXECUTE ON FUNCTION public.nyuma_clear_active_role(uuid, text) TO nyuma_app;

REVOKE SELECT, INSERT, UPDATE, DELETE ON
  users,
  user_roles,
  coordination_ids,
  listings,
  buyer_demands,
  commitments,
  purchases,
  outcomes
FROM nyuma_fn_constraint;
REVOKE UPDATE ON users FROM nyuma_fn_revoke;
GRANT EXECUTE ON FUNCTION public.nyuma_listings_check() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.nyuma_demands_check() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.nyuma_commitments_check() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.nyuma_purchases_check() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.nyuma_outcomes_check() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.nyuma_commitments_guard() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.nyuma_purchases_guard() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.nyuma_outcomes_guard() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.nyuma_listings_guard() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.nyuma_demands_guard() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.nyuma_users_guard() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.nyuma_guard_role_removal() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.nyuma_guard_administrator_role() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.nyuma_user_roles_no_update() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.nyuma_claim_coordination_id() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.nyuma_release_coordination_id() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.nyuma_grams(numeric) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.nyuma_is_time_compatible(text, text) TO PUBLIC;
REVOKE EXECUTE ON FUNCTION public.nyuma_grams(numeric) FROM nyuma_fn_constraint;
REVOKE EXECUTE ON FUNCTION public.nyuma_is_time_compatible(text, text) FROM nyuma_fn_constraint;
REVOKE EXECUTE ON FUNCTION public.nyuma_verified_sub() FROM nyuma_fn_constraint, nyuma_fn_request;
REVOKE EXECUTE ON FUNCTION public.nyuma_verified_account_id() FROM nyuma_fn_constraint, nyuma_fn_request;
REVOKE EXECUTE ON FUNCTION public.nyuma_account_status() FROM nyuma_fn_constraint, nyuma_fn_request;

DELETE FROM schema_migrations WHERE version = '008_stage_c_functions.sql';
