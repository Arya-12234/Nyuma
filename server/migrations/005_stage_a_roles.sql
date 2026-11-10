-- nyuma:no-transaction
-- Stage A. CREATE ROLE cannot run inside a transaction block.
-- Passwords are not set here. Set them outside git with ALTER ROLE ... PASSWORD.
-- This file does not enable RLS, revoke grants, or change function bodies.
-- nyuma_owner is the migration owner. It is not the API login.
-- nyuma_api inherits nyuma_app and no other Nyuma role.
-- nyuma_fn_constraint is NOLOGIN. nyuma_api is not a member, so it cannot SET ROLE to it.
-- BYPASSRLS on nyuma_fn_constraint has no effect until RLS is enabled. This stage does not enable it.

CREATE ROLE nyuma_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
CREATE ROLE nyuma_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS NOREPLICATION;
CREATE ROLE nyuma_fn_identity NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
CREATE ROLE nyuma_fn_constraint NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS NOREPLICATION;

GRANT nyuma_app TO nyuma_api;

-- The migration owner can SET ROLE to the existing operator and function-owner roles.
-- NOINHERIT keeps those privileges off an ordinary nyuma_owner session.
-- nyuma_api receives none of these memberships.
-- Membership in nyuma_fn_constraint does not give nyuma_owner BYPASSRLS. That attribute is not inherited.
GRANT nyuma_provisioner TO nyuma_owner;
GRANT nyuma_operator TO nyuma_owner WITH ADMIN OPTION;
GRANT nyuma_fn_request TO nyuma_owner;
GRANT nyuma_fn_approve TO nyuma_owner;
GRANT nyuma_fn_reject TO nyuma_owner;
GRANT nyuma_fn_revoke TO nyuma_owner;
GRANT nyuma_fn_identity TO nyuma_owner;
GRANT nyuma_fn_constraint TO nyuma_owner;
