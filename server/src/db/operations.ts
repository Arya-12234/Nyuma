/**
 * Database operations that must run inside one transaction in later milestones.
 * An application check before insert is not sufficient: two requests can both
 * see remaining quantity and then both write. The lock functions take row locks
 * in a fixed order, and the table triggers reject the write if the locked totals
 * no longer fit.
 *
 * Lock order, always: users, listings, buyer_demands, commitments, purchases, outcomes.
 * Role checks lock the account row first. Commitment status changes and purchase
 * inserts lock the listing, then the buyer demand, then the commitment before writing.
 * The ordinary application role cannot update a commitment directly; it calls
 * nyuma_set_commitment_status, which takes those locks before UPDATE.
 * runTransaction retries only SQLSTATE 40P01 and 40001. It does not retry validation failures.
 */

export interface TransactionalOperation {
  name: string;
  lockFunction: string;
  locks: readonly string[];
  writes: readonly string[];
  reason: string;
}

export const transactionalOperations: readonly TransactionalOperation[] = [
  {
    name: "recordCommitment",
    lockFunction: "nyuma_lock_for_commitment",
    locks: ["listings", "buyer_demands"],
    writes: ["commitments"],
    reason:
      "The agreed quantity of every proposed or confirmed commitment, plus purchased quantity on fulfilled commitments, must stay within the listing quantity and the buyer requirement. Cancelled commitments hold nothing.",
  },
  {
    name: "updateCommitmentStatus",
    lockFunction: "nyuma_set_commitment_status",
    locks: ["listings", "buyer_demands", "commitments"],
    writes: ["commitments"],
    reason:
      "Confirming, fulfilling, or cancelling changes how much quantity the commitment holds. Fulfilment holds purchased quantity only. A commitment with a purchase cannot be cancelled.",
  },
  {
    name: "recordPurchase",
    lockFunction: "nyuma_insert_purchase",
    locks: ["listings", "buyer_demands", "commitments"],
    writes: ["purchases"],
    reason:
      "A purchase is allowed only on a confirmed commitment, must name that commitment's listing, and must not exceed the quantity still agreed. It also must not make accounted kilograms exceed the listing.",
  },
  {
    name: "recordOutcome",
    lockFunction: "nyuma_lock_for_outcome",
    locks: ["listings", "purchases"],
    writes: ["outcomes"],
    reason:
      "Outcomes plus purchase quantity that no sold outcome already covers must stay within the listing. A sold outcome linked to a purchase covers that purchase and must not be added again.",
  },
  {
    name: "protectRoleForOwnership",
    lockFunction: "nyuma_lock_user",
    locks: ["users"],
    writes: ["listings", "buyer_demands", "user_roles"],
    reason:
      "Creating a listing or buyer demand and removing a role both lock the account row first, so one cannot commit while the other has checked a stale role.",
  },
  {
    name: "reduceListingQuantity",
    lockFunction: "nyuma_lock_listing",
    locks: ["listings"],
    writes: ["listings"],
    reason: "A smaller listing quantity must still cover quantity already held and quantity already accounted for.",
  },
  {
    name: "reduceDemandQuantity",
    lockFunction: "nyuma_lock_demand",
    locks: ["buyer_demands"],
    writes: ["buyer_demands"],
    reason: "A smaller buyer requirement must still cover quantity already held by its commitments.",
  },
];
