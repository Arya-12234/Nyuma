import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RoleWorkspace } from "../components/RoleWorkspace";
import { TraderWorkspace } from "../components/workspaces/TraderWorkspace";
import { SECTIONS } from "./access";
import { signIn } from "./auth";
import { SAMPLE_USERS, type SampleSession } from "./sampleUsers";

function sessionFor(email: string): SampleSession {
  const account = SAMPLE_USERS.find((item) => item.email === email);
  if (!account) throw new Error(`missing sample account ${email}`);
  const result = signIn(account.email, account.password);
  if (!result.ok) throw new Error(`sample sign-in failed for ${email}`);
  return result.user;
}

function page(email: string, hash: string): string {
  return renderToStaticMarkup(<RoleWorkspace user={sessionFor(email)} hash={hash} onSignOut={() => undefined} />)
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

describe("role workspaces", () => {
  it("renders the farmer workspace with an empty listing state and no trader scenario", () => {
    const html = page("farmer@nyuma.ke", "#workspace");
    expect(html).toContain("Your produce");
    expect(html).toContain("Add produce");
    expect(html).toContain("Loading your listings");
    expect(html).toContain("My listings");
    expect(html).toContain("#farmer-listings");
    expect(html).not.toContain("produce-type");
    expect(html).not.toContain("#stock");
    expect(html).toContain("Log out");
    expect(html).toContain("workspace-menu");
  });

  it("renders the trader overview from saved records, not the watermelon scenario", () => {
    const html = page("winnie@nyuma.ke", "#workspace");
    expect(html).toContain("Welcome back, Winnie");
    expect(html).toContain("Checking saved records");
    expect(html).toContain("Saved listings, buyer requirements, agreements, purchases, and exposure");
    expect(html).not.toContain("700 kg could be matched");
    expect(html).not.toContain("28,000");
    expect(html).not.toContain("produce-type");
    expect(html).not.toContain("Nairobi Fresh Produce");
    expect(html).toContain("Buyer demand");
    expect(html).toContain("Analytics");
    expect(html).toContain("Practice scenario");
    expect(html).toContain("#practice-scenario");
    expect(html).not.toContain("#farmer-listings");
  });

  it("keeps the practice scenario separate from saved records", () => {
    const html = page("winnie@nyuma.ke", "#practice-scenario");
    expect(html).toContain("illustrative sample");
    expect(html).toContain("not an actual buyer commitment");
    expect(html).toContain("not confirmed revenue");
    expect(html).toContain("700 kg could be matched");
    expect(html).toContain("100 kg remains unallocated");
    expect(html).toContain("28,000");
    expect(html).toContain("87.5%");
    expect(html).toContain(">Save<");
    expect(html).toContain(">Reset<");
    expect(html).toContain("produce-type");
    expect(html).toContain("Nairobi Fresh Produce");
    expect(page("farmer@nyuma.ke", "#practice-scenario")).toContain("cannot open this page");
    expect(page("admin@nyuma.ke", "#practice-scenario")).toContain("cannot open this page");
  });

  it("opens buyer demand and matches on saved records, and keeps transactions and outcomes", () => {
    const demand = page("winnie@nyuma.ke", "#buyers");
    expect(demand).toContain("Buyer demand");
    expect(demand).toContain("Checking saved requirements");
    expect(demand).not.toContain("Nairobi Fresh Produce");
    expect(demand).not.toContain("produce-type");
    const matches = page("winnie@nyuma.ke", "#allocation");
    expect(matches).toContain("Potential matches");
    expect(matches).toContain("Checking saved listings");
    expect(matches).not.toContain("700 kg could be matched");
    expect(matches).not.toContain("28,000");
    const transactions = page("winnie@nyuma.ke", "#transactions");
    expect(transactions).toContain("Record an agreement");
    expect(transactions).toContain("Loading agreements");
    expect(page("winnie@nyuma.ke", "#trader-outcomes")).toContain("Produce outcomes");
    expect(page("winnie@nyuma.ke", "#analytics")).not.toContain("28,000");
  });

  it("shows the trader listing page without treating a listing as a sale", () => {
    const html = page("winnie@nyuma.ke", "#stock");
    expect(html).toContain("Add produce");
    expect(html).toContain("Loading your listings");
    expect(html).toContain("not an agreement or a sale");
    const transactions = page("winnie@nyuma.ke", "#transactions");
    expect(transactions).toContain("Record an agreement");
    expect(transactions).toContain("Loading agreements");
    expect(transactions).not.toContain(">Save<");
  });

  it("renders the buyer workspace from empty demand, not fabricated customers", () => {
    const html = page("buyer@nyuma.ke", "#buyer");
    expect(html).toContain("Your procurement");
    expect(html).toContain("Submit a requirement");
    expect(html).toContain("Loading your requirements");
    expect(html).toContain("Purchase history");
    expect(html).not.toContain("produce-type");
    expect(html).not.toContain("Nairobi Fresh Produce");
    expect(page("buyer@nyuma.ke", "#allocation")).toContain("cannot open this page");
  });

  it("renders the administrator overview without trader editing or invented activity", () => {
    const html = page("admin@nyuma.ke", "#admin");
    expect(html).toContain("Platform overview");
    expect(html).toContain("Sample Farmer");
    expect(html).not.toContain("produce-type");
    expect(html).not.toContain(">Save<");
    expect(page("admin@nyuma.ke", "#admin-users")).toContain("Sample Buyer");
    expect(page("admin@nyuma.ke", "#decision-support")).toContain("cannot open this page");
    expect(page("admin@nyuma.ke", "#report")).toContain("cannot open this page");
  });

  it("refuses the trader scenario controls for every other role", () => {
    const section = SECTIONS.find((item) => item.id === "trader-practice");
    if (!section) throw new Error("missing practice scenario");
    for (const email of ["farmer@nyuma.ke", "buyer@nyuma.ke", "admin@nyuma.ke"]) {
      const html = renderToStaticMarkup(
        <TraderWorkspace user={sessionFor(email)} section={section} hash="#decision-support" />,
      );
      expect(html).toContain("cannot edit the trader scenario");
      expect(html).toContain("cannot save the trader scenario");
      expect(html).not.toContain(">Save<");
      expect(html).not.toContain("produce-type");
    }
  });

  it("renders mobile-friendly listing and demand forms and refuses the wrong role", () => {
    const listingForm = page("farmer@nyuma.ke", "#farmer-listing");
    expect(listingForm).toContain('data-form="listing"');
    expect(listingForm).toContain("form-stack");
    expect(listingForm).toContain("decimal");
    expect(listingForm).toContain('for="listing-quantity"');
    expect(listingForm).toContain("Save draft");
    expect(listingForm).toContain("Expected harvest");
    expect(listingForm).toContain("Cancel");
    expect(page("buyer@nyuma.ke", "#farmer-listing")).toContain("cannot open this page");
    expect(page("farmer@nyuma.ke", "#buyer-demand-form")).toContain("cannot open this page");
    const demandForm = page("buyer@nyuma.ke", "#buyer-demand-form");
    expect(demandForm).toContain('data-form="demand"');
    expect(demandForm).toContain("Submit requirement");
    expect(demandForm).toContain('for="demand-quantity"');
    expect(demandForm).not.toContain("Save draft");
    const agreement = page("farmer@nyuma.ke", "#farmer-commitment");
    expect(agreement).toContain('data-form="commitment"');
    expect(agreement).toContain("Agreed quantity");
    expect(agreement).toContain("KSh/kg");
    expect(agreement).toContain("We have agreed this quantity and price.");
    expect(agreement).toContain("Record agreement");
    expect(agreement).toContain("for=\"commitment-quantity\"");
    expect(page("buyer@nyuma.ke", "#farmer-commitment")).toContain("cannot open this page");
    expect(page("admin@nyuma.ke", "#admin-transactions")).toContain("View only");
    expect(page("admin@nyuma.ke", "#admin-transactions")).not.toContain("Record an agreement");
    expect(page("admin@nyuma.ke", "#trader-commitment")).toContain("cannot open this page");
    const exposure = page("winnie@nyuma.ke", "#trader-exposure");
    expect(exposure).toContain("Unsold exposure");
    expect(exposure).toContain("Loading saved listings");
    expect(exposure).not.toContain("28,000");
    expect(exposure).not.toContain("700 kg could be matched");
    expect(page("farmer@nyuma.ke", "#farmer-exposure")).toContain("Your exposure");
    expect(page("buyer@nyuma.ke", "#farmer-exposure")).toContain("cannot open this page");
    expect(page("buyer@nyuma.ke", "#buyer-exposure")).toContain("Uncommitted demand");
    expect(page("farmer@nyuma.ke", "#buyer-exposure")).toContain("cannot open this page");
    const adminExposure = page("admin@nyuma.ke", "#admin-exposure");
    expect(adminExposure).toContain("Exposure in this browser");
    expect(adminExposure).toContain("Loading saved listings");
    expect(adminExposure).not.toContain("Record a purchase");
    expect(page("admin@nyuma.ke", "#trader-exposure")).toContain("cannot open this page");
    const farmerOutcomes = page("farmer@nyuma.ke", "#farmer-outcomes");
    expect(farmerOutcomes).toContain("Produce outcomes");
    expect(farmerOutcomes).toContain("What happened to this produce?");
    expect(farmerOutcomes).toContain('data-form="outcome"');
    expect(page("buyer@nyuma.ke", "#farmer-outcomes")).toContain("cannot open this page");
    const traderOutcomes = page("winnie@nyuma.ke", "#trader-outcomes");
    expect(traderOutcomes).toContain("Produce outcomes");
    expect(traderOutcomes).not.toContain("28,000");
    expect(traderOutcomes).not.toContain("700 kg could be matched");
    const buyerOutcomes = page("buyer@nyuma.ke", "#buyer-outcomes");
    expect(buyerOutcomes).toContain("Related outcomes");
    expect(buyerOutcomes).toContain("View purchase history");
    expect(buyerOutcomes).not.toContain("Save outcome");
    const adminOutcomes = page("admin@nyuma.ke", "#admin-outcomes");
    expect(adminOutcomes).toContain("Outcomes in this browser");
    expect(adminOutcomes).toContain("view only");
    expect(adminOutcomes).not.toContain("Save outcome");
    expect(page("farmer@nyuma.ke", "#admin-outcomes")).toContain("cannot open this page");
  });

  it("includes a menu button that opens the workspace navigation", () => {
    const html = page("farmer@nyuma.ke", "#farmer");
    expect(html).toContain('class="workspace-menu"');
    expect(html).toContain('aria-controls="workspace-nav"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Workspace"');
  });
});
