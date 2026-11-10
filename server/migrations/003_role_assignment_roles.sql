-- nyuma:no-transaction
-- CREATE ROLE cannot run inside a transaction block.
-- These roles have no login and no password. Operator logins are created outside this repository.
-- nyuma_operator approves ordinary roles. It is not a member of nyuma_provisioner.
-- Each function owner holds only the table privilege its function needs.

CREATE ROLE nyuma_operator NOLOGIN NOINHERIT;
CREATE ROLE nyuma_fn_request NOLOGIN NOINHERIT;
CREATE ROLE nyuma_fn_approve NOLOGIN NOINHERIT;
CREATE ROLE nyuma_fn_reject NOLOGIN NOINHERIT;
CREATE ROLE nyuma_fn_revoke NOLOGIN NOINHERIT;

GRANT nyuma_operator TO CURRENT_USER WITH ADMIN OPTION;
GRANT nyuma_fn_request TO CURRENT_USER;
GRANT nyuma_fn_approve TO CURRENT_USER;
GRANT nyuma_fn_reject TO CURRENT_USER;
GRANT nyuma_fn_revoke TO CURRENT_USER;
