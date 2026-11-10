-- Milestone 3B. Local HS256 is off unless an operator sets the database flag.
-- The switch is a column on nyuma_private.verifier_config. It is not a GUC.
-- This file does not enable RLS, insert an assertion key, or grant nyuma_api a privilege.

ALTER TABLE nyuma_private.verifier_config
  ADD COLUMN local_hs256_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN nyuma_private.verifier_config.local_hs256_enabled IS
  'Local HS256 test switch. False rejects every non-nya1 token. nyuma_api cannot change it.';

-- The boolean primary key already allows only the true singleton.
INSERT INTO nyuma_private.verifier_config (id, issuer, audience, local_hs256_enabled)
VALUES (true, 'https://example-project.supabase.co/auth/v1', 'authenticated', false)
ON CONFLICT (id) DO UPDATE SET local_hs256_enabled = false;

REVOKE ALL ON TABLE nyuma_private.verifier_config FROM PUBLIC, nyuma_api, nyuma_app;
ALTER TABLE nyuma_private.verifier_config OWNER TO nyuma_fn_identity;

CREATE OR REPLACE FUNCTION public.nyuma_verified_sub() RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, nyuma_private, pg_temp
AS $fn$
DECLARE
  v_token text;
  v_parts text[];
  v_header jsonb;
  v_payload jsonb;
  v_alg text;
  v_key_id text;
  v_secret text;
  v_key_count integer;
  v_expected bytea;
  v_actual bytea;
  v_issuer text;
  v_audience text;
  v_exp_at timestamptz;
  v_nbf_at timestamptz;
  v_subject text;
  v_hs256_enabled boolean;
BEGIN
  v_token := current_setting('nyuma.access_token', true);
  IF v_token IS NULL OR octet_length(v_token) > 8192 THEN
    RETURN NULL;
  END IF;
  -- A nya1 value is only the assertion branch. A failed assertion is not an HS256 token.
  IF left(v_token, 4) = 'nya1' THEN
    RETURN nyuma_private.verify_nya1_subject(v_token);
  END IF;

  SELECT config.local_hs256_enabled
    INTO v_hs256_enabled
  FROM nyuma_private.verifier_config AS config
  WHERE config.id;
  -- A missing row leaves the variable null. Null and false both fail closed.
  IF v_hs256_enabled IS NOT TRUE THEN
    RETURN NULL;
  END IF;

  IF btrim(v_token) = '' OR length(v_token) > 8192 THEN
    RETURN NULL;
  END IF;
  v_parts := string_to_array(v_token, '.');
  IF cardinality(v_parts) <> 3 OR v_parts[1] = '' OR v_parts[2] = '' OR v_parts[3] = '' THEN
    RETURN NULL;
  END IF;
  v_header := convert_from(nyuma_private.base64url_decode(v_parts[1]), 'utf8')::jsonb;
  IF jsonb_typeof(v_header) <> 'object' OR v_header ? 'crit' THEN
    RETURN NULL;
  END IF;
  v_alg := v_header->>'alg';
  -- ES256, RS256, none, and every algorithm other than local HS256 fail closed.
  IF v_alg IS DISTINCT FROM 'HS256' THEN
    RETURN NULL;
  END IF;
  v_key_id := v_header->>'kid';
  v_payload := convert_from(nyuma_private.base64url_decode(v_parts[2]), 'utf8')::jsonb;
  IF jsonb_typeof(v_payload) <> 'object' THEN
    RETURN NULL;
  END IF;

  SELECT config.issuer, config.audience
    INTO v_issuer, v_audience
  FROM nyuma_private.verifier_config AS config
  WHERE config.id;

  IF v_issuer IS NULL OR v_audience IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_key_id IS NULL OR v_key_id = '' THEN
    SELECT count(*)::integer, min(keys.secret)
      INTO v_key_count, v_secret
    FROM nyuma_private.local_test_hmac_keys AS keys
    WHERE keys.retired_at IS NULL;
    IF v_key_count IS DISTINCT FROM 1 THEN
      RETURN NULL;
    END IF;
  ELSE
    SELECT keys.secret
      INTO v_secret
    FROM nyuma_private.local_test_hmac_keys AS keys
    WHERE keys.kid = v_key_id
      AND keys.retired_at IS NULL;
  END IF;
  IF v_secret IS NULL THEN
    RETURN NULL;
  END IF;

  v_expected := hmac(convert_to(v_parts[1] || '.' || v_parts[2], 'utf8'), convert_to(v_secret, 'utf8'), 'sha256');
  v_actual := nyuma_private.base64url_decode(v_parts[3]);
  IF v_expected IS DISTINCT FROM v_actual OR octet_length(v_expected) IS DISTINCT FROM octet_length(v_actual) THEN
    RETURN NULL;
  END IF;

  IF v_payload->>'role' IS DISTINCT FROM 'authenticated' THEN
    RETURN NULL;
  END IF;
  IF v_payload->>'iss' IS DISTINCT FROM v_issuer THEN
    RETURN NULL;
  END IF;
  IF jsonb_typeof(v_payload->'aud') = 'string' THEN
    IF v_payload->>'aud' IS DISTINCT FROM v_audience THEN
      RETURN NULL;
    END IF;
  ELSIF jsonb_typeof(v_payload->'aud') = 'array' THEN
    IF NOT (v_payload->'aud' ? v_audience) THEN
      RETURN NULL;
    END IF;
  ELSE
    RETURN NULL;
  END IF;
  IF v_payload->>'exp' IS NULL OR v_payload->>'exp' !~ '^[0-9]+(\.[0-9]+)?$' THEN
    RETURN NULL;
  END IF;
  v_exp_at := to_timestamp((v_payload->>'exp')::double precision);
  IF v_exp_at <= clock_timestamp() THEN
    RETURN NULL;
  END IF;
  IF v_payload ? 'nbf' THEN
    IF v_payload->>'nbf' !~ '^[0-9]+(\.[0-9]+)?$' THEN
      RETURN NULL;
    END IF;
    v_nbf_at := to_timestamp((v_payload->>'nbf')::double precision);
    IF v_nbf_at > clock_timestamp() THEN
      RETURN NULL;
    END IF;
  END IF;
  v_subject := v_payload->>'sub';
  IF v_subject IS NULL OR v_subject !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RETURN NULL;
  END IF;
  RETURN v_subject::uuid;
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
