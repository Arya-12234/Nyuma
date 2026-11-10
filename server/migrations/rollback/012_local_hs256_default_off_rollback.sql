-- Rollback for 012_local_hs256_default_off.sql. This file is not a forward migration.
-- It restores the Milestone 3 verifier and drops only the flag column added by 012.
-- It does not drop assertion keys, verifier rows, or other existing data.

DO $$
DECLARE
  v_migration_version text;
  v_migration_prefix numeric;
  v_migration_target constant integer := 12;
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'schema_migrations is missing. Refusing to guess at a rollback.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.schema_migrations WHERE version = '012_local_hs256_default_off.sql'
  ) THEN
    RAISE EXCEPTION '012_local_hs256_default_off.sql is not recorded. Refusing to roll back.';
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
CREATE OR REPLACE FUNCTION public.nyuma_verified_sub() RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, nyuma_private, pg_temp
AS $fn$
DECLARE
  token text;
  parts text[];
  header jsonb;
  payload jsonb;
  alg text;
  kid text;
  secret text;
  key_count integer;
  expected bytea;
  actual bytea;
  issuer text;
  audience text;
  exp_at timestamptz;
  nbf_at timestamptz;
  sub_text text;
BEGIN
  token := current_setting('nyuma.access_token', true);
  IF token IS NULL OR octet_length(token) > 8192 THEN
    RETURN NULL;
  END IF;
  -- A nya1 value is only the assertion branch. A failed assertion is not an HS256 token.
  IF left(token, 4) = 'nya1' THEN
    RETURN nyuma_private.verify_nya1_subject(token);
  END IF;

  IF token IS NULL OR btrim(token) = '' OR length(token) > 8192 THEN
    RETURN NULL;
  END IF;
  parts := string_to_array(token, '.');
  IF cardinality(parts) <> 3 OR parts[1] = '' OR parts[2] = '' OR parts[3] = '' THEN
    RETURN NULL;
  END IF;
  header := convert_from(nyuma_private.base64url_decode(parts[1]), 'utf8')::jsonb;
  IF jsonb_typeof(header) <> 'object' OR header ? 'crit' THEN
    RETURN NULL;
  END IF;
  alg := header->>'alg';
  -- ES256, RS256, none, and every algorithm other than local HS256 fail closed.
  IF alg IS DISTINCT FROM 'HS256' THEN
    RETURN NULL;
  END IF;
  kid := header->>'kid';
  payload := convert_from(nyuma_private.base64url_decode(parts[2]), 'utf8')::jsonb;
  IF jsonb_typeof(payload) <> 'object' THEN
    RETURN NULL;
  END IF;

  SELECT config.issuer, config.audience
    INTO issuer, audience
  FROM nyuma_private.verifier_config AS config
  WHERE config.id;

  IF issuer IS NULL OR audience IS NULL THEN
    RETURN NULL;
  END IF;

  IF kid IS NULL OR kid = '' THEN
    SELECT count(*)::integer, min(keys.secret)
      INTO key_count, secret
    FROM nyuma_private.local_test_hmac_keys AS keys
    WHERE keys.retired_at IS NULL;
    IF key_count IS DISTINCT FROM 1 THEN
      RETURN NULL;
    END IF;
  ELSE
    SELECT keys.secret
      INTO secret
    FROM nyuma_private.local_test_hmac_keys AS keys
    WHERE keys.kid = kid
      AND keys.retired_at IS NULL;
  END IF;
  IF secret IS NULL THEN
    RETURN NULL;
  END IF;

  expected := hmac(convert_to(parts[1] || '.' || parts[2], 'utf8'), convert_to(secret, 'utf8'), 'sha256');
  actual := nyuma_private.base64url_decode(parts[3]);
  IF expected IS DISTINCT FROM actual OR octet_length(expected) IS DISTINCT FROM octet_length(actual) THEN
    RETURN NULL;
  END IF;

  IF payload->>'role' IS DISTINCT FROM 'authenticated' THEN
    RETURN NULL;
  END IF;
  IF payload->>'iss' IS DISTINCT FROM issuer THEN
    RETURN NULL;
  END IF;
  IF jsonb_typeof(payload->'aud') = 'string' THEN
    IF payload->>'aud' IS DISTINCT FROM audience THEN
      RETURN NULL;
    END IF;
  ELSIF jsonb_typeof(payload->'aud') = 'array' THEN
    IF NOT (payload->'aud' ? audience) THEN
      RETURN NULL;
    END IF;
  ELSE
    RETURN NULL;
  END IF;
  IF payload->>'exp' IS NULL OR payload->>'exp' !~ '^[0-9]+(\.[0-9]+)?$' THEN
    RETURN NULL;
  END IF;
  exp_at := to_timestamp((payload->>'exp')::double precision);
  IF exp_at <= clock_timestamp() THEN
    RETURN NULL;
  END IF;
  IF payload ? 'nbf' THEN
    IF payload->>'nbf' !~ '^[0-9]+(\.[0-9]+)?$' THEN
      RETURN NULL;
    END IF;
    nbf_at := to_timestamp((payload->>'nbf')::double precision);
    IF nbf_at > clock_timestamp() THEN
      RETURN NULL;
    END IF;
  END IF;
  sub_text := payload->>'sub';
  IF sub_text IS NULL OR sub_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RETURN NULL;
  END IF;
  RETURN sub_text::uuid;
EXCEPTION
  WHEN query_canceled OR admin_shutdown THEN
    RAISE;
  WHEN OTHERS THEN
    RETURN NULL;
END;
$fn$;

ALTER FUNCTION public.nyuma_verified_sub() OWNER TO nyuma_fn_identity;
REVOKE ALL ON FUNCTION public.nyuma_verified_sub() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.nyuma_verified_sub() TO nyuma_app;

ALTER TABLE nyuma_private.verifier_config DROP COLUMN IF EXISTS local_hs256_enabled;

DELETE FROM schema_migrations WHERE version = '012_local_hs256_default_off.sql';
