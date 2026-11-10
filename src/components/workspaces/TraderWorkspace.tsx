import { recordIdFromHash, type WorkspaceSection } from "../../lib/access";
import type { SessionUser } from "../../lib/auth";
import { EMPTY } from "../../lib/workspaceContent";
import { AgreementDesk } from "../coordination/AgreementDesk";
import { ListingManager } from "../coordination/ListingManager";
import { OutcomeDesk } from "../coordination/OutcomeDesk";
import { SurplusDesk } from "../coordination/SurplusDesk";
import { useCoordination } from "../coordination/useCoordination";
import { EmptyState } from "../EmptyState";
import { PracticeScenario } from "./PracticeScenario";
import {
  TraderAnalyticsView,
  TraderDemandView,
  TraderMatchesView,
  TraderOverviewView,
} from "./TraderCoordination";

export function TraderWorkspace({
  user,
  section,
  hash,
}: {
  user: SessionUser;
  section: WorkspaceSection;
  hash: string;
}) {
  const coordination = useCoordination(user);

  if (section.id === "trader-listing-form") {
    return (
      <ListingManager
        user={user}
        mode="form"
        formHash="#stock-form"
        listHash="#stock"
        recordId={recordIdFromHash(hash)}
      />
    );
  }
  if (section.id === "trader-listings") {
    return (
      <>
        <p className="setup-note">These are your saved listings. A listing is not an agreement or a sale.</p>
        <ListingManager
          user={user}
          mode="list"
          formHash="#stock-form"
          listHash="#stock"
          recordId={null}
          emptyTitle={EMPTY.traderListings.title}
          emptyBody={EMPTY.traderListings.body}
        />
      </>
    );
  }
  if (section.id === "trader-exposure") return <SurplusDesk user={user} audience="trader" />;
  if (section.id === "trader-outcomes") return <OutcomeDesk user={user} mode="record" />;
  if (section.id === "trader-commitment-form" || section.id === "trader-purchase-form" || section.id === "trader-transactions") {
    return (
      <AgreementDesk
        user={user}
        mode={section.id === "trader-commitment-form" ? "form" : section.id === "trader-purchase-form" ? "purchase" : "list"}
        side="listing"
        listHash="#transactions"
        formHash="#trader-commitment"
        purchaseHash="#trader-purchase"
        recordId={recordIdFromHash(hash)}
      />
    );
  }
  if (section.id === "trader-messages") return <EmptyState {...EMPTY.messages} />;
  if (section.id === "trader-practice" || section.id === "trader-report" || section.id === "trader-surplus") {
    return <PracticeScenario user={user} />;
  }
  if (section.id === "trader-demand") return <TraderDemandView data={coordination} sample={user.sample} />;
  if (section.id === "trader-matches") return <TraderMatchesView user={user} data={coordination} />;
  if (section.id === "trader-analytics") return <TraderAnalyticsView user={user} data={coordination} />;
  return <TraderOverviewView user={user} data={coordination} />;
}
