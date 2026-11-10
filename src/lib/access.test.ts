import { describe, expect, it } from "vitest";
import { authorizeAction, authorizeSection, authorizeWorkspace, navigationFor, presentForAccount, SECTIONS, viewForHash } from "./access";
import { signIn } from "./auth";
import { SAMPLE_USERS, type SampleSession } from "./sampleUsers";

function sessionFor(email: string): SampleSession {
  const account = SAMPLE_USERS.find((item) => item.email === email);
  if (!account) throw new Error(`missing sample account ${email}`);
  const result = signIn(account.email, account.password);
  if (!result.ok) throw new Error(`sample sign-in failed for ${email}`);
  return result.user;
}

describe("sample role authorization", () => {
  it("opens each role's own workspace and keeps decision support with the trader", () => {
    expect(authorizeWorkspace(sessionFor("winnie@nyuma.ke"), "decision-support").ok).toBe(true);
    expect(authorizeWorkspace(sessionFor("winnie@nyuma.ke"), "trader").ok).toBe(true);
    expect(authorizeWorkspace(sessionFor("farmer@nyuma.ke"), "farmer").ok).toBe(true);
    expect(authorizeWorkspace(sessionFor("buyer@nyuma.ke"), "buyer").ok).toBe(true);
    expect(authorizeWorkspace(sessionFor("admin@nyuma.ke"), "administrator").ok).toBe(true);
    for (const email of ["farmer@nyuma.ke", "buyer@nyuma.ke", "admin@nyuma.ke"]) {
      const result = authorizeWorkspace(sessionFor(email), "decision-support");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("forbidden");
    }
  });

  it("lets only the trader edit or save the sample scenario", () => {
    const trader = sessionFor("winnie@nyuma.ke");
    const administrator = sessionFor("admin@nyuma.ke");
    expect(authorizeAction(trader, "edit-scenario").ok).toBe(true);
    expect(authorizeAction(trader, "save-scenario").ok).toBe(true);
    expect(authorizeAction(trader, "open-decision-support").ok).toBe(true);
    expect(authorizeAction(administrator, "save-scenario").ok).toBe(false);
    expect(authorizeAction(administrator, "edit-scenario").ok).toBe(false);
    expect(authorizeAction(administrator, "open-decision-support").ok).toBe(false);
    expect(authorizeAction(sessionFor("farmer@nyuma.ke"), "edit-scenario").ok).toBe(false);
    expect(authorizeAction(sessionFor("buyer@nyuma.ke"), "edit-scenario").ok).toBe(false);
  });

  it("rejects a missing session and a session whose role was edited", () => {
    expect(authorizeWorkspace(null, "decision-support")).toMatchObject({ ok: false, reason: "missing" });
    const trader = sessionFor("winnie@nyuma.ke");
    const edited = { ...trader, role: "administrator" as const };
    expect(authorizeWorkspace(edited, "decision-support")).toMatchObject({ ok: false, reason: "missing" });
  });

  it("keeps the existing hash routes and closes the workspace without a valid session", () => {
    const trader = sessionFor("winnie@nyuma.ke");
    const farmer = sessionFor("farmer@nyuma.ke");
    expect(viewForHash("#workspace", null)).toBe("login");
    expect(viewForHash("#stock", null)).toBe("login");
    expect(viewForHash("#buyers", null)).toBe("login");
    expect(viewForHash("#allocation", null)).toBe("login");
    expect(viewForHash("#updates", null)).toBe("login");
    expect(viewForHash("#report", null)).toBe("login");
    expect(viewForHash("#login", null)).toBe("login");
    expect(viewForHash("#top", trader)).toBe("home");
    expect(viewForHash("#workspace", trader)).toBe("workspace");
    expect(viewForHash("#login", trader)).toBe("workspace");
    expect(viewForHash("#workspace", farmer)).toBe("workspace");
    expect(viewForHash("#surplus", farmer)).toBe("denied");
    expect(viewForHash("#workspace", { ...trader, role: "buyer" })).toBe("login");
  });

  it("refuses direct navigation to another role's pages", () => {
    const farmer = sessionFor("farmer@nyuma.ke");
    const buyer = sessionFor("buyer@nyuma.ke");
    const admin = sessionFor("admin@nyuma.ke");
    const trader = sessionFor("winnie@nyuma.ke");
    expect(viewForHash("#farmer", farmer)).toBe("workspace");
    expect(viewForHash("#stock", farmer)).toBe("denied");
    expect(viewForHash("#decision-support", farmer)).toBe("denied");
    expect(viewForHash("#buyer", buyer)).toBe("workspace");
    expect(viewForHash("#allocation", buyer)).toBe("denied");
    expect(viewForHash("#admin", admin)).toBe("workspace");
    expect(viewForHash("#decision-support", admin)).toBe("denied");
    expect(viewForHash("#report", admin)).toBe("denied");
    expect(viewForHash("#farmer", trader)).toBe("denied");
    expect(authorizeSection(admin, "#stock").ok).toBe(false);
    expect(authorizeSection(trader, "#allocation").ok).toBe(true);
    expect(viewForHash("#farmer-listing", farmer)).toBe("workspace");
    expect(viewForHash("#farmer-listing?id=listing-1", farmer)).toBe("workspace");
    expect(viewForHash("#stock-form", farmer)).toBe("denied");
    expect(viewForHash("#buyer-demand-form", buyer)).toBe("workspace");
    expect(viewForHash("#buyer-demand-form", farmer)).toBe("denied");
    expect(viewForHash("#stock-form", admin)).toBe("denied");
    expect(authorizeAction(farmer, "create-listing").ok).toBe(true);
    expect(authorizeAction(buyer, "create-listing").ok).toBe(false);
    expect(authorizeAction(admin, "edit-listing").ok).toBe(false);
    expect(authorizeAction(buyer, "create-demand").ok).toBe(true);
    expect(authorizeAction(trader, "create-demand").ok).toBe(false);
    expect(viewForHash("#farmer-commitment", farmer)).toBe("workspace");
    expect(viewForHash("#farmer-purchase?id=commitment-1", farmer)).toBe("workspace");
    expect(viewForHash("#buyer-commitment", buyer)).toBe("workspace");
    expect(viewForHash("#farmer-commitment", buyer)).toBe("denied");
    expect(viewForHash("#buyer-commitment", farmer)).toBe("denied");
    expect(viewForHash("#trader-commitment", trader)).toBe("workspace");
    expect(viewForHash("#trader-purchase", admin)).toBe("denied");
    expect(viewForHash("#transactions", admin)).toBe("denied");
    expect(authorizeAction(farmer, "create-commitment").ok).toBe(true);
    expect(authorizeAction(buyer, "record-purchase").ok).toBe(true);
    expect(authorizeAction(admin, "create-commitment").ok).toBe(false);
    expect(authorizeAction(admin, "cancel-commitment").ok).toBe(false);
    expect(authorizeAction(admin, "record-purchase").ok).toBe(false);
    expect(authorizeAction(farmer, "record-outcome").ok).toBe(true);
    expect(authorizeAction(sessionFor("winnie@nyuma.ke"), "record-outcome").ok).toBe(true);
    expect(authorizeAction(buyer, "record-outcome").ok).toBe(false);
    expect(authorizeAction(admin, "record-outcome").ok).toBe(false);
  });

  it("shows each role only its own navigation", () => {
    expect(navigationFor("farmer").map((item) => item.label)).toEqual([
      "Overview",
      "My listings",
      "Buyer opportunities",
      "Matches",
      "Commitments",
      "Exposure",
      "Outcomes",
      "Messages",
      "Profile",
    ]);
    expect(navigationFor("trader").map((item) => item.label)).toEqual([
      "Overview",
      "My listings",
      "Buyer demand",
      "Matches",
      "Transactions",
      "Exposure",
      "Outcomes",
      "Messages",
      "Analytics",
      "Practice scenario",
    ]);
    expect(navigationFor("buyer").map((item) => item.label)).toEqual([
      "Overview",
      "My demand",
      "Available produce",
      "Matches",
      "Commitments",
      "Open quantity",
      "Purchase history",
      "Outcomes",
      "Messages",
    ]);
    expect(navigationFor("administrator").map((item) => item.label)).toEqual([
      "Platform overview",
      "Users",
      "Listings",
      "Buyer demand",
      "Matches",
      "Transactions",
      "Exposure",
      "Outcomes",
      "Activity",
    ]);
    const farmerHashes = navigationFor("farmer").map((item) => item.hash);
    expect(farmerHashes).not.toContain("#stock");
    expect(farmerHashes).not.toContain("#allocation");
    expect(navigationFor("administrator").map((item) => item.hash)).not.toContain("#decision-support");
  });

  it("keeps sample section wording and removes browser-storage wording for a real account", () => {
    const overview = SECTIONS.find((section) => section.id === "farmer-overview");
    const exposure = SECTIONS.find((section) => section.id === "admin-exposure");
    if (!overview || !exposure) throw new Error("missing section");
    expect(presentForAccount(overview, true).description).toBe(overview.description);
    expect(presentForAccount(overview, true).description).toContain("in this browser");
    const accountOverview = presentForAccount(overview, false);
    const accountExposure = presentForAccount(exposure, false);
    expect(accountOverview.description).not.toContain("in this browser");
    expect(accountOverview.description).not.toContain("sample account");
    expect(accountOverview.description).toContain("saved for this account");
    expect(accountExposure.title).toBe("Exposure");
    expect(accountExposure.description).not.toContain("in this browser");
  });
});
