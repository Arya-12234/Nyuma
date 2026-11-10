import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SessionUser } from "../../lib/auth";
import { AgreementDesk } from "./AgreementDesk";
import { OutcomeDesk, OutcomeNote } from "./OutcomeDesk";

const farmer: SessionUser = {
  version: 1,
  id: "8a2c1b7e-1c2d-4e5f-a6b7-c8d9e0f1a2b3",
  name: "Account",
  email: "person@example.com",
  role: "farmer",
  sample: false,
  grantedRoles: ["farmer"],
};

describe("authenticated activity desks", () => {
  it("opens the agreement and outcome desks without sample storage copy", () => {
    const agreements = renderToStaticMarkup(
      <AgreementDesk user={farmer} mode="list" side="listing" listHash="#farmer-commitments" formHash="#farmer-commitment" purchaseHash="#farmer-purchase" recordId={null} />,
    );
    expect(agreements).toContain("Loading agreements");
    expect(agreements).toContain("Record an agreement");
    expect(agreements).not.toContain("not available for this account yet");
    expect(agreements).not.toContain("saved in this browser");
    expect(agreements).not.toContain("nyuma.coordination.v1");
    const outcomes = renderToStaticMarkup(<OutcomeDesk user={farmer} mode="record" />);
    expect(outcomes).toContain("Loading saved listings");
    expect(outcomes).toContain('data-form="outcome"');
    expect(outcomes).toContain("What happened to this produce?");
    expect(outcomes).not.toContain("not available for this account yet");
    expect(outcomes).not.toContain("/market/agreements");
  });

  it("shows withheld buyer notes as unavailable and keeps an owner's note", () => {
    expect(renderToStaticMarkup(<OutcomeNote notes={null} buyer />)).toContain("Notes are not available.");
    expect(renderToStaticMarkup(<OutcomeNote notes="Collected in Kitui" buyer={false} />)).toContain("Collected in Kitui");
    expect(renderToStaticMarkup(<OutcomeNote notes="Collected in Kitui" buyer />)).toBe("");
    expect(renderToStaticMarkup(<OutcomeNote notes="" buyer={false} />)).toBe("");
  });
});
