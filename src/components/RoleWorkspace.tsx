import { authorizeSection, presentForAccount, recordIdFromHash } from "../lib/access";
import type { SessionUser } from "../lib/auth";
import type { NyumaApi } from "../lib/nyumaApi";
import { AccessDenied } from "./AccessDenied";
import { CoordinationProvider } from "./coordination/coordinationAccess";
import { WorkspaceShell } from "./WorkspaceShell";
import { AdminWorkspace } from "./workspaces/AdminWorkspace";
import { BuyerWorkspace } from "./workspaces/BuyerWorkspace";
import { FarmerWorkspace } from "./workspaces/FarmerWorkspace";
import { TraderWorkspace } from "./workspaces/TraderWorkspace";

export function RoleWorkspace({
  user,
  hash,
  onSignOut,
  accessToken = null,
  api = null,
  onUnauthenticated,
  onAccountDisabled,
  onAccessDenied,
}: {
  user: SessionUser;
  hash: string;
  onSignOut: () => void;
  accessToken?: string | null;
  api?: NyumaApi | null;
  onUnauthenticated?: () => void;
  onAccountDisabled?: () => void;
  onAccessDenied?: () => void;
}) {
  const access = authorizeSection(user, hash);
  if (!access.ok) {
    return <AccessDenied user={user} onSignOut={onSignOut} />;
  }
  const { section } = access;
  const presented = presentForAccount(section, access.user.sample);
  const trader = presented.workspace === "trader" || presented.workspace === "decision-support";

  return (
    <CoordinationProvider
      user={access.user}
      token={accessToken}
      api={api}
      onUnauthenticated={onUnauthenticated ?? (() => undefined)}
      onAccountDisabled={onAccountDisabled}
      onAccessDenied={onAccessDenied}
    >
    <>
      <a className="skip-link" href="#workspace-title">
        Skip to the workspace
      </a>
      <WorkspaceShell
        user={access.user}
        section={presented}
        title={workspaceTitle(presented.id, hash, presented.title)}
        description={presented.description}
        onSignOut={onSignOut}
      >
        {trader ? <TraderWorkspace user={access.user} section={section} hash={hash} /> : null}
        {section.workspace === "farmer" ? <FarmerWorkspace user={access.user} section={section} hash={hash} /> : null}
        {section.workspace === "buyer" ? <BuyerWorkspace user={access.user} section={section} hash={hash} /> : null}
        {section.workspace === "administrator" ? <AdminWorkspace user={access.user} section={section} /> : null}
      </WorkspaceShell>
    </>
    </CoordinationProvider>
  );
}

function workspaceTitle(sectionId: string, hash: string, title: string): string {
  const editing = recordIdFromHash(hash) !== null;
  if (!editing) return title;
  if (sectionId.endsWith("listing-form")) return "Edit listing";
  if (sectionId.endsWith("demand-form")) return "Edit requirement";
  return title;
}
