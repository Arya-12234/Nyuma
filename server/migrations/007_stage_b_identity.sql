-- Stage B. Transaction-scoped bearer verification.
-- pgcrypto 1.4 verifies HMAC-SHA256 only. It does not verify ES256 or RS256.
-- No production signing secret is stored in this file. A local test inserts its own secret.
-- This file does not enable RLS, revoke Stage A grants, or change coordination function bodies.
-- nyuma.user_id is not an identity input.

CREATE SCHEMA nyuma_private;
REVOKE ALL ON SCHEMA nyuma_private FROM PUBLIC, nyuma_app, nyuma_api;
CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA nyuma_private;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA nyuma_private FROM PUBLIC;
GRANT USAGE ON SCHEMA nyuma_private TO nyuma_fn_identity;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA nyuma_private TO nyuma_fn_identity;
ALTER SCHEMA nyuma_private OWNER TO nyuma_fn_identity;

CREATE TABLE nyuma_private.verifier_config (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  issuer text NOT NULL,
  audience text NOT NULL,
  CHECK (issuer <> ''),
  CHECK (audience <> '')
);

CREATE TABLE nyuma_private.local_test_hmac_keys (
  kid text PRIMARY KEY,
  secret text NOT NULL,
  retired_at timestamptz,
  CHECK (octet_length(secret) >= 32),
  CHECK (kid <> '')
);

CREATE TABLE nyuma_private.jwt_public_keys (
  kid text PRIMARY KEY,
  alg text NOT NULL,
  public_jwk jsonb NOT NULL,
  retired_at timestamptz,
  CHECK (alg IN ('ES256', 'RS256')),
  CHECK (kid <> '')
);

COMMENT ON TABLE nyuma_private.jwt_public_keys IS
  'Reserved for a future pinned ES256 or RS256 verifier. Stage B does not accept those algorithms, even when a row is present.';

COMMENT ON TABLE nyuma_private.local_test_hmac_keys IS
  'Local HS256 test keys only. This is not a production signing secret and must not be copied from SUPABASE_JWT_SECRET.';

REVOKE ALL ON TABLE nyuma_private.verifier_config FROM PUBLIC;
REVOKE ALL ON TABLE nyuma_private.local_test_hmac_keys FROM PUBLIC;
REVOKE ALL ON TABLE nyuma_private.jwt_public_keys FROM PUBLIC;
ALTER TABLE nyuma_private.verifier_config OWNER TO nyuma_fn_identity;
ALTER TABLE nyuma_private.local_test_hmac_keys OWNER TO nyuma_fn_identity;
ALTER TABLE nyuma_private.jwt_public_keys OWNER TO nyuma_fn_identity;

CREATE FUNCTION nyuma_private.base64url_decode(input text) RETURNS bytea
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
DECLARE
  normalized text;
  pad integer;
BEGIN
  IF input IS NULL OR input = '' OR input ~ '[^A-Za-z0-9_-]' THEN
    RAISE EXCEPTION 'malformed base64url' USING ERRCODE = '22023';
  END IF;
  normalized := translate(input, '-_', '+/');
  pad := (4 - length(normalized) % 4) % 4;
  normalized := normalized || repeat('=', pad);
  RETURN decode(normalized, 'base64');
END;
$fn$;

ALTER FUNCTION nyuma_private.base64url_decode(text) OWNER TO nyuma_fn_identity;
REVOKE ALL ON FUNCTION nyuma_private.base64url_decode(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nyuma_private.base64url_decode(text) TO nyuma_fn_identity;

CREATE FUNCTION public.nyuma_identity_verification_mode() RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
  SELECT 'local-hs256-test; production-es256-rs256-disabled'::text;
$fn$;

CREATE FUNCTION public.nyuma_verified_sub() RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, nyuma_private
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

CREATE FUNCTION public.nyuma_verified_account_id() RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
  SELECT users.id
  FROM public.users AS users
  WHERE users.auth_user_id = public.nyuma_verified_sub()
    AND users.status = 'active';
$fn$;

CREATE FUNCTION public.nyuma_account_status() RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
  SELECT users.status
  FROM public.users AS users
  WHERE users.auth_user_id = public.nyuma_verified_sub();
$fn$;

ALTER FUNCTION public.nyuma_identity_verification_mode() OWNER TO nyuma_fn_identity;
ALTER FUNCTION public.nyuma_verified_sub() OWNER TO nyuma_fn_identity;
ALTER FUNCTION public.nyuma_verified_account_id() OWNER TO nyuma_fn_identity;
ALTER FUNCTION public.nyuma_account_status() OWNER TO nyuma_fn_identity;

REVOKE ALL ON FUNCTION public.nyuma_identity_verification_mode() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.nyuma_verified_sub() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.nyuma_verified_account_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.nyuma_account_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.nyuma_identity_verification_mode() TO nyuma_app;
GRANT EXECUTE ON FUNCTION public.nyuma_verified_sub() TO nyuma_app;
GRANT EXECUTE ON FUNCTION public.nyuma_verified_account_id() TO nyuma_app;
GRANT EXECUTE ON FUNCTION public.nyuma_account_status() TO nyuma_app;

GRANT SELECT ON TABLE public.users TO nyuma_fn_identity;
