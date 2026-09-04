import { PageHeading, StatusBadge } from "@frely/console-ui";
import { UserCards } from "../../../features/cards";
import type { UserCardsPageData } from "./page.server";

export default function UserCardsPage(_props: { data: UserCardsPageData }) {
  return (
    <>
      <PageHeading eyebrow="User / My Cards" title="My Cards" description="Use or send available Cards. Choose All Cards to review used, expired, replaced, or unavailable history.">
        <StatusBadge tone="info">Available cards</StatusBadge>
      </PageHeading>
      <UserCards />
    </>
  );
}
