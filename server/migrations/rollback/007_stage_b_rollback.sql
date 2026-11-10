-- Stage B rollback. This file is not a forward migration.
-- Run with: psql -v ON_ERROR_STOP=1 -f server/migrations/rollback/007_stage_b_rollback.sql
--
-- Drops the verifier, pgcrypto, and nyuma_private. Does not drop Stage A roles.
-- Does not drop users, listings, commitments, purchases, or outcomes.
-- Does not enable or disable row-level security.
-- Revert the pool helper in source control in the same change. Coordination function bodies are unchanged.

DO $$
DECLARE
  v_migration_version text;
  v_migration_prefix numeric;
  v_migration_target constant integer := 7;
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
      RAISE EXCEPTION 'A later migration is recorded. Do not roll Stage B back with this script.';
    END IF;
  END LOOP;

  DROP FUNCTION IF EXISTS public.nyuma_account_status();
  DROP FUNCTION IF EXISTS public.nyuma_verified_account_id();
  DROP FUNCTION IF EXISTS public.nyuma_verified_sub();
  DROP FUNCTION IF EXISTS public.nyuma_identity_verification_mode();

  DROP EXTENSION IF EXISTS pgcrypto;
  DROP SCHEMA IF EXISTS nyuma_private CASCADE;

  DELETE FROM schema_migrations WHERE version = '007_stage_b_identity.sql';
END;
$$;
