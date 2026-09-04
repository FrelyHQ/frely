import Link from "@web/navigation";
import { UserAudienceDetail } from "@frely/console-ui";
import { PlanBudgetCompactSummary } from "@frely/console-ui/plan-budget";
import { MaterialTablePagination } from "@frely/console-ui/material-table-pagination";
import { Button } from "@frely/ui/components/button";
import { WebApiKeyCreateAction, WebApiKeyLifecycleAction } from "../../../features/api-keys";
import type { WebUserDetailPageData } from "./page.server";

export default function WebUserDetailPage({ data }: { data: WebUserDetailPageData }) {
  const { detail, userId, memberTeamId, isSelf } = data;
  return <>
    <UserAudienceDetail
      model={detail}
      backHref={memberTeamId ? `/user/team/${encodeURIComponent(memberTeamId)}` : "/user"}
      backLabel={memberTeamId ? "Back to Team" : "Back to User Console"}
      eyebrow="User Details"
      actions={isSelf ? <WebApiKeyCreateAction user={detail.user} detailHrefBase="/user/keys/" /> : null}
      apiKeyPagination={detail.apiKeys ? <MaterialTablePagination page={detail.apiKeys.page} pageSize={detail.apiKeys.pageSize} total={detail.apiKeys.total} totalPages={detail.apiKeys.totalPages} pageParam="keyPage" pageSizeParam="keyPageSize" previousHref={detail.apiKeys.page > 1 ? userDetailHref(userId, memberTeamId, detail.apiKeys.page - 1, detail.apiKeys.pageSize) : ""} nextHref={detail.apiKeys.page < detail.apiKeys.totalPages ? userDetailHref(userId, memberTeamId, detail.apiKeys.page + 1, detail.apiKeys.pageSize) : ""} noun="API keys" /> : null}
      {...(isSelf ? { apiKeyHref: (apiKey) => `/user/keys/${apiKey.id}` } : {})}
      {...(isSelf ? { apiKeyRowActions: (apiKey) => <WebApiKeyLifecycleAction apiKey={apiKey} /> } : {})}
    />
    {(isSelf || data.canReadMemberBudget) ? <PlanBudgetCompactSummary sources={data.planBudgetSources} calculatedAt={data.calculatedAt} action={isSelf ? <Button asChild variant="secondary"><Link href="/user/plans-and-budgets/budget">View full budget</Link></Button> : null} /> : null}
  </>;
}

function userDetailHref(userId: string, teamId: string, page: number, pageSize: number) {
  const params = new URLSearchParams();
  if (teamId) params.set("teamId", teamId);
  if (page > 1) params.set("keyPage", String(page));
  if (pageSize !== 20) params.set("keyPageSize", String(pageSize));
  const query = params.toString();
  return `/user/${encodeURIComponent(userId)}${query ? `?${query}` : ""}`;
}
