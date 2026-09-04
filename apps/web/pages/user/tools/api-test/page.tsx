import { PageHeading, StatusBadge } from "@frely/console-ui";
import { UserApiTest } from "../../../../features/api-test";
import type { UserApiTestPageData } from "./page.server";

export default function UserApiTestPage({ data }: { data: UserApiTestPageData }) {
  return (
    <>
      <PageHeading eyebrow="Tools / API Test" title="API Test" description="Send a real test request through the relay using your active web session and API key.">
        <StatusBadge tone={data.apiKeyCount > 0 ? "good" : "warn"}>{data.apiKeyCount > 0 ? "API key available" : "Create an API key first"}</StatusBadge>
      </PageHeading>
      <UserApiTest models={data.models} />
    </>
  );
}
