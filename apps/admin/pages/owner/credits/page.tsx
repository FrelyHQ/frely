import { CreditsView } from "../../../features/credits";
import { adminCreditsHref } from "../../../features/credits/lib/credit-url-state";
import type { AdminPageData } from "./page.server";

export default function CreditsPage({ data: loaded }: { data: AdminPageData }) {
  if (!loaded) return null;
  const { state, requestedTopupCursor, credits, topupPage, topups, configuration, draftChannelPage, draftChannels } = loaded;
  return <CreditsView
    state={{ ...state, page: credits.page, scopePage: credits.scopePage, configurationPage: draftChannelPage.page }}
    credits={credits}
    topups={topups}
    topupCursor={requestedTopupCursor}
    topupNextHref={topupPage.nextCursor ? adminCreditsHref({ ...state, page: credits.page, scopePage: credits.scopePage, configurationPage: draftChannelPage.page, topupCursor: topupPage.nextCursor }) : ""}
    configuration={configuration}
    draftChannels={draftChannels}
    configurationPage={draftChannelPage}
  />;
}
