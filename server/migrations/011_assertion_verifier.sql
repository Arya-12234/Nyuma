-- Milestone 3. PostgreSQL verification of nya1 assertions.
-- This file creates the key table and inserts nothing. An operator provisions keys.
-- It does not enable RLS, grant nyuma_api access to nyuma_private, or remove the HS256 test path.

CREATE TABLE nyuma_private.assertion_keys (
  kid text PRIMARY KEY,
  secret bytea,
  state text NOT NULL,
  CHECK (state IN ('active', 'retiring', 'retired')),
  CHECK (kid ~ '^[A-Za-z0-9_-]{1,64}$'),
  CHECK (
    (state IN ('active', 'retiring') AND octet_length(secret) = 32)
    OR (state = 'retired' AND secret IS NULL)
  )
);

COMMENT ON TABLE nyuma_private.assertion_keys IS
  'Assertion verification keys. nyuma_api cannot read or write this table. A retired row keeps no secret.';

REVOKE ALL ON TABLE nyuma_private.assertion_keys FROM PUBLIC, nyuma_api, nyuma_app;
ALTER TABLE nyuma_private.assertion_keys OWNER TO nyuma_fn_identity;

CREATE FUNCTION nyuma_private.base64url_encode(input bytea) RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT translate(
    rtrim(regexp_replace(encode(input, 'base64'), '[[:space:]]', '', 'g'), '='),
    '+/',
    '-_'
  );
$fn$;

ALTER FUNCTION nyuma_private.base64url_encode(bytea) OWNER TO nyuma_fn_identity;
REVOKE ALL ON FUNCTION nyuma_private.base64url_encode(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nyuma_private.base64url_encode(bytea) TO nyuma_fn_identity;

CREATE FUNCTION nyuma_private.verify_nya1_subject(token text) RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, nyuma_private, pg_temp
AS $fn$
DECLARE
  parts text[];
  payload bytea;
  mac bytea;
  expected bytea;
  pos integer;
  field_index integer;
  field_length integer;
  field_bytes bytea[];
  kid_text text;
  iss_text text;
  aud_text text;
  sub_text text;
  iat_text text;
  exp_text text;
  nbf_text text;
  jti_text text;
  iat_value bigint;
  exp_value bigint;
  nbf_value bigint;
  now_s bigint;
  secret bytea;
  state text;
  mismatch integer;
  byte_index integer;
BEGIN
  IF token IS NULL OR token = '' OR octet_length(token) > 8192 OR token IS DISTINCT FROM btrim(token) THEN
    RETURN NULL;
  END IF;
  IF left(token, 4) IS DISTINCT FROM 'nya1' THEN
    RETURN NULL;
  END IF;
  parts := string_to_array(token, '.');
  IF cardinality(parts) <> 3 OR parts[1] IS DISTINCT FROM 'nya1' OR parts[2] = '' OR parts[3] = '' THEN
    RETURN NULL;
  END IF;
  IF parts[2] !~ '^[A-Za-z0-9_-]+$' OR parts[3] !~ '^[A-Za-z0-9_-]+$' THEN
    RETURN NULL;
  END IF;
  payload := nyuma_private.base64url_decode(parts[2]);
  mac := nyuma_private.base64url_decode(parts[3]);
  IF nyuma_private.base64url_encode(payload) IS DISTINCT FROM parts[2]
     OR nyuma_private.base64url_encode(mac) IS DISTINCT FROM parts[3]
     OR octet_length(mac) IS DISTINCT FROM 32 THEN
    RETURN NULL;
  END IF;
  IF octet_length(payload) < 4 OR substring(payload FROM 1 FOR 4) IS DISTINCT FROM '\x6e796131'::bytea THEN
    RETURN NULL;
  END IF;

  pos := 4;
  field_bytes := ARRAY[]::bytea[];
  FOR field_index IN 1..8 LOOP
    IF pos + 2 > octet_length(payload) THEN
      RETURN NULL;
    END IF;
    field_length := get_byte(payload, pos) * 256 + get_byte(payload, pos + 1);
    pos := pos + 2;
    IF pos + field_length > octet_length(payload) THEN
      RETURN NULL;
    END IF;
    field_bytes[field_index] := substring(payload FROM pos + 1 FOR field_length);
    pos := pos + field_length;
  END LOOP;
  IF pos <> octet_length(payload) OR cardinality(field_bytes) IS DISTINCT FROM 8 THEN
    RETURN NULL;
  END IF;

  kid_text := convert_from(field_bytes[1], 'UTF8');
  iss_text := convert_from(field_bytes[2], 'UTF8');
  aud_text := convert_from(field_bytes[3], 'UTF8');
  sub_text := convert_from(field_bytes[4], 'UTF8');
  iat_text := convert_from(field_bytes[5], 'UTF8');
  exp_text := convert_from(field_bytes[6], 'UTF8');
  nbf_text := convert_from(field_bytes[7], 'UTF8');
  jti_text := convert_from(field_bytes[8], 'UTF8');

  IF kid_text !~ '^[A-Za-z0-9_-]{1,64}$' THEN
    RETURN NULL;
  END IF;

  SELECT keys.secret, keys.state
    INTO secret, state
  FROM nyuma_private.assertion_keys AS keys
  WHERE keys.kid = kid_text;
  IF secret IS NULL OR octet_length(secret) IS DISTINCT FROM 32
     OR (state IS DISTINCT FROM 'active' AND state IS DISTINCT FROM 'retiring') THEN
    RETURN NULL;
  END IF;

  expected := nyuma_private.hmac(payload, secret, 'sha256');
  IF expected IS NULL OR octet_length(expected) IS DISTINCT FROM 32 THEN
    RETURN NULL;
  END IF;
  mismatch := 0;
  FOR byte_index IN 0..31 LOOP
    mismatch := mismatch + (get_byte(expected, byte_index) # get_byte(mac, byte_index));
  END LOOP;
  IF mismatch <> 0 THEN
    RETURN NULL;
  END IF;

  IF octet_length(field_bytes[2]) IS DISTINCT FROM 15 OR iss_text IS DISTINCT FROM 'nyuma-assertion' THEN
    RETURN NULL;
  END IF;
  IF octet_length(field_bytes[3]) IS DISTINCT FROM 8 OR aud_text IS DISTINCT FROM 'nyuma-db' THEN
    RETURN NULL;
  END IF;
  IF octet_length(field_bytes[4]) IS DISTINCT FROM 36
     OR sub_text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RETURN NULL;
  END IF;
  IF iat_text !~ '^(0|[1-9][0-9]{0,19})$' OR exp_text !~ '^(0|[1-9][0-9]{0,19})$' THEN
    RETURN NULL;
  END IF;
  IF length(iat_text) = 20 AND iat_text > '9223372036854775807' THEN
    RETURN NULL;
  END IF;
  IF length(exp_text) = 20 AND exp_text > '9223372036854775807' THEN
    RETURN NULL;
  END IF;
  iat_value := iat_text::bigint;
  exp_value := exp_text::bigint;
  IF iat_value > 9223372036854775807 - 120 OR exp_value IS DISTINCT FROM iat_value + 120 THEN
    RETURN NULL;
  END IF;
  IF nbf_text = '' THEN
    nbf_value := NULL;
  ELSE
    IF nbf_text !~ '^(0|[1-9][0-9]{0,19})$' OR (length(nbf_text) = 20 AND nbf_text > '9223372036854775807') THEN
      RETURN NULL;
    END IF;
    nbf_value := nbf_text::bigint;
    IF nbf_value > iat_value THEN
      RETURN NULL;
    END IF;
  END IF;
  IF jti_text <> '' AND (
    octet_length(field_bytes[8]) IS DISTINCT FROM 36
    OR jti_text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ) THEN
    RETURN NULL;
  END IF;

  now_s := floor(extract(epoch FROM clock_timestamp()))::bigint;
  IF iat_value > now_s + 1 OR clock_timestamp() >= to_timestamp(exp_value::double precision) THEN
    RETURN NULL;
  END IF;
  IF nbf_value IS NOT NULL AND clock_timestamp() < to_timestamp(nbf_value::double precision) THEN
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

ALTER FUNCTION nyuma_private.verify_nya1_subject(text) OWNER TO nyuma_fn_identity;
REVOKE ALL ON FUNCTION nyuma_private.verify_nya1_subject(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nyuma_private.verify_nya1_subject(text) TO nyuma_fn_identity;

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

CREATE OR REPLACE FUNCTION public.nyuma_verified_account_id() RETURNS uuid
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT users.id
  FROM public.users AS users
  WHERE users.auth_user_id = public.nyuma_verified_sub()
    AND users.status = 'active';
$fn$;

CREATE OR REPLACE FUNCTION public.nyuma_account_status() RETURNS text
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT users.status
  FROM public.users AS users
  WHERE users.auth_user_id = public.nyuma_verified_sub();
$fn$;

ALTER FUNCTION public.nyuma_verified_account_id() OWNER TO nyuma_fn_identity;
ALTER FUNCTION public.nyuma_account_status() OWNER TO nyuma_fn_identity;
REVOKE ALL ON FUNCTION public.nyuma_verified_account_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.nyuma_account_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.nyuma_verified_account_id() TO nyuma_app;
GRANT EXECUTE ON FUNCTION public.nyuma_account_status() TO nyuma_app;
