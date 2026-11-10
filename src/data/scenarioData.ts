import type { Buyer, ScenarioFormState, TimeWindow } from "../types/decision";

export const DEFAULT_FORM: ScenarioFormState = {
  produce: "Watermelon",
  quantityKg: "800",
  askingPriceKsh: "40",
  location: "Kitui",
  timeRemaining: "3 hours",
  mode: "surplus",
};

export const MODE_OPTIONS = [
  { value: "surplus", label: "Surplus available" },
  { value: "purchase", label: "Planning a purchase" },
] as const;

/**
 * Fictional buyer records for the concept preview.
 * Collection "Today" means the buyer can collect at any time today.
 */
export const SAMPLE_BUYERS: readonly Buyer[] = [
  {
    id: "nairobi-fresh-produce",
    name: "Nairobi Fresh Produce",
    location: "Marikiti, Nairobi",
    produce: "Watermelon",
    quantityKg: 300,
    indicativePriceKsh: 40,
    collection: "Today",
  },
  {
    id: "city-market-traders",
    name: "City Market Traders",
    location: "Nairobi",
    produce: "Watermelon",
    quantityKg: 250,
    indicativePriceKsh: 38,
    collection: "Today",
  },
  {
    id: "green-basket-wholesale",
    name: "Green Basket Wholesale",
    location: "Nairobi",
    produce: "Watermelon",
    quantityKg: 150,
    indicativePriceKsh: 42,
    collection: "Today",
  },
];

export const DEFAULT_SELECTED_IDS: readonly string[] = SAMPLE_BUYERS.map((buyer) => buyer.id);

export const SHORT_SELLING_WINDOWS: readonly TimeWindow[] = ["2 hours", "3 hours", "4 hours"];
