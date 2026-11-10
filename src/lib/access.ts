import { readActor, type SessionUser } from "./auth";
import {
  readSampleSession,
  roleLabel,
  type Role,
} from "./sampleUsers";

export const WORKSPACES = ["farmer", "trader", "buyer", "administrator", "decision-support"] as const;
export type WorkspaceId = (typeof WORKSPACES)[number];

export const ACTIONS = [
  "open-decision-support",
  "edit-scenario",
  "save-scenario",
  "create-listing",
  "edit-listing",
  "create-demand",
  "edit-demand",
  "create-commitment",
  "cancel-commitment",
  "record-purchase",
  "record-outcome",
] as const;
export type ActionId = (typeof ACTIONS)[number];

const WORKSPACE_ROLES: Record<WorkspaceId, readonly Role[]> = {
  farmer: ["farmer"],
  trader: ["trader"],
  buyer: ["buyer"],
  administrator: ["administrator"],
  "decision-support": ["trader"],
};

const ACTION_ROLES: Record<ActionId, readonly Role[]> = {
  "open-decision-support": ["trader"],
  "edit-scenario": ["trader"],
  "save-scenario": ["trader"],
  "create-listing": ["farmer", "trader"],
  "edit-listing": ["farmer", "trader"],
  "create-demand": ["buyer"],
  "edit-demand": ["buyer"],
  "create-commitment": ["farmer", "trader", "buyer"],
  "cancel-commitment": ["farmer", "trader", "buyer"],
  "record-purchase": ["farmer", "trader", "buyer"],
  "record-outcome": ["farmer", "trader"],
};

export interface WorkspaceSection {
  id: string;
  hash: string;
  label: string;
  title: string;
  description: string;
  workspace: WorkspaceId;
  nav: boolean;
  /** Extra action required to open the section. The workspace role check still applies. */
  action?: ActionId;
  notifications?: boolean;
}

export const SECTIONS: readonly WorkspaceSection[] = [
  {
    id: "farmer-overview",
    hash: "#farmer",
    label: "Overview",
    title: "Your produce",
    description: "Listings saved for this sample account in this browser.",
    workspace: "farmer",
    nav: true,
  },
  {
    id: "farmer-listings",
    hash: "#farmer-listings",
    label: "My listings",
    title: "My listings",
    description: "Produce you have listed for coordination.",
    workspace: "farmer",
    nav: true,
  },
  {
    id: "farmer-listing-form",
    hash: "#farmer-listing",
    label: "Add produce",
    title: "Add produce",
    description: "Save a draft or open a listing. An expected harvest is not produce that is ready to collect.",
    workspace: "farmer",
    nav: false,
    action: "create-listing",
  },
  {
    id: "farmer-opportunities",
    hash: "#farmer-opportunities",
    label: "Buyer opportunities",
    title: "Buyer opportunities",
    description: "Buyer demand that could take your produce.",
    workspace: "farmer",
    nav: true,
  },
  {
    id: "farmer-matches",
    hash: "#farmer-matches",
    label: "Matches",
    title: "Matches",
    description: "Possible matches for your listings.",
    workspace: "farmer",
    nav: true,
  },
  {
    id: "farmer-commitments",
    hash: "#farmer-commitments",
    label: "Commitments",
    title: "Commitments",
    description: "Agreements involving your listings. An agreement is not a purchase.",
    workspace: "farmer",
    nav: true,
  },
  {
    id: "farmer-exposure",
    hash: "#farmer-exposure",
    label: "Exposure",
    title: "Your exposure",
    description: "Quantity on your listings that is not yet purchased. Expected harvest is not ready to collect.",
    workspace: "farmer",
    nav: true,
  },
  {
    id: "farmer-outcomes",
    hash: "#farmer-outcomes",
    label: "Outcomes",
    title: "Produce outcomes",
    description: "What happened to produce on your listings. A purchase is not copied here unless you record it.",
    workspace: "farmer",
    nav: true,
  },
  {
    id: "farmer-commitment-form",
    hash: "#farmer-commitment",
    label: "Record an agreement",
    title: "Record an agreement",
    description: "Confirm a quantity and price with a buyer requirement. This is not a purchase.",
    workspace: "farmer",
    nav: false,
    action: "create-commitment",
  },
  {
    id: "farmer-purchase-form",
    hash: "#farmer-purchase",
    label: "Record a purchase",
    title: "Record a purchase",
    description: "Record what was actually bought against a confirmed agreement.",
    workspace: "farmer",
    nav: false,
    action: "record-purchase",
  },
  {
    id: "farmer-messages",
    hash: "#farmer-messages",
    label: "Messages",
    title: "Messages",
    description: "Messages for this sample farmer account.",
    workspace: "farmer",
    nav: true,
    notifications: true,
  },
  {
    id: "farmer-profile",
    hash: "#farmer-profile",
    label: "Profile",
    title: "Profile",
    description: "The sample account you are signed in with.",
    workspace: "farmer",
    nav: true,
  },
  {
    id: "trader-overview",
    hash: "#decision-support",
    label: "Overview",
    title: "Your trade",
    description: "Saved listings, buyer requirements, agreements, purchases, and exposure in this browser.",
    workspace: "trader",
    nav: true,
  },
  {
    id: "trader-listings",
    hash: "#stock",
    label: "My listings",
    title: "My listings",
    description: "Produce you have saved. An expected harvest is not ready for collection.",
    workspace: "trader",
    nav: true,
  },
  {
    id: "trader-listing-form",
    hash: "#stock-form",
    label: "Add produce",
    title: "Add produce",
    description: "Save a draft or open a listing. This does not change the practice scenario.",
    workspace: "trader",
    nav: false,
    action: "create-listing",
  },
  {
    id: "trader-demand",
    hash: "#buyers",
    label: "Buyer demand",
    title: "Buyer demand",
    description: "Buyer requirements saved in this browser. A requirement is interest, not a confirmed order.",
    workspace: "trader",
    nav: true,
  },
  {
    id: "trader-matches",
    hash: "#allocation",
    label: "Matches",
    title: "Potential matches",
    description: "Suggestions from your open listings and open buyer requirements. A suggestion is not an agreement.",
    workspace: "trader",
    nav: true,
  },
  {
    id: "trader-transactions",
    hash: "#transactions",
    label: "Transactions",
    title: "Transactions",
    description: "Agreements and purchases for your listings. An agreement is not a completed sale.",
    workspace: "trader",
    nav: true,
  },
  {
    id: "trader-exposure",
    hash: "#trader-exposure",
    label: "Exposure",
    title: "Unsold exposure",
    description: "Available produce not yet recorded as purchased or otherwise accounted for. Expected harvest is separate and is not ready to collect.",
    workspace: "trader",
    nav: true,
  },
  {
    id: "trader-outcomes",
    hash: "#trader-outcomes",
    label: "Outcomes",
    title: "Produce outcomes",
    description: "What happened to produce on your listings. Unaccounted quantity is not spoiled produce.",
    workspace: "trader",
    nav: true,
  },
  {
    id: "trader-commitment-form",
    hash: "#trader-commitment",
    label: "Record an agreement",
    title: "Record an agreement",
    description: "Confirm a quantity and price with a buyer requirement. This is not a purchase.",
    workspace: "trader",
    nav: false,
    action: "create-commitment",
  },
  {
    id: "trader-purchase-form",
    hash: "#trader-purchase",
    label: "Record a purchase",
    title: "Record a purchase",
    description: "Record what was actually bought against a confirmed agreement.",
    workspace: "trader",
    nav: false,
    action: "record-purchase",
  },
  {
    id: "trader-messages",
    hash: "#updates",
    label: "Messages",
    title: "Messages",
    description: "Messages for this sample trader account.",
    workspace: "trader",
    nav: true,
    notifications: true,
  },
  {
    id: "trader-analytics",
    hash: "#analytics",
    label: "Analytics",
    title: "Analytics",
    description: "Figures from your saved listings, agreements, purchases, and outcomes.",
    workspace: "trader",
    nav: true,
  },
  {
    id: "trader-practice",
    hash: "#practice-scenario",
    label: "Practice scenario",
    title: "Practice scenario — learn how matching works",
    description: "Illustrative sample information. Results are not agreements, and saving this scenario does not create a listing, an agreement, or a purchase.",
    workspace: "decision-support",
    nav: true,
    action: "open-decision-support",
  },
  {
    id: "trader-report",
    hash: "#report",
    label: "Practice scenario",
    title: "Practice scenario — learn how matching works",
    description: "Illustrative sample information. Editing it does not create a coordination listing.",
    workspace: "decision-support",
    nav: false,
    action: "open-decision-support",
  },
  {
    id: "trader-surplus",
    hash: "#surplus",
    label: "Practice scenario",
    title: "Practice scenario — learn how matching works",
    description: "Illustrative sample information. Unallocated quantity here is not unsold produce from a saved listing.",
    workspace: "decision-support",
    nav: false,
    action: "open-decision-support",
  },
  {
    id: "buyer-overview",
    hash: "#buyer",
    label: "Overview",
    title: "Your procurement",
    description: "Purchasing requirements saved for this sample account in this browser.",
    workspace: "buyer",
    nav: true,
  },
  {
    id: "buyer-demand",
    hash: "#buyer-demand",
    label: "My demand",
    title: "My demand",
    description: "Purchasing requirements for this sample buyer.",
    workspace: "buyer",
    nav: true,
  },
  {
    id: "buyer-demand-form",
    hash: "#buyer-demand-form",
    label: "Submit requirement",
    title: "Submit a requirement",
    description: "Tell Nyuma what you want to buy. This is not a confirmed order.",
    workspace: "buyer",
    nav: false,
    action: "create-demand",
  },
  {
    id: "buyer-produce",
    hash: "#buyer-produce",
    label: "Available produce",
    title: "Available produce",
    description: "Produce listings this buyer could consider.",
    workspace: "buyer",
    nav: true,
  },
  {
    id: "buyer-matches",
    hash: "#buyer-matches",
    label: "Matches",
    title: "Matches",
    description: "Possible supply for your demand.",
    workspace: "buyer",
    nav: true,
  },
  {
    id: "buyer-commitments",
    hash: "#buyer-commitments",
    label: "Commitments",
    title: "Commitments",
    description: "Agreements involving your requirements. An agreement is not a purchase.",
    workspace: "buyer",
    nav: true,
  },
  {
    id: "buyer-commitment-form",
    hash: "#buyer-commitment",
    label: "Record an agreement",
    title: "Record an agreement",
    description: "Confirm a quantity and price with an open listing. This is not a purchase.",
    workspace: "buyer",
    nav: false,
    action: "create-commitment",
  },
  {
    id: "buyer-exposure",
    hash: "#buyer-exposure",
    label: "Open quantity",
    title: "Uncommitted demand",
    description: "Quantity on your requirements that has no agreement yet. Other buyers' requirements are not shown.",
    workspace: "buyer",
    nav: true,
  },
  {
    id: "buyer-purchases",
    hash: "#buyer-purchases",
    label: "Purchase history",
    title: "Purchase history",
    description: "Purchases recorded against your confirmed agreements.",
    workspace: "buyer",
    nav: true,
  },
  {
    id: "buyer-outcomes",
    hash: "#buyer-outcomes",
    label: "Outcomes",
    title: "Related outcomes",
    description: "Sold outcomes linked to your purchases. Other produce outcomes are not shown.",
    workspace: "buyer",
    nav: true,
  },
  {
    id: "buyer-purchase-form",
    hash: "#buyer-purchase",
    label: "Record a purchase",
    title: "Record a purchase",
    description: "Record what was actually bought against a confirmed agreement.",
    workspace: "buyer",
    nav: false,
    action: "record-purchase",
  },
  {
    id: "buyer-messages",
    hash: "#buyer-messages",
    label: "Messages",
    title: "Messages",
    description: "Messages for this sample buyer account.",
    workspace: "buyer",
    nav: true,
    notifications: true,
  },
  {
    id: "admin-overview",
    hash: "#admin",
    label: "Platform overview",
    title: "Platform overview",
    description: "What has actually been recorded. Sample accounts are not customers.",
    workspace: "administrator",
    nav: true,
  },
  {
    id: "admin-users",
    hash: "#admin-users",
    label: "Users",
    title: "Users",
    description: "Sample accounts built into this demonstration.",
    workspace: "administrator",
    nav: true,
  },
  {
    id: "admin-listings",
    hash: "#admin-listings",
    label: "Listings",
    title: "Listings",
    description: "Produce listings recorded on the platform.",
    workspace: "administrator",
    nav: true,
  },
  {
    id: "admin-demand",
    hash: "#admin-demand",
    label: "Buyer demand",
    title: "Buyer demand",
    description: "Purchasing requirements recorded on the platform.",
    workspace: "administrator",
    nav: true,
  },
  {
    id: "admin-matches",
    hash: "#admin-matches",
    label: "Matches",
    title: "Matches",
    description: "Matches recorded between listings and demand.",
    workspace: "administrator",
    nav: true,
  },
  {
    id: "admin-transactions",
    hash: "#admin-transactions",
    label: "Transactions",
    title: "Transactions",
    description: "Commitments and purchases recorded on the platform.",
    workspace: "administrator",
    nav: true,
  },
  {
    id: "admin-exposure",
    hash: "#admin-exposure",
    label: "Exposure",
    title: "Exposure in this browser",
    description: "Exposure across records saved in this browser. This is view only, and it is not a platform-wide total.",
    workspace: "administrator",
    nav: true,
  },
  {
    id: "admin-outcomes",
    hash: "#admin-outcomes",
    label: "Outcomes",
    title: "Outcomes in this browser",
    description: "Outcome records saved in this browser. This is view only, and it is not a platform-wide total.",
    workspace: "administrator",
    nav: true,
  },
  {
    id: "admin-activity",
    hash: "#admin-activity",
    label: "Activity",
    title: "Activity",
    description: "Coordination activity recorded on the platform.",
    workspace: "administrator",
    nav: true,
    notifications: true,
  },
];

const HOME_SECTION: Record<Role, string> = {
  farmer: "farmer-overview",
  trader: "trader-overview",
  buyer: "buyer-overview",
  administrator: "admin-overview",
};

export type AccessResult =
  | { ok: true; user: SessionUser }
  | { ok: false; reason: "missing"; message: string }
  | { ok: false; reason: "forbidden"; user: SessionUser; message: string };

export type SectionAccess =
  | { ok: true; user: SessionUser; section: WorkspaceSection }
  | { ok: false; reason: "missing" | "forbidden" | "unknown"; message: string; user?: SessionUser };

export type AppView = "home" | "login" | "workspace" | "denied";

/** Drop a record id query so `#farmer-listing?id=listing-1` still matches the form section. */
export function workspacePath(hash: string): string {
  const query = hash.indexOf("?");
  return query === -1 ? hash : hash.slice(0, query);
}

export function recordIdFromHash(hash: string): string | null {
  const query = hash.indexOf("?");
  if (query === -1) return null;
  const id = new URLSearchParams(hash.slice(query + 1)).get("id");
  return id && id.trim() !== "" ? id : null;
}

export function isWorkspaceHash(hash: string): boolean {
  const path = workspacePath(hash);
  return path === "#workspace" || SECTIONS.some((section) => section.hash === path);
}

export function navigationFor(role: Role): readonly WorkspaceSection[] {
  return SECTIONS.filter((section) => section.nav && WORKSPACE_ROLES[section.workspace].includes(role));
}

export function notificationsHash(role: Role): string {
  const section = SECTIONS.find(
    (item) => item.notifications && WORKSPACE_ROLES[item.workspace].includes(role),
  );
  return section?.hash ?? "#workspace";
}

export function resolveSection(hash: string, role: Role | null): WorkspaceSection | null {
  const path = workspacePath(hash);
  if (path === "#workspace" || path === "#login") {
    if (!role) return null;
    return SECTIONS.find((section) => section.id === HOME_SECTION[role]) ?? null;
  }
  return SECTIONS.find((section) => section.hash === path) ?? null;
}

export function authorizeWorkspace(user: SessionUser | null, workspace: WorkspaceId): AccessResult {
  return authorize(user, WORKSPACE_ROLES[workspace], workspaceLabel(workspace));
}

export function authorizeAction(user: SessionUser | null, action: ActionId): AccessResult {
  return authorize(user, ACTION_ROLES[action], actionLabel(action));
}

/** Role permission plus ownership. The owner id comes from the saved record, not from the form. */
export function authorizeOwnRecord(user: SessionUser | null, action: ActionId, ownerId: string): AccessResult {
  const gate = authorizeAction(user, action);
  if (!gate.ok) return gate;
  if (gate.user.id !== ownerId) {
    return {
      ok: false,
      reason: "forbidden",
      user: gate.user,
      message: "This record belongs to another sample account.",
    };
  }
  return gate;
}

/** Open a workspace route. A role can only open sections assigned to that role. */
export function authorizeSection(user: SessionUser | null, hash: string): SectionAccess {
  const valid = readActor(user);
  const section = resolveSection(hash, valid?.role ?? null);
  if (!section) {
    return { ok: false, reason: "unknown", message: "That page is not part of a sample workspace." };
  }
  const workspace = authorizeWorkspace(valid, section.workspace);
  if (!workspace.ok) return workspace;
  if (section.action) {
    const action = authorizeAction(valid, section.action);
    if (!action.ok) return action;
  }
  return { ok: true, user: workspace.user, section };
}

/** Where the current hash and session should land. Invalid sessions are treated as signed out. */
export function viewForHash(hash: string, session: unknown): AppView {
  const valid = readSampleSession(session);
  if (hash === "#login") return valid ? "workspace" : "login";
  if (!isWorkspaceHash(hash)) return "home";
  if (!valid) return "login";
  return authorizeSection(valid, hash).ok ? "workspace" : "denied";
}

function authorize(user: SessionUser | null, allowed: readonly Role[], subject: string): AccessResult {
  const valid = readActor(user);
  if (!valid) {
    return { ok: false, reason: "missing", message: "Sign in with a sample account to continue." };
  }
  if (!allowed.includes(valid.role)) {
    const who = valid.sample
      ? `sample ${roleLabel(valid.role).toLowerCase()} account`
      : `${roleLabel(valid.role).toLowerCase()} role`;
    return {
      ok: false,
      reason: "forbidden",
      user: valid,
      message: valid.sample
        ? `The sample ${roleLabel(valid.role).toLowerCase()} account cannot ${subject}.`
        : `The ${who} cannot ${subject}.`,
    };
  }
  return { ok: true, user: valid };
}

/** Sample copy stays exact. An authenticated workspace does not describe API records as browser storage. */
export function presentForAccount(section: WorkspaceSection, sample: boolean): WorkspaceSection {
  if (sample) return section;
  return {
    ...section,
    title: section.title.replace(/ in this browser/g, ""),
    description: section.description
      .replaceAll("saved for this sample account in this browser", "saved for this account")
      .replaceAll(" in this browser", " for this account"),
  };
}

function workspaceLabel(workspace: WorkspaceId): string {
  if (workspace === "decision-support") return "open the decision-support workspace";
  if (workspace === "farmer") return "open the farmer workspace";
  if (workspace === "trader") return "open the trader workspace";
  if (workspace === "buyer") return "open the buyer workspace";
  return "open the administrator workspace";
}

function actionLabel(action: ActionId): string {
  const labels: Record<ActionId, string> = {
    "open-decision-support": "open the decision-support workspace",
    "edit-scenario": "edit the sample scenario",
    "save-scenario": "save the sample scenario",
    "create-listing": "create a produce listing",
    "edit-listing": "edit a produce listing",
    "create-demand": "submit a purchasing requirement",
    "edit-demand": "edit a purchasing requirement",
    "create-commitment": "record an agreement",
    "cancel-commitment": "cancel an agreement",
    "record-purchase": "record a purchase",
    "record-outcome": "record an outcome",
  };
  return labels[action];
}
