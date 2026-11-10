/** Copy shared by the workspaces and their tests. These screens do not invent records. */

export const DEMO_SCENARIO_NOTE =
  "Demonstration scenario. The buyers in it are sample records, not customers. A match is not a completed sale, a commitment, or a purchase.";

export const LATER_LISTING =
  "Adding a listing comes in a later step, so this page has no form.";

export const LATER_DEMAND =
  "Submitting a purchasing requirement comes in a later step, so this page has no form.";

export const EMPTY = {
  farmerListings: {
    title: "You haven't listed any produce yet.",
    body: "Start by adding your expected harvest.",
  },
  farmerOpportunities: {
    title: "No buyer opportunities yet.",
    body: "Buyer demand will appear here after a buyer submits a purchasing requirement. Nothing has been recorded.",
  },
  farmerMatches: {
    title: "No matches yet.",
    body: "Matches appear after you list produce and a recorded buyer requirement can take it.",
  },
  traderListings: {
    title: "No active listings yet.",
    body: "Create a listing to start coordinating your produce.",
  },
  traderTransactions: {
    title: "No transactions yet.",
    body: "Confirmed commitments and actual purchases will appear here. The demonstration match is not a sale.",
  },
  buyerDemand: {
    title: "You haven't submitted any purchasing requirements.",
    body: "Add your demand to discover available produce.",
  },
  buyerProduce: {
    title: "No produce is available to review.",
    body: "Listings from farmers and traders will appear here when they have been recorded.",
  },
  buyerMatches: {
    title: "No potential supply matches.",
    body: "Matches need a purchasing requirement and a recorded listing. Neither is on this account.",
  },
  buyerCommitments: {
    title: "No active commitments.",
    body: "A commitment is recorded when a quantity is agreed. None has been recorded.",
  },
  buyerPurchases: {
    title: "No completed purchases.",
    body: "Purchases appear here after they are recorded. There is no purchase history on this account.",
  },
  messages: {
    title: "No messages yet.",
    body: "Messages between farmers, traders, and buyers are not part of this version.",
  },
  adminActivity: {
    title: "No coordination activity has been recorded yet.",
    body: "Listings, demand, matches, and transactions will show here when they exist. Sample accounts are not activity.",
  },
  adminListings: {
    title: "No listings have been recorded.",
    body: "The trader demonstration scenario is not a platform listing.",
  },
  adminDemand: {
    title: "No buyer demand has been recorded.",
    body: "Sample buyers in the trader scenario are not purchasing requirements on the platform.",
  },
  adminMatches: {
    title: "No matches have been recorded.",
    body: "A result in the trader demonstration is not a platform match.",
  },
  adminTransactions: {
    title: "No transactions have been recorded.",
    body: "Commitments and purchases will appear here when they exist.",
  },
} as const;
