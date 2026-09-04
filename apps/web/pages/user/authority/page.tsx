import { PageHeading, StatusBadge } from "@frely/console-ui";
import { UserAuthority } from "../../../features/authority";
import type { UserAuthorityPageData } from "./page.server";

export default function UserAuthorityPage({ data }: { data: UserAuthorityPageData }) {
  return (
    <>
      <PageHeading eyebrow="User / Authority" title="Authority" description="Purchase Team Grants or personal Codex Provider slots."><StatusBadge tone="info">Credit purchase</StatusBadge></PageHeading>
      <UserAuthority
        products={data.products}
        grants={data.grants}
        canCreateTeam={data.canCreateTeam}
        personalCreditBalanceUnits={data.personalCreditBalanceUnits}
        personalProviderProduct={data.personalProviderProduct}
        providerSlots={data.providerSlots}
        providerSlotTotal={data.providerSlotTotal}
      />
    </>
  );
}
