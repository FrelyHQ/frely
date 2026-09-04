import Link from "@web/navigation";
import { StatusBadge, UserApiKeysDetail } from "@frely/console-ui";
import { MaterialTablePagination } from "@frely/console-ui/material-table-pagination";
import { Button } from "@frely/ui/components/button";
import { userApiKeyDirectoryHref } from "../../../features/api-keys/lib/user-api-key-url-state";
import { WebApiKeyCreateAction, WebApiKeyLifecycleAction } from "../../../features/api-keys";
import type { UserKeysPageData } from "./page.server";

export default function UserKeysPage({ data }: { data: UserKeysPageData }) {
  const { user, directory, state } = data;
  return <UserApiKeysDetail
    user={user}
    apiKeys={directory.items}
    backHref="/user"
    backLabel="Back to Dashboard"
    eyebrow="User / Keys"
    actions={<WebApiKeyCreateAction user={user} detailHrefBase="/user/keys/" />}
    apiKeyHref={(apiKey) => `/user/keys/${apiKey.id}`}
    apiKeyRowActions={(apiKey) => <WebApiKeyLifecycleAction apiKey={apiKey} />}
    apiKeySummary={directory.summary}
    apiKeyDirectoryHeader={<form action="/user/keys" className="row-actions" method="get">
      {state.pageSize !== 20 ? <input type="hidden" name="pageSize" value={state.pageSize} /> : null}
      <StatusBadge tone="info">{directory.total} results</StatusBadge>
      <label className="sr-only" htmlFor="user-api-key-query">Search API Keys</label>
      <input id="user-api-key-query" name="q" defaultValue={state.query} maxLength={100} placeholder="Search name, prefix, or status" />
      <Button type="submit" variant="secondary">Search</Button>
      {state.query ? <Button asChild type="button" variant="ghost"><Link href="/user/keys">Clear</Link></Button> : null}
    </form>}
    apiKeyPagination={<MaterialTablePagination page={directory.page} pageSize={directory.pageSize} totalPages={directory.totalPages} total={directory.total} previousHref={directory.page > 1 ? userApiKeyDirectoryHref({ ...state, page: directory.page - 1 }) : ""} nextHref={directory.page < directory.totalPages ? userApiKeyDirectoryHref({ ...state, page: directory.page + 1 }) : ""} noun="API keys" />}
  />;
}
