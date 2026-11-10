-- nyuma:no-transaction
-- CREATE ROLE cannot run inside a transaction block, so the migrator applies this file statement by statement.
-- nyuma_provisioner is the only role that may grant administrator. It has no login and no password.
-- nyuma_app is the ordinary application role. It is not a member of nyuma_provisioner.

CREATE ROLE nyuma_provisioner NOLOGIN NOINHERIT;
CREATE ROLE nyuma_app NOLOGIN NOINHERIT;
