import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isTimeCompatible } from "../../src/lib/decisionEngine.js";
import { listingOutcomeAccount } from "../../src/lib/outcomeAccounting.js";
import type { Listing, Outcome, Purchase } from "../../src/domain/records.js";
import type { TimeWindow } from "../../src/types/decision.js";

const windows: TimeWindow[] = ["2 hours", "3 hours", "4 hours", "Today", "Tomorrow"];

/** The same branches as nyuma_is_time_compatible in the migration. */
function migrationWindowRule(seller: TimeWindow, buyer: TimeWindow): boolean {
  if (buyer === "Today") return true;
  if (buyer === "Tomorrow") return seller === "Tomorrow";
  if (buyer === "2 hours") return (["2 hours", "3 hours", "4 hours", "Today", "Tomorrow"] as TimeWindow[]).includes(seller);
  if (buyer === "3 hours") return (["3 hours", "4 hours", "Today", "Tomorrow"] as TimeWindow[]).includes(seller);
  if (buyer === "4 hours") return (["4 hours", "Today", "Tomorrow"] as TimeWindow[]).includes(seller);
  return false;
}

const listing: Listing = {
  id: "listing-1",
  ownerId: "owner-1",
  commodity: "Watermelon",
  quantity: 100,
  quantityUnit: "kg",
  quantityKind: "available",
  location: "Kitui",
  availabilityWindow: "Today",
  askingPriceKshPerKg: 40,
  status: "open",
  createdAt: "2026-11-05T00:00:00.000Z",
  updatedAt: "2026-11-05T00:00:00.000Z",
};

const purchase: Purchase = {
  id: "purchase-1",
  commitmentId: "commitment-1",
  listingId: listing.id,
  actualQuantity: 80,
  quantityUnit: "kg",
  actualPriceKshPerKg: 40,
  purchaseDate: "2026-11-05",
  recordedAt: "2026-11-05T00:00:00.000Z",
};

const soldOutcome: Outcome = {
  id: "outcome-1",
  listingId: listing.id,
  commitmentId: "commitment-1",
  purchaseId: purchase.id,
  category: "sold",
  quantity: 80,
  quantityUnit: "kg",
  recordedDate: "2026-11-05",
  notes: "",
  recordedAt: "2026-11-05T00:00:00.000Z",
};

describe("database rules mirror the existing domain rules", () => {
  it("uses the same collection-window pairs as isTimeCompatible", () => {
    const sql = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations/001_foundation.sql"),
      "utf8",
    );
    expect(sql).toContain("WHEN buyer_collection = 'Today' THEN true");
    expect(sql).toContain("WHEN buyer_collection = 'Tomorrow' THEN seller_window = 'Tomorrow'");
    expect(sql).toContain("WHEN buyer_collection = '2 hours' THEN seller_window IN ('2 hours', '3 hours', '4 hours', 'Today', 'Tomorrow')");
    expect(sql).toContain("WHEN buyer_collection = '3 hours' THEN seller_window IN ('3 hours', '4 hours', 'Today', 'Tomorrow')");
    expect(sql).toContain("WHEN buyer_collection = '4 hours' THEN seller_window IN ('4 hours', 'Today', 'Tomorrow')");
    for (const seller of windows) {
      for (const buyer of windows) {
        expect(migrationWindowRule(seller, buyer)).toBe(isTimeCompatible(seller, buyer));
      }
    }
  });

  it("does not add a sold outcome and its purchase a second time", () => {
    const account = listingOutcomeAccount(listing, [soldOutcome], [purchase]);
    expect(account.soldKg).toBe(80);
    expect(account.purchasedWithoutSoldOutcomeKg).toBe(0);
    expect(account.unaccountedKg).toBe(20);
  });
});
