-- Stage D rollback. This file is not a forward migration.
-- Run with: psql -v ON_ERROR_STOP=1 -f server/migrations/rollback/009_stage_d_rollback.sql
--
-- Restores the direct table privileges revoked by Stage D and the previous guard bodies.
-- Drops nyuma_insert_commitment and nyuma_insert_outcome.
-- Does not drop users, listings, commitments, purchases, outcomes, or role requests.
-- Does not enable or disable row-level security. Does not return ownership to the superuser.
-- Stop the API before running this. An API that still calls the Stage D functions will fail.

DO $$
DECLARE
  v_migration_version text;
  v_migration_prefix numeric;
  v_migration_target constant integer := 9;
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
      RAISE EXCEPTION 'A later migration is recorded. Do not roll Stage D back with this script.';
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.nyuma_listings_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
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

CREATE OR REPLACE FUNCTION public.nyuma_demands_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
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

CREATE OR REPLACE FUNCTION public.nyuma_users_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
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
BEGIN
  DELETE FROM public.coordination_ids WHERE id = OLD.id AND collection = TG_ARGV[0];
  RETURN OLD;
END;
$fn$;

GRANT INSERT, DELETE ON public.commitments TO nyuma_app;
GRANT INSERT, UPDATE, DELETE ON public.purchases TO nyuma_app;
GRANT INSERT, UPDATE, DELETE ON public.outcomes TO nyuma_app;
GRANT DELETE ON public.users TO nyuma_app;
GRANT INSERT, UPDATE, DELETE ON public.coordination_ids TO nyuma_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO nyuma_app;
GRANT EXECUTE ON FUNCTION public.nyuma_grams(numeric) TO nyuma_app;
GRANT EXECUTE ON FUNCTION public.nyuma_is_time_compatible(text, text) TO nyuma_app;

REVOKE INSERT ON public.commitments, public.outcomes FROM nyuma_fn_constraint;

DROP FUNCTION IF EXISTS public.nyuma_insert_commitment(text, text, text, numeric, numeric, date, text);
DROP FUNCTION IF EXISTS public.nyuma_insert_outcome(text, text, text, text, numeric, date, text);

DELETE FROM schema_migrations WHERE version = '009_stage_d_grants.sql';
