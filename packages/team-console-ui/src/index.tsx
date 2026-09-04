import type { ReactNode } from "react";
import { MetricCard, ProgressBar, StatusBadge } from "@frely/console-ui";
import { Card } from "@frely/ui/components/card";
import { formatUtcDateTime } from "@frely/ui/lib/date-time";
import { TeamAccessPointsTable, TeamMembersTable, TeamPlansTable } from "./team-detail-tables.js";

export interface TeamRow {
  initials: string;
  name: string;
  id: string;
  ownerId: string;
  status: string;
  members: string;
  usage: number;
  planName: string;
  planState: string;
  planWindow: string;
  planEffectiveStart: string | null;
  planEffectiveEnd: string | null;
  budget: string;
  budgetState: string;
  accessCoverage: string;
  canManageMemberApiKeyLimit: boolean;
  canManageMemberCredit: boolean;
  teamOwnerCanCreateCustomProvider: boolean;
  teamOwnerCanCreateAccessPoint: boolean;
  createdAt: string;
  createdAtIso: string;
}

export interface TeamUserRow {
  id: string;
  teamId: string;
  name: string;
  email: string;
  role: string;
  status: string;
  apiKeys: string;
  apiKeyLimit: number;
  lastSeen: string;
  lastSeenAt: string | null;
  createdAt: string;
  createdAtIso: string;
}

export interface TeamAccessPointRow {
  id: string;
  name: string;
  description: string | null;
  apiFamily: string;
  exposedModel: string;
  targetModel: string;
  targetType: string;
  targetLabel: string;
  status: string;
  priority: number;
  fallbackOrder: number;
  price: string;
}

export interface TeamPlanRow {
  id: string;
  planTemplateId: string;
  templateName: string;
  billingMode: string;
  planStatus: "enabled" | "closed" | "disabled" | "missing";
  status: string;
  priority: number;
  effectiveStart: string;
  effectiveEnd: string | null;
  duration: string;
  price: string;
  budgetSummary: string;
  includedAccessPoints: string;
}

export type TeamPlanStatusFilter = "enabled" | "closed" | "disabled" | "all";

export type TeamAccessLevel = "owner" | "team-admin" | "team-reader" | "user";

export type ExpenseSafetyCheckPerspective = "teamOwner" | "member";

export interface ExpenseSafetyCheckRow {
  code: string;
  level: "warning";
  affectedSubscriptionCount: number;
  earliestEffectiveEnd: string | null;
}

export interface ExpenseSafetyCheckGroup {
  perspective: ExpenseSafetyCheckPerspective;
  checks: ExpenseSafetyCheckRow[];
}

export interface TeamDetailViewProps {
  team: TeamRow;
  users: TeamUserRow[];
  accessPoints?: TeamAccessPointRow[];
  plans?: TeamPlanRow[];
  accessLevel: TeamAccessLevel;
  audienceControl?: ReactNode;
  actions?: ReactNode;
  planActions?: ReactNode;
  plansFilter?: ReactNode;
  membersHeaderActions?: ReactNode;
  membersPagination?: ReactNode;
  accessPointsPagination?: ReactNode;
  plansPagination?: ReactNode;
  memberTotal?: number;
  accessPointTotal?: number;
  planTotal?: number;
  planStatusFilter?: TeamPlanStatusFilter;
  memberActions?: ((user: TeamUserRow) => ReactNode) | undefined;
  memberApiKeyLimitAction?: ((user: TeamUserRow) => ReactNode) | undefined;
  dangerZone?: ReactNode;
  userHref?: (user: TeamUserRow) => string;
  planBudget?: ReactNode;
  budgetOverview?: { activeSources: number; limitCount: number; exhaustedCount: number; earliestReset: string | null };
  expenseSafetyChecks?: ExpenseSafetyCheckGroup[];
}

export function TeamDetailView({ team, users, accessPoints = [], plans = [], accessLevel, audienceControl, actions, planActions, plansFilter, membersHeaderActions, membersPagination, accessPointsPagination, plansPagination, memberTotal = users.length, accessPointTotal = accessPoints.length, planTotal = plans.length, planStatusFilter = "enabled", memberActions, memberApiKeyLimitAction, dangerZone, userHref, planBudget, budgetOverview, expenseSafetyChecks = [] }: TeamDetailViewProps) {
  const activeUsers = users.filter((user) => user.status === "Active").length;
  const canSeeAccessCoverage = accessLevel === "owner";
  const canSeeTeamAccessPoints = accessLevel === "owner";
  const canSeeTeamMembers = accessLevel === "owner" || accessLevel === "team-admin" || accessLevel === "team-reader";
  const hasMemberActions = Boolean(memberActions);

  return (
    <>
      <section className="team-detail-heading page-heading">
        <div>
          <p className="eyebrow">{accessLevel === "owner" ? "Team Details" : "Team Console"}</p>
          <h1 data-clarity-mask="true">{team.name}</h1>
          <p className="muted">
            {accessLevel === "owner"
              ? "Review team membership, access state, and operating limits."
              : accessLevel === "team-admin"
                ? "Review your team's membership, usage, and budget state."
                : accessLevel === "team-reader"
                  ? "Review your team's membership, usage, and budget state."
                : "Review your team profile, usage, budget state, and your own account."}
          </p>
        </div>
        {actions || audienceControl ? (
          <div className="heading-actions">
            {actions}
            {audienceControl}
          </div>
        ) : null}
      </section>

      <section className="summary-row">
        <MetricCard label="Team Status" value={team.status} detail={team.budgetState} tone={team.status === "Active" ? "good" : "warn"} />
        <MetricCard label={canSeeTeamMembers ? "Listed Users" : "Your Account"} value={String(memberTotal)} detail={`${activeUsers} active on this page`} maskValue {...(activeUsers > 0 ? { tone: "good" as const } : {})} />
        <MetricCard label="Active Sources" value={String(budgetOverview?.activeSources ?? (team.planState === "Applied" ? 1 : 0))} detail={team.planWindow} maskValue maskDetail {...((budgetOverview?.activeSources ?? 0) > 0 || team.planState === "Applied" ? { tone: "good" as const } : {})} />
        <MetricCard label={budgetOverview ? "Budget Status" : "Usage Summary"} value={budgetOverview ? budgetOverview.exhaustedCount ? "Exhausted" : budgetOverview.limitCount ? "Within limits" : "No limits" : team.budgetState} detail={budgetOverview ? `${budgetOverview.limitCount} limits${budgetOverview.earliestReset ? " · reset scheduled" : ""}` : team.budget} maskDetail {...(budgetOverview?.exhaustedCount ? { tone: "bad" as const } : budgetOverview?.limitCount ? { tone: "good" as const } : {})} />
        <MetricCard
          label={canSeeAccessCoverage ? "Access Coverage" : "Team Created"}
          value={canSeeAccessCoverage ? team.accessCoverage : team.createdAt}
          detail={canSeeAccessCoverage ? `Created ${team.createdAt}` : "Read-only team profile"}
          maskValue
          maskDetail={canSeeAccessCoverage}
        />
      </section>

      {expenseSafetyChecks.some((group) => group.checks.length > 0) ? <ExpenseSafetyCheckCard groups={expenseSafetyChecks} /> : null}

      <section className="split-grid">
        <Card className="panel">
          <div className="panel-heading">
            <div>
              <h2>{canSeeTeamMembers ? "Users" : "Your Account"}</h2>
              <p className="muted">{canSeeTeamMembers ? "All users currently assigned to this team." : "Your account in this team."}</p>
            </div>
            <div className="row-actions">
              <StatusBadge tone="info">{canSeeTeamMembers ? `${memberTotal} users` : "Self"}</StatusBadge>
              {membersHeaderActions}
            </div>
          </div>

          <TeamMembersTable
            rows={users.map((user) => ({
              user,
              ...(userHref ? { href: userHref(user) } : {}),
              ...(memberActions ? { actions: memberActions(user) } : {}),
              ...(memberApiKeyLimitAction ? { apiKeyLimitAction: memberApiKeyLimitAction(user) } : {}),
            }))}
            showActions={hasMemberActions}
          />
          {membersPagination}
        </Card>

        <Card className="panel hierarchy-panel">
          <div className="panel-heading">
            <div>
              <h2>Team Overview</h2>
              <p className="muted">Tenant identifier and budget posture for this team.</p>
            </div>
            <StatusBadge tone={team.status === "Active" ? "good" : "warn"}>{team.status}</StatusBadge>
          </div>

          <div className="detail-list">
            {canSeeTeamMembers ? (
              <>
                <div>
                  <span>Team ID</span>
                  <code data-clarity-mask="true">{team.id}</code>
                </div>
                <div>
                  <span>Owner</span>
                  <code data-clarity-mask="true">{team.ownerId}</code>
                </div>
                <div>
                  <span>Members</span>
                  <strong data-clarity-mask="true">{team.members}</strong>
                </div>
              </>
            ) : null}
            <div>
              <span>Active Plan</span>
              <strong data-clarity-mask="true">{team.planName}</strong>
            </div>
            <div>
              <span>Plan State</span>
              <strong className={team.planState === "Missing" ? "text-bad" : ""}>{team.planState}</strong>
            </div>
            <div>
              <span>Plan Window</span>
              <strong data-clarity-mask="true">{team.planWindow}</strong>
            </div>
            <div>
              <span>Budget</span>
              <strong data-clarity-mask="true">{team.budget}</strong>
            </div>
            <div>
              <span>Budget State</span>
              <strong className={team.budgetState === "Critical" ? "text-bad" : ""}>{team.budgetState}</strong>
            </div>
            {canSeeTeamMembers ? (
              <>
                <div>
                  <span>Member Key Limit</span>
                  <strong>{team.canManageMemberApiKeyLimit ? "Editable" : "Read-only"}</strong>
                </div>
                <div>
                  <span>Member Credit</span>
                  <strong>{team.canManageMemberCredit ? "Editable" : "Read-only"}</strong>
                </div>
              </>
            ) : null}
          </div>

          {!budgetOverview ? <div className="embedded-section">
            <div className="usage-cell">
              <ProgressBar value={team.usage} tone={team.usage > 90 ? "bad" : team.usage > 70 ? "warn" : "good"} />
              <span data-clarity-mask="true">{team.usage}%</span>
            </div>
          </div> : null}
        </Card>
      </section>

      {accessLevel === "owner" ? (
        <Card className="panel">
          <div className="panel-heading">
            <div>
              <h2>Team Plans</h2>
              <p className="muted">Plan subscriptions for this team in Gateway attempt order.</p>
            </div>
            <div className="row-actions">
              <StatusBadge tone="info">{planTotal} plans</StatusBadge>
              {planActions}
            </div>
          </div>

          {plansFilter}
          <TeamPlansTable rows={plans} planStatusFilter={planStatusFilter} />
          {plansPagination}
        </Card>
      ) : null}

      {planBudget}

      {canSeeTeamAccessPoints ? (
        <Card className="panel">
          <div className="panel-heading">
            <div>
              <h2>Team AccessPoints</h2>
              <p className="muted">AccessPoints scoped to this team.</p>
            </div>
            <StatusBadge tone="info">{accessPointTotal} access points</StatusBadge>
          </div>

          <TeamAccessPointsTable rows={accessPoints} />
          {accessPointsPagination}
        </Card>
      ) : null}

      {dangerZone ? <Card className="panel">{dangerZone}</Card> : null}
    </>
  );
}

function ExpenseSafetyCheckCard({ groups }: { groups: ExpenseSafetyCheckGroup[] }) {
  const visibleGroups = groups.filter((group) => group.checks.length > 0);
  const multiplePerspectives = visibleGroups.length > 1;
  const warningCount = visibleGroups.reduce((total, group) => total + group.checks.length, 0);
  return <Card className="panel">
    <div className="panel-heading">
      <div>
        <h2>Expense &amp; safety checks</h2>
        <p className="muted">Read-only reminders about the funding exposure of this Team view.</p>
      </div>
      <StatusBadge tone="warn">{warningCount} warning{warningCount === 1 ? "" : "s"}</StatusBadge>
    </div>
    <div className="stack-list">
      {visibleGroups.map((group) => <div key={group.perspective}>
        {multiplePerspectives ? <h3 className="section-subheading">{group.perspective === "teamOwner" ? "Team Owner view" : "Member view"}</h3> : null}
        {group.checks.map((item) => <div className="notice-box notice-warn" key={item.code} role="status">
          <strong>{expenseSafetyCheckMessage(item)}</strong>
          <div className="muted">Affected subscriptions: {item.affectedSubscriptionCount} · Earliest end: {item.earliestEffectiveEnd ? formatUtcDateTime(item.earliestEffectiveEnd) : "No end date"}</div>
        </div>)}
      </div>)}
    </div>
  </Card>;
}

function expenseSafetyCheckMessage(item: ExpenseSafetyCheckRow): string {
  const count = item.affectedSubscriptionCount;
  const subscriptions = `${count} Team ${count === 1 ? "subscription" : "subscriptions"}`;
  switch (item.code) {
    case "team_prepaid_member_access": return `Members can directly use ${subscriptions} with prepaid resources; their balances are not charged.`;
    case "team_prepaid_without_shared_cap": return `At least ${subscriptions} with prepaid resources lack a shared hard budget cap; there may be no Team-wide stop.`;
    case "team_prepaid_without_member_cap": return `At least ${subscriptions} with prepaid resources lack a member-level hard budget cap; one member may consume shared resources.`;
    case "team_invite_expands_prepaid_access": return "An enabled invitation link can give new members access to this Team's prepaid resources.";
    case "team_paygo_member_charge": return "Using this Team's pay-as-you-go resources charges your own balance.";
    case "team_paygo_without_member_cap": return `At least ${subscriptions} with pay-as-you-go resources lack a member-level hard budget cap; your balance remains the pre-request charging boundary.`;
    default: return "This Team has a funding exposure that needs review.";
  }
}
