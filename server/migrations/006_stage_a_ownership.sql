-- Stage A ownership. Moves existing public objects off any superuser.
-- No RLS, no policy, no grant revoke, no function body change, no coordination data change.
-- Functions already owned by nyuma_fn_request, nyuma_fn_approve, nyuma_fn_reject, or nyuma_fn_revoke stay there.
-- Security-definer functions move to nyuma_owner and then execute as that non-superuser table owner.
-- Later stages may move specific functions to nyuma_fn_constraint. This stage does not.

GRANT USAGE, CREATE ON SCHEMA public TO nyuma_owner;
GRANT USAGE ON SCHEMA public TO nyuma_api;
GRANT USAGE ON SCHEMA public TO nyuma_fn_identity;
GRANT USAGE ON SCHEMA public TO nyuma_fn_constraint;

DO $$
DECLARE
  object_name record;
BEGIN
  FOR object_name IN
    SELECT n.nspname, c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_roles owner_role ON owner_role.oid = c.relowner
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
      AND owner_role.rolsuper
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I OWNER TO nyuma_owner',
      object_name.nspname,
      object_name.relname
    );
  END LOOP;

  FOR object_name IN
    SELECT n.nspname, c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_roles owner_role ON owner_role.oid = c.relowner
    WHERE n.nspname = 'public'
      AND c.relkind = 'i'
      AND owner_role.rolsuper
  LOOP
    EXECUTE format(
      'ALTER INDEX %I.%I OWNER TO nyuma_owner',
      object_name.nspname,
      object_name.relname
    );
  END LOOP;

  FOR object_name IN
    SELECT n.nspname, t.typname
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    JOIN pg_roles owner_role ON owner_role.oid = t.typowner
    WHERE n.nspname = 'public'
      AND t.typtype IN ('c', 'e', 'd')
      AND owner_role.rolsuper
      AND NOT EXISTS (
        SELECT 1
        FROM pg_depend d
        WHERE d.objid = t.oid
          AND d.deptype = 'e'
      )
  LOOP
    EXECUTE format(
      'ALTER TYPE %I.%I OWNER TO nyuma_owner',
      object_name.nspname,
      object_name.typname
    );
  END LOOP;

  FOR object_name IN
    SELECT p.oid::regprocedure AS signature, p.prokind
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_roles owner_role ON owner_role.oid = p.proowner
    WHERE n.nspname = 'public'
      AND owner_role.rolsuper
      AND NOT EXISTS (
        SELECT 1
        FROM pg_depend d
        WHERE d.objid = p.oid
          AND d.deptype = 'e'
      )
  LOOP
    IF object_name.prokind = 'p' THEN
      EXECUTE format('ALTER PROCEDURE %s OWNER TO nyuma_owner', object_name.signature);
    ELSE
      EXECUTE format('ALTER FUNCTION %s OWNER TO nyuma_owner', object_name.signature);
    END IF;
  END LOOP;
END;
$$;
