import Link from "@web/navigation";
import { PageHeading, StatusBadge } from "@frely/console-ui";
import { Button } from "@frely/ui/components/button";
import { Card } from "@frely/ui/components/card";
import type { AccountPageData } from "./page.server";

export default function AccountPage({ data }: { data: AccountPageData }) {
  const user = data.view.user;
  return (
    <>
      <PageHeading eyebrow="Account" title={user.name} description="Review the identity, status, and tenancy context visible to your web session." maskTitle>
        <StatusBadge tone={user.status === "Active" ? "good" : "warn"}>{user.status}</StatusBadge>
        <Button variant="secondary" asChild><Link href="/user/account/security">Security</Link></Button>
      </PageHeading>
      <section className="split-grid">
        <Card className="panel">
          <div className="panel-heading"><div><h2>Profile</h2><p className="muted">User-visible identity and lifecycle state.</p></div><StatusBadge tone="info">{user.role}</StatusBadge></div>
          <div className="detail-list">
            <div><span>Email</span><strong data-clarity-mask="true">{user.email}</strong></div>
            <div><span>Status</span><strong>{user.status}</strong></div>
            <div><span>Created At</span><strong data-clarity-mask="true">{user.createdAt}</strong></div>
            <div><span>Last Seen</span><strong data-clarity-mask="true">{user.lastSeen}</strong></div>
          </div>
        </Card>
        <Card className="panel hierarchy-panel technical-details-panel">
          <div className="panel-heading"><div><h2>Technical details</h2><p className="muted">Identifiers and runtime scope context for integration support.</p></div></div>
          <details className="technical-details" open>
            <summary>View scope and identifiers</summary>
            <div className="detail-list">
              <div><span>User ID</span><code data-clarity-mask="true">{user.id}</code></div>
              <div><span>User Scope</span><code data-clarity-mask="true">user:{data.claims.sub}</code></div>
              <div><span>Primary Team ID</span><code data-clarity-mask="true">{user.teamId || "No enabled team"}</code></div>
              <div><span>Team Owner Roles</span><strong data-clarity-mask="true">{data.claims.teamRoles.length}</strong></div>
              <div><span>API Key Limit</span><strong data-clarity-mask="true">{user.apiKeyLimit}</strong></div>
            </div>
          </details>
        </Card>
      </section>
    </>
  );
}
