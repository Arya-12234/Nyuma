-- Ordinary role requests.
-- user_roles remains the only granted-permission table.
-- nyuma_app cannot insert, update, or delete role requests or role grants.
-- Submission and history run as nyuma_fn_request.
-- Approval runs as nyuma_fn_approve. Rejection runs as nyuma_fn_reject. Revocation runs as nyuma_fn_revoke.
-- Those owners are not superusers and are not members of nyuma_provisioner.
-- Inside a SECURITY DEFINER function, current_user is the function owner and session_user stays the login.
-- Decision functions therefore check session_user for nyuma_operator membership.
-- The administrator triggers keep reading current_user, which is the function owner, not the operator login.

CREATE TABLE role_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('farmer', 'trader', 'buyer')),
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_at timestamptz,
  decided_by_role text,
  decided_by_login text,
  decision_note text CHECK (decision_note IS NULL OR char_length(decision_note) <= 500)
);

CREATE UNIQUE INDEX role_requests_one_pending
  ON role_requests (user_id, role)
  WHERE status = 'pending';

CREATE INDEX role_requests_user_idx ON role_requests (user_id, requested_at);

COMMENT ON TABLE role_requests IS
  'A preference and its one decision. Approved records history. The granted role lives in user_roles.';

CREATE TABLE role_revocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('farmer', 'trader', 'buyer')),
  revoked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_by_role text NOT NULL,
  revoked_by_login text NOT NULL,
  note text CHECK (note IS NULL OR char_length(note) <= 500)
);

CREATE INDEX role_revocations_user_idx ON role_revocations (user_id, revoked_at);

COMMENT ON TABLE role_revocations IS
  'Append-only record of an ordinary role removal. A failed revocation does not insert a row.';

CREATE FUNCTION nyuma_guard_role_request() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A role request cannot be deleted.';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'pending'
       OR NEW.decided_at IS NOT NULL
       OR NEW.decided_by_role IS NOT NULL
       OR NEW.decided_by_login IS NOT NULL
       OR NEW.decision_note IS NOT NULL THEN
      RAISE EXCEPTION 'A role request must start pending.';
    END IF;
    IF NEW.requested_at IS NULL THEN
      NEW.requested_at := clock_timestamp();
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'A role decision cannot be changed.';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.role IS DISTINCT FROM OLD.role
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at THEN
    RAISE EXCEPTION 'A role request identity cannot change.';
  END IF;
  IF NEW.status NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'A role request can only be approved or rejected.';
  END IF;
  IF NEW.status = 'approved' AND NOT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = NEW.user_id AND role = NEW.role
  ) THEN
    RAISE EXCEPTION 'A role request cannot be approved before the role is granted.';
  END IF;
  NEW.decided_at := clock_timestamp();
  NEW.decided_by_role := current_user;
  NEW.decided_by_login := session_user;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER role_requests_guard
  BEFORE INSERT OR UPDATE OR DELETE ON role_requests
  FOR EACH ROW EXECUTE FUNCTION nyuma_guard_role_request();

CREATE FUNCTION nyuma_guard_role_revocation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.role NOT IN ('farmer', 'trader', 'buyer') THEN
      RAISE EXCEPTION 'A user cannot change the administrator role.';
    END IF;
    NEW.revoked_at := clock_timestamp();
    NEW.revoked_by_role := current_user;
    NEW.revoked_by_login := session_user;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'A revocation record cannot be changed.';
END;
$fn$;

CREATE TRIGGER role_revocations_guard
  BEFORE INSERT OR UPDATE OR DELETE ON role_revocations
  FOR EACH ROW EXECUTE FUNCTION nyuma_guard_role_revocation();

GRANT USAGE ON SCHEMA public TO nyuma_operator, nyuma_fn_request, nyuma_fn_approve, nyuma_fn_reject, nyuma_fn_revoke;
GRANT CREATE ON SCHEMA public TO nyuma_fn_request, nyuma_fn_approve, nyuma_fn_reject, nyuma_fn_revoke;

-- The API passes the verified Supabase sub. This function cannot verify the bearer token.
-- A stolen application credential can file a pending request for any auth_user_id it can read.
-- That row does not grant a role.
CREATE FUNCTION public.nyuma_submit_role_requests(p_auth_user_id uuid, p_roles text[])
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

CREATE FUNCTION public.nyuma_list_role_requests(p_auth_user_id uuid)
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

CREATE FUNCTION public.nyuma_approve_role_request(p_request_id uuid, p_note text) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_user_id uuid;
  v_role text;
  v_status text;
  v_account_status text;
BEGIN
  IF NOT pg_has_role(session_user, 'nyuma_operator', 'MEMBER') THEN
    RAISE EXCEPTION 'Operator membership is required.' USING ERRCODE = '42501';
  END IF;
  IF p_note IS NOT NULL AND char_length(p_note) > 500 THEN
    RAISE EXCEPTION 'invalid-request' USING ERRCODE = 'P0001';
  END IF;
  SELECT role_requests.user_id, role_requests.role, role_requests.status
    INTO v_user_id, v_role, v_status
  FROM public.role_requests
  WHERE role_requests.id = p_request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The role request does not exist.';
  END IF;
  PERFORM public.nyuma_lock_user(v_user_id);
  SELECT role_requests.user_id, role_requests.role, role_requests.status
    INTO v_user_id, v_role, v_status
  FROM public.role_requests
  WHERE role_requests.id = p_request_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The role request does not exist.';
  END IF;
  IF v_status = 'approved' AND EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_roles.user_id = v_user_id AND user_roles.role = v_role
  ) THEN
    RETURN;
  END IF;
  IF v_status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'The role request is already decided.';
  END IF;
  IF v_role NOT IN ('farmer', 'trader', 'buyer') THEN
    RAISE EXCEPTION 'A user cannot grant the administrator role.';
  END IF;
  SELECT users.status INTO v_account_status FROM public.users WHERE users.id = v_user_id;
  IF v_account_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'The account is not active.';
  END IF;
  INSERT INTO public.user_roles (user_id, role)
  VALUES (v_user_id, v_role)
  ON CONFLICT (user_id, role) DO NOTHING;
  UPDATE public.role_requests
  SET status = 'approved',
      decision_note = p_note
  WHERE role_requests.id = p_request_id
    AND role_requests.status = 'pending';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The role request is already decided.';
  END IF;
END;
$fn$;

CREATE FUNCTION public.nyuma_reject_role_request(p_request_id uuid, p_note text) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_user_id uuid;
  v_status text;
BEGIN
  IF NOT pg_has_role(session_user, 'nyuma_operator', 'MEMBER') THEN
    RAISE EXCEPTION 'Operator membership is required.' USING ERRCODE = '42501';
  END IF;
  IF p_note IS NOT NULL AND char_length(p_note) > 500 THEN
    RAISE EXCEPTION 'invalid-request' USING ERRCODE = 'P0001';
  END IF;
  SELECT role_requests.user_id, role_requests.status
    INTO v_user_id, v_status
  FROM public.role_requests
  WHERE role_requests.id = p_request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The role request does not exist.';
  END IF;
  PERFORM public.nyuma_lock_user(v_user_id);
  SELECT role_requests.status
    INTO v_status
  FROM public.role_requests
  WHERE role_requests.id = p_request_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The role request does not exist.';
  END IF;
  IF v_status = 'rejected' THEN
    RETURN;
  END IF;
  IF v_status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'The role request is already decided.';
  END IF;
  UPDATE public.role_requests
  SET status = 'rejected',
      decision_note = p_note
  WHERE role_requests.id = p_request_id
    AND role_requests.status = 'pending';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The role request is already decided.';
  END IF;
END;
$fn$;

CREATE FUNCTION public.nyuma_revoke_ordinary_role(p_user_id uuid, p_role text, p_note text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF NOT pg_has_role(session_user, 'nyuma_operator', 'MEMBER') THEN
    RAISE EXCEPTION 'Operator membership is required.' USING ERRCODE = '42501';
  END IF;
  IF p_note IS NOT NULL AND char_length(p_note) > 500 THEN
    RAISE EXCEPTION 'invalid-request' USING ERRCODE = 'P0001';
  END IF;
  IF p_user_id IS NULL OR p_role IS NULL OR p_role NOT IN ('farmer', 'trader', 'buyer') THEN
    RAISE EXCEPTION 'A user cannot change the administrator role.';
  END IF;
  PERFORM public.nyuma_lock_user(p_user_id);
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_roles.user_id = p_user_id AND user_roles.role = p_role
  ) THEN
    RAISE EXCEPTION 'That role is not granted.';
  END IF;
  DELETE FROM public.user_roles
  WHERE user_roles.user_id = p_user_id AND user_roles.role = p_role;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That role is not granted.';
  END IF;
  INSERT INTO public.role_revocations (user_id, role, revoked_by_role, revoked_by_login, note)
  VALUES (p_user_id, p_role, current_user, session_user, p_note);
END;
$fn$;

ALTER FUNCTION public.nyuma_submit_role_requests(uuid, text[]) OWNER TO nyuma_fn_request;
ALTER FUNCTION public.nyuma_list_role_requests(uuid) OWNER TO nyuma_fn_request;
ALTER FUNCTION public.nyuma_approve_role_request(uuid, text) OWNER TO nyuma_fn_approve;
ALTER FUNCTION public.nyuma_reject_role_request(uuid, text) OWNER TO nyuma_fn_reject;
ALTER FUNCTION public.nyuma_revoke_ordinary_role(uuid, text, text) OWNER TO nyuma_fn_revoke;

REVOKE CREATE ON SCHEMA public FROM PUBLIC, nyuma_app, nyuma_fn_request, nyuma_fn_approve, nyuma_fn_reject, nyuma_fn_revoke;

REVOKE INSERT, UPDATE, DELETE ON user_roles FROM nyuma_app;

GRANT SELECT ON users TO nyuma_operator, nyuma_fn_request, nyuma_fn_approve, nyuma_fn_reject, nyuma_fn_revoke;
GRANT SELECT ON user_roles TO nyuma_operator, nyuma_fn_request, nyuma_fn_approve, nyuma_fn_revoke;
GRANT SELECT, INSERT ON role_requests TO nyuma_fn_request;
GRANT SELECT, UPDATE ON role_requests TO nyuma_fn_approve, nyuma_fn_reject;
GRANT SELECT ON role_requests TO nyuma_operator;
GRANT INSERT ON user_roles TO nyuma_fn_approve;
GRANT DELETE ON user_roles TO nyuma_fn_revoke;
GRANT INSERT ON role_revocations TO nyuma_fn_revoke;
GRANT SELECT ON role_revocations TO nyuma_operator;
GRANT SELECT ON listings, buyer_demands TO nyuma_fn_revoke;

REVOKE ALL ON FUNCTION public.nyuma_submit_role_requests(uuid, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.nyuma_list_role_requests(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.nyuma_approve_role_request(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.nyuma_reject_role_request(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.nyuma_revoke_ordinary_role(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION nyuma_guard_role_request() FROM PUBLIC;
REVOKE ALL ON FUNCTION nyuma_guard_role_revocation() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.nyuma_submit_role_requests(uuid, text[]) TO nyuma_app;
GRANT EXECUTE ON FUNCTION public.nyuma_list_role_requests(uuid) TO nyuma_app;
GRANT EXECUTE ON FUNCTION public.nyuma_approve_role_request(uuid, text) TO nyuma_operator;
GRANT EXECUTE ON FUNCTION public.nyuma_reject_role_request(uuid, text) TO nyuma_operator;
GRANT EXECUTE ON FUNCTION public.nyuma_revoke_ordinary_role(uuid, text, text) TO nyuma_operator;
GRANT EXECUTE ON FUNCTION nyuma_guard_role_request() TO nyuma_fn_request, nyuma_fn_approve, nyuma_fn_reject;
GRANT EXECUTE ON FUNCTION nyuma_guard_role_revocation() TO nyuma_fn_revoke;
GRANT EXECUTE ON FUNCTION nyuma_lock_user(uuid) TO nyuma_fn_request, nyuma_fn_approve, nyuma_fn_reject, nyuma_fn_revoke;
GRANT EXECUTE ON FUNCTION nyuma_clear_active_role(uuid, text) TO nyuma_fn_revoke;

REVOKE TRUNCATE ON role_requests, role_revocations FROM PUBLIC, nyuma_app, nyuma_operator, nyuma_fn_request, nyuma_fn_approve, nyuma_fn_reject, nyuma_fn_revoke;
