-- Rollback for 013_rls_predicates.sql. This file is not a forward migration.
-- It drops only the six helper functions added by 013.
-- Dependents are dropped before the functions they call.
-- It does not drop tables, policies, assertion keys, or tenant data.
-- It does not enable or force row level security.

DO $$
DECLARE
  v_migration_version text;
  v_migration_prefix numeric;
  v_migration_target constant integer := 13;
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'schema_migrations is missing. Refusing to guess at a rollback.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.schema_migrations WHERE version = '013_rls_predicates.sql'
  ) THEN
    RAISE EXCEPTION '013_rls_predicates.sql is not recorded. Refusing to roll back.';
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

DROP FUNCTION IF EXISTS public.nyuma_purchase_participant(text);
DROP FUNCTION IF EXISTS public.nyuma_outcome_listing_owner(text);
DROP FUNCTION IF EXISTS public.nyuma_outcome_buyer(text);
DROP FUNCTION IF EXISTS public.nyuma_commitment_participant(text);
DROP FUNCTION IF EXISTS public.nyuma_listing_owner_access(uuid);
DROP FUNCTION IF EXISTS public.nyuma_demand_owner_access(uuid);

DELETE FROM schema_migrations WHERE version = '013_rls_predicates.sql';
