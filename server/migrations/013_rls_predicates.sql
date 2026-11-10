-- Migration 013. Six RLS predicate helpers only.
-- This migration does not create policies, enable RLS, force RLS, or change existing grants.
-- Identity inside each helper is nyuma_verified_account_id(), which is null unless
-- nyuma_verified_sub() matches an active account. A caller-supplied uuid is compared
-- with that account; it is not an identity source.

CREATE FUNCTION public.nyuma_listing_owner_access(p_owner_id uuid)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles AS roles
    WHERE roles.user_id = public.nyuma_verified_account_id()
      AND roles.user_id = p_owner_id
      AND roles.role IN ('farmer', 'trader')
  );
$fn$;

CREATE FUNCTION public.nyuma_demand_owner_access(p_buyer_id uuid)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles AS roles
    WHERE roles.user_id = public.nyuma_verified_account_id()
      AND roles.user_id = p_buyer_id
      AND roles.role = 'buyer'
  );
$fn$;

CREATE FUNCTION public.nyuma_commitment_participant(p_commitment_id text)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT EXISTS (
    SELECT 1
    FROM public.commitments AS commitment
    JOIN public.listings AS listing ON listing.id = commitment.listing_id
    JOIN public.buyer_demands AS demand ON demand.id = commitment.buyer_demand_id
    WHERE commitment.id = p_commitment_id
      AND (
        EXISTS (
          SELECT 1 FROM public.user_roles AS roles
          WHERE roles.user_id = public.nyuma_verified_account_id()
            AND roles.user_id = listing.owner_id
            AND roles.role IN ('farmer', 'trader')
        )
        OR EXISTS (
          SELECT 1 FROM public.user_roles AS roles
          WHERE roles.user_id = public.nyuma_verified_account_id()
            AND roles.user_id = demand.buyer_id
            AND roles.role = 'buyer'
        )
      )
  );
$fn$;

CREATE FUNCTION public.nyuma_purchase_participant(p_purchase_id text)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT EXISTS (
    SELECT 1
    FROM public.purchases AS purchase
    JOIN public.commitments AS commitment ON commitment.id = purchase.commitment_id
    WHERE purchase.id = p_purchase_id
      AND public.nyuma_commitment_participant(commitment.id)
  );
$fn$;

CREATE FUNCTION public.nyuma_outcome_listing_owner(p_outcome_id text)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT EXISTS (
    SELECT 1
    FROM public.outcomes AS outcome
    JOIN public.listings AS listing ON listing.id = outcome.listing_id
    WHERE outcome.id = p_outcome_id
      AND public.nyuma_listing_owner_access(listing.owner_id)
  );
$fn$;

CREATE FUNCTION public.nyuma_outcome_buyer(p_outcome_id text)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT EXISTS (
    SELECT 1
    FROM public.outcomes AS outcome
    JOIN public.purchases AS purchase ON purchase.id = outcome.purchase_id
    JOIN public.commitments AS commitment ON commitment.id = purchase.commitment_id
    JOIN public.buyer_demands AS demand ON demand.id = commitment.buyer_demand_id
    WHERE outcome.id = p_outcome_id
      AND outcome.category = 'sold'
      AND public.nyuma_demand_owner_access(demand.buyer_id)
  );
$fn$;

ALTER FUNCTION public.nyuma_listing_owner_access(uuid) OWNER TO nyuma_fn_constraint;
ALTER FUNCTION public.nyuma_demand_owner_access(uuid) OWNER TO nyuma_fn_constraint;
ALTER FUNCTION public.nyuma_commitment_participant(text) OWNER TO nyuma_fn_constraint;
ALTER FUNCTION public.nyuma_purchase_participant(text) OWNER TO nyuma_fn_constraint;
ALTER FUNCTION public.nyuma_outcome_listing_owner(text) OWNER TO nyuma_fn_constraint;
ALTER FUNCTION public.nyuma_outcome_buyer(text) OWNER TO nyuma_fn_constraint;

REVOKE ALL ON FUNCTION public.nyuma_listing_owner_access(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.nyuma_demand_owner_access(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.nyuma_commitment_participant(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.nyuma_purchase_participant(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.nyuma_outcome_listing_owner(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.nyuma_outcome_buyer(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.nyuma_listing_owner_access(uuid) TO nyuma_app;
GRANT EXECUTE ON FUNCTION public.nyuma_demand_owner_access(uuid) TO nyuma_app;
GRANT EXECUTE ON FUNCTION public.nyuma_commitment_participant(text) TO nyuma_app;
GRANT EXECUTE ON FUNCTION public.nyuma_purchase_participant(text) TO nyuma_app;
GRANT EXECUTE ON FUNCTION public.nyuma_outcome_listing_owner(text) TO nyuma_app;
GRANT EXECUTE ON FUNCTION public.nyuma_outcome_buyer(text) TO nyuma_app;
