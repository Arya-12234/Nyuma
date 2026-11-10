-- Stage A rollback. This file is not a forward migration.
-- Run with: psql -v ON_ERROR_STOP=1 -f server/migrations/rollback/005_stage_a_rollback.sql
--
-- Use it only before Stage B, and only when 006_stage_a_ownership.sql is not recorded.
-- If ownership has already moved to nyuma_owner, this script stops and changes nothing.
-- Restoring superuser ownership is not the Stage A rollback.
-- Do not drop users, listings, commitments, purchases, or outcomes.
-- Do not enable or disable row-level security.

DO $$
DECLARE
  v_migration_version text;
  v_migration_prefix numeric;
  -- Prefix 6 stays out of this comparison so 006 keeps the ownership refusal below.
  v_migration_target constant integer := 6;
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
      RAISE EXCEPTION 'A later migration is recorded. Do not roll Stage A back with this script.';
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM schema_migrations WHERE version = '006_stage_a_ownership.sql'
  ) THEN
    RAISE EXCEPTION 'Ownership already belongs to nyuma_owner. Restoring superuser ownership is not the Stage A rollback. Leave the owner in place.';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nyuma_api') THEN
    EXECUTE 'REVOKE nyuma_app FROM nyuma_api';
    EXECUTE 'REVOKE ALL ON SCHEMA public FROM nyuma_api';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nyuma_owner') THEN
    EXECUTE 'REVOKE nyuma_provisioner FROM nyuma_owner';
    EXECUTE 'REVOKE nyuma_operator FROM nyuma_owner';
    EXECUTE 'REVOKE nyuma_fn_request FROM nyuma_owner';
    EXECUTE 'REVOKE nyuma_fn_approve FROM nyuma_owner';
    EXECUTE 'REVOKE nyuma_fn_reject FROM nyuma_owner';
    EXECUTE 'REVOKE nyuma_fn_revoke FROM nyuma_owner';
    EXECUTE 'REVOKE nyuma_fn_identity FROM nyuma_owner';
    EXECUTE 'REVOKE nyuma_fn_constraint FROM nyuma_owner';
    EXECUTE 'REVOKE ALL ON SCHEMA public FROM nyuma_owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nyuma_fn_identity') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA public FROM nyuma_fn_identity';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nyuma_fn_constraint') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA public FROM nyuma_fn_constraint';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nyuma_api') THEN
    EXECUTE 'DROP ROLE nyuma_api';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nyuma_fn_identity') THEN
    EXECUTE 'DROP ROLE nyuma_fn_identity';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nyuma_fn_constraint') THEN
    EXECUTE 'DROP ROLE nyuma_fn_constraint';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nyuma_owner') THEN
    EXECUTE 'DROP ROLE nyuma_owner';
  END IF;

  DELETE FROM schema_migrations WHERE version = '005_stage_a_roles.sql';
END;
$$;
