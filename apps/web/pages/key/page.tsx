import { PageHeading, StatusBadge } from "@frely/console-ui";
import { MaterialTable } from "@frely/console-ui/material-table";
import { Card } from "@frely/ui/components/card";
import { KeyUsageLookup } from "../../features/key-usage";
import { SELF_SERVICE_ENDPOINTS } from "./self-service-endpoints";
import type { KeyPageData } from "./page.server";

export default function KeyPage({ data }: { data: KeyPageData }) {
  return (
    <>
      <PageHeading
        eyebrow="Tools / API Key Self Usage"
        title="API Key Self Usage"
        description="Enter an API key to view that key's usage and remaining budget."
      >
        <StatusBadge tone="info">{data.currentUser ? "Logged in" : "Bearer API key"}</StatusBadge>
      </PageHeading>
      <KeyUsageLookup currentUser={data.currentUser} />
      <Card className="panel">
        <h2>Self-service endpoints</h2>
        <MaterialTable
          columns={[{ header: "Resource" }, { header: "Endpoint" }]}
          rows={SELF_SERVICE_ENDPOINTS.map((item) => ({
            id: item.id,
            cells: [item.resource, <code key={item.endpoint}>{item.endpoint}</code>],
          }))}
        />
      </Card>
    </>
  );
}
