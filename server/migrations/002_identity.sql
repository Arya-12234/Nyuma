-- Identity link and active workspace.
-- This file creates no accounts and assigns no roles. Nyuma does not store credentials.
-- Ordinary farmer, trader, and buyer assignment is not decided here.
-- Administrator assignment stays with nyuma_provisioner.

ALTER TABLE users
  ADD COLUMN active_role text
  CHECK (active_role IS NULL OR active_role IN ('farmer', 'trader', 'buyer', 'administrator'));

COMMENT ON COLUMN users.active_role IS
  'The workspace selected for this account. It must already exist in user_roles. Selecting it does not grant a role.';

COMMENT ON COLUMN users.auth_user_id IS
  'The verified Supabase Auth user id. It is set when the account is created and cannot be moved to another account.';

CREATE FUNCTION nyuma_users_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
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

CREATE TRIGGER users_guard
  BEFORE INSERT OR UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION nyuma_users_guard();

CREATE FUNCTION nyuma_clear_active_role(p_user_id uuid, p_role text) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  UPDATE users
  SET active_role = NULL, updated_at = clock_timestamp()
  WHERE id = p_user_id AND active_role = p_role;
END;
$fn$;

CREATE OR REPLACE FUNCTION nyuma_guard_role_removal() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM nyuma_lock_user(OLD.user_id);
  IF OLD.role = 'administrator'
     AND NOT pg_has_role(current_user, 'nyuma_provisioner', 'MEMBER') THEN
    RAISE EXCEPTION 'A user cannot change the administrator role.';
  END IF;
  IF OLD.role IN ('farmer', 'trader')
     AND NOT EXISTS (
       SELECT 1 FROM user_roles
       WHERE user_id = OLD.user_id AND role IN ('farmer', 'trader') AND role <> OLD.role
     )
     AND EXISTS (SELECT 1 FROM listings WHERE owner_id = OLD.user_id) THEN
    RAISE EXCEPTION 'This account still owns a listing, so the farmer or trader role cannot be removed.';
  END IF;
  IF OLD.role = 'buyer' AND EXISTS (SELECT 1 FROM buyer_demands WHERE buyer_id = OLD.user_id) THEN
    RAISE EXCEPTION 'This account still owns buyer demand, so the buyer role cannot be removed.';
  END IF;
  PERFORM nyuma_clear_active_role(OLD.user_id, OLD.role);
  RETURN OLD;
END;
$fn$;

-- Sets a workspace the account already holds. It does not insert a role.
CREATE FUNCTION nyuma_set_active_role(p_user_id uuid, p_role text) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF p_role NOT IN ('farmer', 'trader', 'buyer', 'administrator')
     OR NOT EXISTS (
       SELECT 1 FROM user_roles WHERE user_id = p_user_id AND role = p_role
     ) THEN
    RAISE EXCEPTION 'That workspace is not assigned to this account.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE users
  SET active_role = p_role, updated_at = clock_timestamp()
  WHERE id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Account % does not exist.', p_user_id USING ERRCODE = '23503';
  END IF;
END;
$fn$;

REVOKE UPDATE ON users FROM nyuma_app;
REVOKE TRUNCATE ON
  users,
  profiles,
  user_roles,
  coordination_ids,
  listings,
  buyer_demands,
  commitments,
  purchases,
  outcomes
FROM PUBLIC, nyuma_app;

REVOKE ALL ON FUNCTION nyuma_set_active_role(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION nyuma_clear_active_role(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nyuma_set_active_role(uuid, text) TO nyuma_app;
GRANT EXECUTE ON FUNCTION nyuma_clear_active_role(uuid, text) TO nyuma_app;
