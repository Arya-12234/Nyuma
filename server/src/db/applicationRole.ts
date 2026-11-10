import type { ClientBase } from "pg";

export class ApplicationRoleError extends Error {
  constructor() {
    super("The application connection must inherit nyuma_app and must not be a superuser, operator, provisioner, or function owner.");
  }
}

export async function assertApplicationRole(client: ClientBase): Promise<void> {
  const result = await client.query<{ rolsuper: boolean; blocked: boolean; app: boolean }>(
    `SELECT r.rolsuper,
            COALESCE(pg_has_role(current_user, 'nyuma_provisioner', 'member'), false)
              OR COALESCE(pg_has_role(current_user, 'nyuma_operator', 'member'), false)
              OR COALESCE(pg_has_role(current_user, 'nyuma_fn_request', 'member'), false)
              OR COALESCE(pg_has_role(current_user, 'nyuma_fn_approve', 'member'), false)
              OR COALESCE(pg_has_role(current_user, 'nyuma_fn_reject', 'member'), false)
              OR COALESCE(pg_has_role(current_user, 'nyuma_fn_revoke', 'member'), false) AS blocked,
            pg_has_role(current_user, 'nyuma_app', 'member') AS app
     FROM pg_roles r
     WHERE r.rolname = current_user`,
  );
  const row = result.rows[0];
  if (!row || row.rolsuper || row.blocked || !row.app) throw new ApplicationRoleError();
}
