export const PRODUCE_TYPES = ["Watermelon", "Mango", "Tomato", "Banana", "Other"] as const;
export type ProduceType = (typeof PRODUCE_TYPES)[number];

export const LOCATIONS = ["Kitui", "Nairobi", "Other"] as const;
export type Location = (typeof LOCATIONS)[number];

export const TIME_WINDOWS = ["2 hours", "3 hours", "4 hours", "Today", "Tomorrow"] as const;
export type TimeWindow = (typeof TIME_WINDOWS)[number];

export const SCENARIO_MODES = ["surplus", "purchase"] as const;
export type ScenarioMode = (typeof SCENARIO_MODES)[number];

export interface ScenarioFormState {
  produce: ProduceType;
  quantityKg: string;
  askingPriceKsh: string;
  location: Location;
  timeRemaining: TimeWindow;
  mode: ScenarioMode;
}

export interface ProduceScenario {
  produce: ProduceType;
  quantityKg: number;
  askingPriceKsh: number;
  location: Location;
  timeRemaining: TimeWindow;
  mode: ScenarioMode;
}

export interface Buyer {
  id: string;
  name: string;
  location: string;
  produce: ProduceType;
  quantityKg: number;
  indicativePriceKsh: number;
  collection: TimeWindow;
}

export interface BuyerMatch {
  buyer: Buyer;
  selected: boolean;
  produceMatch: boolean;
  timeMatch: boolean;
  eligible: boolean;
  statusLabel: string;
  reasons: string[];
}

export interface BuyerAllocation {
  buyerId: string;
  buyerName: string;
  location: string;
  produce: ProduceType;
  collection: TimeWindow;
  requestedKg: number;
  allocatedKg: number;
  indicativePriceKsh: number;
  selected: boolean;
  produceMatch: boolean;
  timeMatch: boolean;
  eligible: boolean;
  statusLabel: string;
  reasons: string[];
  allocationNote: string | null;
}

export interface PriceComparison {
  askingPriceKsh: number;
  lowestIndicativeKsh: number | null;
  highestIndicativeKsh: number | null;
  weightedAverageIndicativeKsh: number | null;
  indicativeAllocationValueKsh: number | null;
  differenceTotalKsh: number | null;
  differencePerKgKsh: number | null;
}

export interface DecisionMetrics {
  availableQuantityKg: number;
  eligibleDemandKg: number;
  potentiallyMatchedKg: number;
  unallocatedKg: number;
  demandCoveragePercent: number | null;
  indicativeGrossSalesKsh: number;
  priceComparison: PriceComparison;
}

export interface Recommendation {
  id: string;
  message: string;
  explanation: string;
}

export interface DecisionResult {
  allocations: BuyerAllocation[];
  metrics: DecisionMetrics;
  recommendations: Recommendation[];
}

export interface FormErrors {
  produce?: string;
  quantityKg?: string;
  askingPriceKsh?: string;
  location?: string;
  timeRemaining?: string;
  mode?: string;
}

export interface PersistedScenario {
  version: 1;
  scenario: ScenarioFormState;
  selectedBuyerIds: string[];
}
