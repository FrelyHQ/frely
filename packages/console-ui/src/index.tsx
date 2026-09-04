import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { Badge } from "@frely/ui/components/badge";
import { Button } from "@frely/ui/components/button";
import { Card } from "@frely/ui/components/card";
import { Progress } from "@frely/ui/components/progress";
import { Tooltip } from "@frely/ui/components/tooltip";
import { BrowserTime } from "@frely/ui/components/browser-time";
import { cn } from "@frely/ui/lib/utils";
import { MaterialTable } from "./material-table.js";
import {
  Activity,
  BadgeDollarSign,
  Boxes,
  Building2,
  ChartNoAxesCombined,
  ChevronLeft,
  CircleGauge,
  ClipboardList,
  Code2,
  Coins,
  CreditCard,
  FlaskConical,
  Gauge,
  KeyRound,
  Layers3,
  LayoutDashboard,
  Menu,
  Network,
  PackageCheck,
  PanelLeftClose,
  ReceiptText,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  UserRound,
  UsersRound,
  WalletCards,
  X,
  type LucideIcon
} from "lucide-react";
import { ConsoleSignOutButton } from "./sign-out-button.js";

type Tone = "good" | "warn" | "bad" | "neutral" | "info";

export type ConsoleNavItem =
  | { label: string; href: string }
  | { label: string; children: Array<{ label: string; href: string }> };

export interface ConsoleShellProps {
  brandTitle: string;
  brandSubtitle: string;
  navItems: ConsoleNavItem[];
  currentPath?: string | undefined;
  environment?: string | undefined;
  profileLabel: string;
  profileSubtext?: string | undefined;
  loginHref?: string | undefined;
  headerActions?: ReactNode;
  children: ReactNode;
}

export interface ConsoleUser {
  id: string;
  teamId: string;
  name: string;
  email: string;
  role: "Owner" | "Admin" | "User";
  status: "Active" | "Disabled";
  adminNote?: string | null;
  apiKeyLimit: number;
  userCanCreateCustomProvider?: number;
  userCanCreateAccessPoint?: number;
  apiKeys: string;
  lastSeen: string;
  lastSeenAt: string | null;
  createdAt: string;
  createdAtIso: string;
}

export interface ConsoleApiKey {
  id: string;
  userId: string;
  name: string;
  prefix: string;
  status: "Active" | "Disabled" | "Revoked";
  scope: string;
  planUsage: number;
  budget: string;
  lastUsed: string;
  lastUsedAt: string | null;
  createdAt: string;
  createdAtIso: string;
}

export interface ConsoleCreditLedgerEvent {
  id: string;
  eventType: string;
  amount: string;
  reason: string;
  actorUserId: string;
  relatedEventId: string;
  createdAt: string;
  createdAtIso: string;
}

export interface ConsoleCreditDetail {
  accountId: string;
  scopeRef: string;
  status: string;
  balance: string;
  transferOutEnabled: boolean;
  recentEvents: ConsoleCreditLedgerEvent[];
}

export interface ApiKeyDetailModel extends ConsoleApiKey {
  expiresAt: string;
  revokedAt: string;
  totalTokens: string;
  calculatedCost: string;
  planSourceRestriction?: {
    mode: "all" | "restricted";
    sourceCount: number;
    teamCount: number;
  };
}

export interface UserAudienceDetailModel {
  user: ConsoleUser;
  apiKeys: {
    items: ConsoleApiKey[];
    summary: {
      totalKeys: number;
      activeKeys: number;
      disabledKeys: number;
      peakUsagePercent: number;
    };
  } | null;
  credit: ConsoleCreditDetail | null;
  capabilities: {
    canReadApiKeys: boolean;
  };
}

export interface UserCreditAudienceModel {
  account: {
    id: string;
    scopeRef: string;
    status: string;
    balance: string;
    transferOutEnabled: boolean;
  };
  ledger: {
    items: Array<{
      id: string;
      eventType: string;
      amount: string;
      reason: string;
      createdAt: string;
    }>;
  };
}

export function StatusBadge({ children, tone = "neutral" }: { children: ReactNode; tone?: Tone }) {
  return <Badge variant={tone}>{children}</Badge>;
}

export function Notice({ children, tone = "neutral", live }: { children: ReactNode; tone?: Tone; live?: "alert" | "status" }) {
  return <div className={cn("notice-box", tone !== "neutral" && `notice-${tone}`)} role={live}>{children}</div>;
}

export function ConsoleAuthShell({
  children,
  context,
  environment,
  width = "sm"
}: {
  children: ReactNode;
  context?: string;
  environment?: string;
  width?: "sm" | "md";
}) {
  return (
    <main className="console-auth-shell">
      <div className={cn("console-auth-content", width === "md" && "console-auth-content-md")}>
        <div className="console-auth-brand" aria-label="Frely">
          <span className="brand-mark" aria-hidden="true">F</span>
          <span>
            <strong>Frely</strong>
            {context ? <small>{context}</small> : null}
          </span>
        </div>
        {environment ? <StatusBadge tone="info">Environment: {environment}</StatusBadge> : null}
        {children}
      </div>
    </main>
  );
}

export function ConsoleSidebar({
  brandTitle,
  brandSubtitle,
  navItems,
  currentPath = "",
  profileLabel,
  profileSubtext,
  profileHref,
  loginHref = "/login"
}: {
  brandTitle: string;
  brandSubtitle: string;
  navItems: ConsoleNavItem[];
  currentPath?: string | undefined;
  profileLabel: string;
  profileSubtext?: string | undefined;
  profileHref?: string | undefined;
  loginHref?: string | undefined;
}) {
  const toggleId = "console-sidebar-toggle";

  return (
    <SidebarProvider>
      <input className="sidebar-toggle-input" id={toggleId} type="checkbox" aria-label="Toggle navigation" />
      <Sidebar aria-label={`${brandSubtitle} navigation`}>
        <SidebarHeader>
          <div className="brand-block">
            <div className="brand-mark" aria-hidden="true">F</div>
            <div className="sidebar-text">
              <div className="brand-title">{brandTitle}</div>
              <div className="brand-subtitle">{brandSubtitle}</div>
            </div>
          </div>
          <Tooltip content="Toggle sidebar">
            <label className="sidebar-trigger" htmlFor={toggleId} aria-label="Toggle sidebar">
              <PanelLeftClose aria-hidden="true" />
            </label>
          </Tooltip>
        </SidebarHeader>

        <SidebarContent>
          <SidebarMenu>
            {navItems.map((item) => {
              if ("children" in item) {
                return (
                  <SidebarGroup key={item.label}>
                    <SidebarGroupLabel>
                      <NavIcon label={item.label} />
                      <span className="sidebar-text">{item.label}</span>
                    </SidebarGroupLabel>
                    <SidebarMenuSub>
                      {item.children.map((child) => (
                        <SidebarMenuSubItem key={child.href}>
                          <SidebarMenuButton href={child.href} active={isActivePath(currentPath, child.href)} label={child.label}>
                            <NavIcon label={child.label} />
                            <span className="sidebar-text">{child.label}</span>
                          </SidebarMenuButton>
                        </SidebarMenuSubItem>
                      ))}
                    </SidebarMenuSub>
                  </SidebarGroup>
                );
              }

              return (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton href={item.href} active={isActivePath(currentPath, item.href)} label={item.label}>
                    <NavIcon label={item.label} />
                    <span className="sidebar-text">{item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarContent>

        <SidebarFooter>
          {profileHref ? <a className="sidebar-profile" href={profileHref} aria-current={isActivePath(currentPath, profileHref) ? "page" : undefined} data-clarity-mask="true">
            <div className="avatar">{initials(profileLabel)}</div>
            <div className="sidebar-text">
              <div className="footer-title">{profileLabel}</div>
              {profileSubtext ? <div className="footer-copy">{profileSubtext}</div> : null}
            </div>
          </a> : <div className="sidebar-profile" data-clarity-mask="true">
            <div className="avatar">{initials(profileLabel)}</div>
            <div className="sidebar-text">
              <div className="footer-title">{profileLabel}</div>
              {profileSubtext ? <div className="footer-copy">{profileSubtext}</div> : null}
            </div>
          </div>}
          <ConsoleSignOutButton className="sidebar-sign-out" loginHref={loginHref} />
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
    </SidebarProvider>
  );
}

export function SidebarProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function Sidebar({ children, className, ...props }: ComponentPropsWithoutRef<"aside">) {
  return (
    <aside className={cn("sidebar", className)} {...props}>
      {children}
    </aside>
  );
}

export function SidebarHeader({ children }: { children: ReactNode }) {
  return <div className="sidebar-header">{children}</div>;
}

export function SidebarContent({ children }: { children: ReactNode }) {
  return <nav className="sidebar-content">{children}</nav>;
}

export function SidebarFooter({ children }: { children: ReactNode }) {
  return <div className="sidebar-footer">{children}</div>;
}

export function SidebarGroup({ children }: { children: ReactNode }) {
  return <div className="sidebar-group">{children}</div>;
}

export function SidebarGroupLabel({ children }: { children: ReactNode }) {
  return <div className="sidebar-group-label">{children}</div>;
}

export function SidebarMenu({ children }: { children: ReactNode }) {
  return <div className="sidebar-menu">{children}</div>;
}

export function SidebarMenuItem({ children }: { children: ReactNode }) {
  return <div className="sidebar-menu-item">{children}</div>;
}

export function SidebarMenuSub({ children }: { children: ReactNode }) {
  return <div className="sidebar-menu-sub">{children}</div>;
}

export function SidebarMenuSubItem({ children }: { children: ReactNode }) {
  return <div className="sidebar-menu-sub-item">{children}</div>;
}

export function SidebarMenuButton({
  href,
  active,
  label,
  children
}: {
  href: string;
  active?: boolean | undefined;
  label: string;
  children: ReactNode;
}) {
  return (
    <a aria-current={active ? "page" : undefined} aria-label={label} className={active ? "active" : ""} href={href}>
      {children}
    </a>
  );
}

export function SidebarRail() {
  return <div className="sidebar-rail" aria-hidden="true" />;
}

export function ConsoleHeader({ environment, context = "Console workspace", actions }: { environment?: string | undefined; context?: string | undefined; actions?: ReactNode }) {
  return (
    <header className="console-header">
      <div className="header-context">
        <label className="mobile-menu-trigger" htmlFor="console-sidebar-toggle" aria-label="Open navigation">
          <Menu className="menu-open-icon" aria-hidden="true" />
          <X className="menu-close-icon" aria-hidden="true" />
        </label>
        <div>
          <span className="header-context-label">Workspace</span>
          <strong>{context}</strong>
        </div>
      </div>
      <div className="header-actions">
        {environment ? <StatusBadge tone="info">Environment: {environment}</StatusBadge> : null}
        {actions}
      </div>
    </header>
  );
}

export function ConsoleShell({
  brandTitle,
  brandSubtitle,
  navItems,
  currentPath,
  environment,
  profileLabel,
  profileSubtext,
  loginHref,
  headerActions,
  children
}: ConsoleShellProps) {
  return (
    <div className="admin-shell">
      <ConsoleSidebar
        brandTitle={brandTitle}
        brandSubtitle={brandSubtitle}
        navItems={navItems}
        currentPath={currentPath}
        profileLabel={profileLabel}
        profileSubtext={profileSubtext}
        loginHref={loginHref}
      />
      <div className="workspace">
        <ConsoleHeader environment={environment} context={consoleNavLabel(navItems, currentPath) ?? brandSubtitle} actions={headerActions} />
        <main className="console-content">{children}</main>
      </div>
    </div>
  );
}

export function PageHeading({
  eyebrow,
  title,
  description,
  children,
  maskTitle = false
}: {
  eyebrow: string;
  title: string;
  description: string;
  children?: ReactNode;
  maskTitle?: boolean;
}) {
  return (
    <section className="page-heading">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1 data-clarity-mask={maskTitle ? "true" : undefined}>{title}</h1>
        <p className="muted">{description}</p>
      </div>
      {children ? <div className="heading-actions">{children}</div> : null}
    </section>
  );
}

export function MetricCard({
  label,
  value,
  detail,
  detailTitle,
  href,
  tone,
  maskValue = false,
  maskDetail = false
}: {
  label: string;
  value: string;
  detail: string;
  detailTitle?: string;
  href?: string;
  tone?: "good" | "warn" | "bad";
  maskValue?: boolean;
  maskDetail?: boolean;
}) {
  const content = (
    <>
      <div className="metric-label">{label}</div>
      <div className="metric-value" data-clarity-mask={maskValue ? "true" : undefined}>{value}</div>
      <Tooltip content={detailTitle}><div className={`metric-detail ${tone ? `text-${tone}` : ""}`} data-clarity-mask={maskDetail ? "true" : undefined} tabIndex={detailTitle ? 0 : undefined}>{detail}</div></Tooltip>
    </>
  );

  if (href) {
    return (
      <Card asChild className="metric-card metric-card-link">
        <a href={href} aria-label={`${label}: ${value}. ${detail}`}>
          {content}
        </a>
      </Card>
    );
  }

  return (
    <Card className="metric-card">
      {content}
    </Card>
  );
}

export function ProgressBar({ value, tone = "good" }: { value: number; tone?: "good" | "warn" | "bad" }) {
  return (
    <Progress
      aria-label={`${value}%`}
      className="progress-track"
      indicatorClassName={cn("progress-fill", `progress-${tone}`)}
      value={value}
    />
  );
}

function isActivePath(currentPath: string, href: string): boolean {
  const isSectionRoot = href.split("/").filter(Boolean).length === 1;
  return isSectionRoot ? currentPath === href : currentPath === href || currentPath.startsWith(`${href}/`);
}

export function consoleNavLabel(navItems: ConsoleNavItem[], currentPath = ""): string | undefined {
  let best: { label: string; href: string } | undefined;
  for (const item of navItems) {
    const candidates = "children" in item ? item.children : [item];
    for (const candidate of candidates) {
      if (isActivePath(currentPath, candidate.href) && (!best || candidate.href.length > best.href.length)) best = candidate;
    }
  }
  return best?.label;
}

const navIcons: Record<string, LucideIcon> = {
  Overview: CircleGauge,
  Dashboard: LayoutDashboard,
  Account: UserRound,
  Identity: ShieldCheck,
  Teams: Building2,
  Team: Building2,
  Users: UsersRound,
  Keys: KeyRound,
  Credits: Coins,
  Access: Network,
  "Use the API": Code2,
  "Available Models": Boxes,
  "Access Order": Layers3,
  "Access Points": Network,
  Providers: PackageCheck,
  Pricing: BadgeDollarSign,
  "Usage & Billing": ChartNoAxesCombined,
  "Request History": Activity,
  "Request Logs": Activity,
  "Audit Logs": ClipboardList,
  Observability: Gauge,
  Plans: WalletCards,
  "Plans & Budgets": WalletCards,
  "Budget Policies": SlidersHorizontal,
  "Governance Budgets": ShieldCheck,
  Budget: CircleGauge,
  "My Cards": CreditCard,
  Tools: FlaskConical,
  "API Test": FlaskConical,
  "API Key Self Usage": ReceiptText,
  "Access Resolution": Network,
  System: Settings,
  "System Settings": Settings
};

function NavIcon({ label }: { label: string }) {
  const Icon = navIcons[label] ?? ChevronLeft;
  return <Icon className="nav-icon" aria-hidden="true" />;
}

function initials(value: string): string {
  const letters = value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
  return letters || "F";
}

export interface ApiKeyTableColumn<TApiKey extends ConsoleApiKey = ConsoleApiKey> {
  key: string;
  header: ReactNode;
  minWidth?: number | string;
  render: (apiKey: TApiKey) => ReactNode;
  width?: number | string;
}

export function EmptyState({ title, description, action }: { title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty-state" data-ui-surface-empty-state="true">
      <strong>{title}</strong>
      {description ? <p className="muted">{description}</p> : null}
      {action ? <div className="empty-state-action">{action}</div> : null}
    </div>
  );
}

export function DetailList({ items }: { items: Array<{ label: ReactNode; value: ReactNode }> }) {
  return (
    <div className="detail-list">
      {items.map((item, index) => (
        <div key={index}>
          <span>{item.label}</span>
          {typeof item.value === "string" || typeof item.value === "number" ? <strong>{item.value}</strong> : item.value}
        </div>
      ))}
    </div>
  );
}

export function ApiKeyIdentityCell<TApiKey extends ConsoleApiKey>({
  apiKey,
  href,
}: {
  apiKey: TApiKey;
  href?: string | undefined;
}) {
  return (
    <div className="api-key-cell" data-clarity-mask="true">
      {href ? (
        <a className="cell-link cell-link-stack" href={href}>
          <strong>{apiKey.name}</strong>
          <code>{apiKey.prefix}</code>
        </a>
      ) : (
        <span className="api-key-cell-label">
          <strong>{apiKey.name}</strong>
          <code>{apiKey.prefix}</code>
        </span>
      )}
    </div>
  );
}

export function ApiKeysTable<TApiKey extends ConsoleApiKey>({
  apiKeys,
  columns,
  emptyLabel = "No API keys are currently associated with this user.",
  rowHref
}: {
  apiKeys: TApiKey[];
  columns: ApiKeyTableColumn<TApiKey>[];
  emptyLabel?: string;
  rowHref?: ((apiKey: TApiKey) => string | undefined) | undefined;
}) {
  return (
    <MaterialTable
      columns={columns.map((column) => ({
        header: column.header,
        ...(column.minWidth !== undefined ? { minWidth: column.minWidth } : {}),
        ...(column.width !== undefined ? { width: column.width } : {})
      }))}
      rows={apiKeys.map((apiKey) => ({
        id: apiKey.id,
        clickable: Boolean(rowHref?.(apiKey)),
        cells: columns.map((column) => column.render(apiKey))
      }))}
      emptyState={{ title: emptyLabel }}
      table={{ minWidth: 980, stickyHeader: true }}
    />
  );
}

export function UserApiKeysDetail({
  user,
  apiKeys,
  backHref,
  backLabel = "Back",
  eyebrow = "User Details",
  audienceLabel: _audienceLabel,
  audienceControl,
  actions,
  apiKeyHref,
  apiKeyRowActions,
  apiKeySummary,
  apiKeyDirectoryHeader,
  apiKeyPagination,
  apiKeysVisible = true,
  credit,
  creditActions
}: {
  user: ConsoleUser;
  apiKeys: ConsoleApiKey[];
  backHref: string;
  backLabel?: string;
  eyebrow?: string;
  audienceLabel?: string;
  audienceControl?: ReactNode;
  actions?: ReactNode;
  apiKeyHref?: (apiKey: ConsoleApiKey) => string;
  apiKeyRowActions?: (apiKey: ConsoleApiKey) => ReactNode;
  apiKeySummary?: { totalKeys: number; activeKeys: number; disabledKeys: number; peakUsagePercent: number };
  apiKeyDirectoryHeader?: ReactNode;
  apiKeyPagination?: ReactNode;
  apiKeysVisible?: boolean;
  credit?: ConsoleCreditDetail | null;
  creditActions?: ReactNode;
}) {
  const totalKeys = apiKeySummary?.totalKeys ?? apiKeys.length;
  const activeKeys = apiKeySummary?.activeKeys ?? apiKeys.filter((apiKey) => apiKey.status === "Active").length;
  const disabledKeys = apiKeySummary?.disabledKeys ?? apiKeys.filter((apiKey) => apiKey.status === "Disabled").length;
  const maxUsage = apiKeySummary?.peakUsagePercent ?? apiKeys.reduce((max, apiKey) => Math.max(max, apiKey.planUsage), 0);
  const apiKeyColumns: ApiKeyTableColumn[] = [
    {
      key: "key",
      header: "Key",
      render: (apiKey) => (
        <ApiKeyIdentityCell apiKey={apiKey} href={apiKeyHref?.(apiKey)} />
      )
    },
    {
      key: "status",
      header: "Status",
      render: (apiKey) => (
        <StatusBadge tone={apiKey.status === "Active" ? "good" : apiKey.status === "Disabled" ? "warn" : "bad"}>
          {apiKey.status}
        </StatusBadge>
      )
    },
    {
      key: "scope",
      header: "Scope",
      width: 120,
      render: (apiKey) => <Tooltip content={apiKey.scope}><code className="scope-code" data-clarity-mask="true" tabIndex={0}>{middleTruncate(apiKey.scope, 18)}</code></Tooltip>
    },
    {
      key: "planUsage",
      header: "Plan Usage",
      render: (apiKey) => (
        <div className="usage-cell">
          <ProgressBar value={apiKey.planUsage} tone={apiKey.planUsage > 90 ? "bad" : apiKey.planUsage > 70 ? "warn" : "good"} />
          <span data-clarity-mask="true">{apiKey.planUsage}%</span>
        </div>
      )
    },
    {
      key: "budget",
      header: "Budget",
      render: (apiKey) => <span data-clarity-mask="true">{apiKey.budget}</span>
    },
    {
      key: "lastUsed",
      header: "Last Used",
      render: (apiKey) => <span data-clarity-mask="true">{apiKey.lastUsedAt ? <BrowserTime value={apiKey.lastUsedAt} /> : "Never"}</span>
    },
    {
      key: "createdAt",
      header: "Created At",
      render: (apiKey) => <span data-clarity-mask="true"><BrowserTime value={apiKey.createdAtIso} dateOnly /></span>
    }
  ];

  if (apiKeyRowActions) {
    apiKeyColumns.push({
      key: "actions",
      header: "Actions",
      render: (apiKey) => (
        <div className="row-actions">
          {apiKeyRowActions(apiKey)}
        </div>
      )
    });
  }

  return (
    <>
      <section className="page-heading">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h1 data-clarity-mask="true">{user.name}</h1>
          <p className="muted">Review this user's profile, team membership, and all API keys attached to the account.</p>
        </div>
        <div className="heading-actions">
          {actions}
          <Button variant="secondary" asChild>
            <a href={backHref}>{backLabel}</a>
          </Button>
          {audienceControl}
        </div>
      </section>

      <section className="summary-row">
        <MetricCard label="User Status" value={user.status} detail={user.role} tone={user.status === "Active" ? "good" : "warn"} />
        {apiKeysVisible ? <MetricCard label="API Keys" value={String(totalKeys)} detail={`${activeKeys} active`} {...(activeKeys > 0 ? { tone: "good" as const } : {})} /> : <MetricCard label="API Keys" value="Restricted" detail="Not visible to this audience" />}
        {apiKeysVisible ? <MetricCard label="Disabled Keys" value={String(disabledKeys)} detail="Operational hold" {...(disabledKeys > 0 ? { tone: "warn" as const } : {})} /> : null}
        {apiKeysVisible ? <MetricCard label="Peak Usage" value={`${maxUsage}%`} detail="Highest key this month" {...(maxUsage > 90 ? { tone: "bad" as const } : maxUsage > 70 ? { tone: "warn" as const } : {})} /> : null}
        {credit ? <MetricCard label="Credit Balance" value={credit.balance} detail={credit.transferOutEnabled ? "Transfer out enabled" : "Available balance"} maskValue /> : null}
      </section>

      <section className="split-grid">
        {apiKeysVisible ? <Card className="panel">
          <div className="panel-heading">
            <div>
              <h2>API Keys</h2>
              <p className="muted">{apiKeyPagination ? "API keys currently associated with this user, shown one page at a time." : "Every key currently associated with this user."}</p>
            </div>
            {apiKeyDirectoryHeader ?? <StatusBadge tone="info">{totalKeys} keys</StatusBadge>}
          </div>

          <ApiKeysTable apiKeys={apiKeys} columns={apiKeyColumns} rowHref={apiKeyHref} />
          {apiKeyPagination}
        </Card> : null}

        {credit ? (
          <Card className="panel">
            <div className="panel-heading">
              <div>
                <h2>Credit</h2>
                <p className="muted">Balance, transfer policy, and recent ledger events.</p>
              </div>
              <StatusBadge tone={credit.transferOutEnabled ? "good" : "neutral"}>{credit.transferOutEnabled ? "Transfer enabled" : "Transfer disabled"}</StatusBadge>
            </div>

            <div className="detail-list">
              <div>
                <span>Balance</span>
                <strong data-clarity-mask="true">{credit.balance}</strong>
              </div>
              <div>
                <span>Account ID</span>
                <code data-clarity-mask="true">{credit.accountId}</code>
              </div>
              <div>
                <span>Scope</span>
                <code data-clarity-mask="true">{credit.scopeRef}</code>
              </div>
              <div>
                <span>Status</span>
                <strong>{credit.status}</strong>
              </div>
            </div>

            {creditActions ? <div className="embedded-section">{creditActions}</div> : null}

            <MaterialTable
              columns={["Event", "Amount", "Reason", "Created"].map((header) => ({ header }))}
              rows={credit.recentEvents.map((event) => ({
                id: event.id,
                cells: [<span data-clarity-mask="true"><strong>{event.eventType}</strong><code>{event.id}</code></span>, <span data-clarity-mask="true">{event.amount}</span>, <span data-clarity-mask="true">{event.reason}</span>, <span data-clarity-mask="true"><BrowserTime value={event.createdAtIso} /></span>]
              }))}
              emptyState={{ title: "No ledger events yet." }}
            />
          </Card>
        ) : null}

        <Card className="panel hierarchy-panel">
          <div className="panel-heading">
            <div>
              <h2>User Overview</h2>
              <p className="muted">Identity and tenancy context for this account.</p>
            </div>
            <StatusBadge tone={user.status === "Active" ? "good" : "warn"}>{user.status}</StatusBadge>
          </div>

          <div className="detail-list">
            <div>
              <span>User ID</span>
              <code data-clarity-mask="true">{user.id}</code>
            </div>
            <div>
              <span>Email</span>
              <code data-clarity-mask="true">{user.email}</code>
            </div>
            <div>
              <span>Team ID</span>
              <code data-clarity-mask="true">{user.teamId}</code>
            </div>
            <div>
              <span>Role</span>
              <strong>{user.role}</strong>
            </div>
            <div>
              <span>Last Seen</span>
              <strong data-clarity-mask="true">{user.lastSeen}</strong>
            </div>
            <div>
              <span>Created At</span>
              <strong data-clarity-mask="true">{user.createdAt}</strong>
            </div>
          </div>
        </Card>
      </section>
    </>
  );
}

export function UserAudienceDetail({
  model,
  backHref,
  backLabel,
  eyebrow,
  audienceControl,
  actions,
  apiKeyHref,
  apiKeyRowActions,
  apiKeyPagination,
}: {
  model: UserAudienceDetailModel;
  backHref: string;
  backLabel?: string;
  eyebrow?: string;
  audienceControl?: ReactNode;
  actions?: ReactNode;
  apiKeyHref?: (apiKey: ConsoleApiKey) => string;
  apiKeyRowActions?: (apiKey: ConsoleApiKey) => ReactNode;
  apiKeyPagination?: ReactNode;
}) {
  return <UserApiKeysDetail
    user={model.user}
    apiKeys={model.apiKeys?.items ?? []}
    backHref={backHref}
    {...(backLabel === undefined ? {} : { backLabel })}
    {...(eyebrow === undefined ? {} : { eyebrow })}
    {...(audienceControl === undefined ? {} : { audienceControl })}
    {...(actions === undefined ? {} : { actions })}
    {...(apiKeyHref === undefined ? {} : { apiKeyHref })}
    {...(apiKeyRowActions === undefined ? {} : { apiKeyRowActions })}
    {...(apiKeyPagination === undefined ? {} : { apiKeyPagination })}
    {...(model.apiKeys ? { apiKeySummary: model.apiKeys.summary } : {})}
    apiKeysVisible={model.capabilities.canReadApiKeys}
    credit={model.credit}
  />;
}

export function UserCreditAudienceView({
  model,
  topupExperience,
  catalogPagination,
  ledgerPagination,
  ledgerNextHref = "",
  audienceControl,
}: {
  model: UserCreditAudienceModel;
  topupExperience: ReactNode;
  catalogPagination?: ReactNode;
  ledgerPagination?: ReactNode;
  ledgerNextHref?: string;
  audienceControl?: ReactNode;
}) {
  return <>
    <PageHeading eyebrow="User / Credits" title="Credits" description="Review your user credit account, transfer policy, and append-only histories.">
      <StatusBadge tone={model.account.transferOutEnabled ? "good" : "neutral"}>{model.account.transferOutEnabled ? "Transfer enabled" : "Transfer disabled"}</StatusBadge>
      {audienceControl}
    </PageHeading>

    <section className="summary-row">
      <MetricCard label="Balance" value={model.account.balance} detail={model.account.status} maskValue />
      <MetricCard label="Ledger Events" value={String(model.ledger.items.length)} detail="Current history page" />
      <MetricCard label="Scope" value="User" detail={model.account.scopeRef} maskDetail />
      <MetricCard label="Transfer Out" value={model.account.transferOutEnabled ? "Enabled" : "Disabled"} detail="Current policy" {...(model.account.transferOutEnabled ? { tone: "good" as const } : {})} />
    </section>

    <section className="split-grid">
      <Card className="panel">
        <div className="panel-heading">
          <div>
            <h2>Top Up</h2>
            <p className="muted">Stripe Checkout credits automatically after verified payment; manual channels stay pending until Owner approval.</p>
          </div>
        </div>
        {topupExperience}
        {catalogPagination}
      </Card>

      <Card className="panel">
        <div className="panel-heading">
          <div>
            <h2>Ledger</h2>
            <p className="muted">Append-only user credit ledger entries.</p>
          </div>
        </div>
        <MaterialTable
          columns={["Event", "Amount", "Reason", "Created"].map((header) => ({ header }))}
          rows={model.ledger.items.map((event) => ({
            id: event.id,
            cells: [
              <span data-clarity-mask="true"><strong>{event.eventType}</strong><code>{event.id}</code></span>,
              <span data-clarity-mask="true">{event.amount}</span>,
              <span data-clarity-mask="true">{event.reason}</span>,
              <span data-clarity-mask="true"><BrowserTime value={event.createdAt} /></span>,
            ],
          }))}
          emptyState={{ title: "No ledger events yet." }}
        />
        {ledgerPagination}
        {ledgerNextHref ? <div className="row-actions"><Button variant="secondary" asChild><a href={ledgerNextHref}>Older ledger events</a></Button></div> : null}
      </Card>

      <Card className="panel hierarchy-panel">
        <div className="panel-heading">
          <div>
            <h2>Credit Account</h2>
            <p className="muted">Current balance and policy state.</p>
          </div>
        </div>
        <div className="detail-list">
          <div><span>Account ID</span><code data-clarity-mask="true">{model.account.id}</code></div>
          <div><span>Scope</span><code data-clarity-mask="true">{model.account.scopeRef}</code></div>
          <div><span>Status</span><strong>{model.account.status}</strong></div>
          <div><span>Balance</span><strong data-clarity-mask="true">{model.account.balance}</strong></div>
        </div>
      </Card>
    </section>
  </>;
}

function middleTruncate(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  const edgeLength = Math.max(4, Math.floor((maxLength - 3) / 2));
  return `${value.slice(0, edgeLength)}...${value.slice(-edgeLength)}`;
}

export function ApiKeyDetail({
  apiKey,
  backHref,
  backLabel = "Back",
  eyebrow = "API Key Details",
  audienceLabel: _audienceLabel,
  audienceControl,
  actions,
  planSourceRestrictionEditor,
}: {
  apiKey: ApiKeyDetailModel;
  backHref: string;
  backLabel?: string;
  eyebrow?: string;
  audienceLabel?: string;
  audienceControl?: ReactNode;
  actions?: ReactNode;
  planSourceRestrictionEditor?: ReactNode;
}) {
  return (
    <>
      <section className="page-heading">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h1 data-clarity-mask="true">{apiKey.name}</h1>
          <p className="muted">Review API key identity, ownership, usage, and budget context.</p>
        </div>
        <div className="heading-actions">
          {actions}
          <Button variant="secondary" asChild>
            <a href={backHref}>{backLabel}</a>
          </Button>
          {audienceControl}
        </div>
      </section>

      <section className="summary-row">
        <MetricCard label="Key Status" value={apiKey.status} detail={apiKey.prefix} tone={apiKey.status === "Active" ? "good" : apiKey.status === "Disabled" ? "warn" : "bad"} maskDetail />
        <MetricCard label="Plan Usage" value={`${apiKey.planUsage}%`} detail={apiKey.budget} tone={apiKey.planUsage > 90 ? "bad" : apiKey.planUsage > 70 ? "warn" : "good"} maskValue maskDetail />
        <MetricCard label="Total Tokens" value={apiKey.totalTokens} detail="Recorded usage" maskValue />
        <MetricCard label="Cost" value={apiKey.calculatedCost} detail="Calculated spend" maskValue />
      </section>

      <section className="split-grid">
        <Card className="panel">
          <div className="panel-heading">
            <div>
              <h2>Plan Sources</h2>
              <p className="muted">Plan source visibility applied to Gateway requests made with this key.</p>
            </div>
            <StatusBadge tone={apiKey.planSourceRestriction?.mode === "restricted" ? "warn" : "good"}>
              {apiKey.planSourceRestriction?.mode === "restricted" ? "Restricted" : "All current sources"}
            </StatusBadge>
          </div>
          {apiKey.planSourceRestriction?.mode === "restricted" ? (
            <div className="detail-list">
              <div><span>Exact Plan sources</span><strong>{apiKey.planSourceRestriction.sourceCount}</strong></div>
              <div><span>Dynamic Team scopes</span><strong>{apiKey.planSourceRestriction.teamCount}</strong></div>
            </div>
          ) : <p className="muted">This key can use every current Plan source available to its owner.</p>}
          {planSourceRestrictionEditor}
        </Card>
      </section>

      <section className="split-grid">
        <Card className="panel">
          <div className="panel-heading">
            <div>
              <h2>Usage</h2>
              <p className="muted">Current recorded activity for this API key.</p>
            </div>
            <StatusBadge tone="info">{apiKey.totalTokens} tokens</StatusBadge>
          </div>

          <div className="detail-list">
            <div>
              <span>Budget</span>
              <strong data-clarity-mask="true">{apiKey.budget}</strong>
            </div>
            <div>
              <span>Plan Usage</span>
              <div className="usage-cell">
                <ProgressBar value={apiKey.planUsage} tone={apiKey.planUsage > 90 ? "bad" : apiKey.planUsage > 70 ? "warn" : "good"} />
                <span data-clarity-mask="true">{apiKey.planUsage}%</span>
              </div>
            </div>
            <div>
              <span>Calculated Cost</span>
              <strong data-clarity-mask="true">{apiKey.calculatedCost}</strong>
            </div>
          </div>
        </Card>

        <Card className="panel hierarchy-panel">
          <div className="panel-heading">
            <div>
              <h2>Key Overview</h2>
              <p className="muted">Identity and lifecycle state for this key.</p>
            </div>
            <StatusBadge tone={apiKey.status === "Active" ? "good" : apiKey.status === "Disabled" ? "warn" : "bad"}>{apiKey.status}</StatusBadge>
          </div>

          <div className="detail-list">
            <div>
              <span>Key ID</span>
              <code data-clarity-mask="true">{apiKey.id}</code>
            </div>
            <div>
              <span>Prefix</span>
              <code data-clarity-mask="true">{apiKey.prefix}</code>
            </div>
            <div>
              <span>User ID</span>
              <code data-clarity-mask="true">{apiKey.userId}</code>
            </div>
            <div>
              <span>Scope</span>
              <code data-clarity-mask="true">{apiKey.scope}</code>
            </div>
            <div>
              <span>Last Used</span>
              <strong data-clarity-mask="true">{apiKey.lastUsed}</strong>
            </div>
            <div>
              <span>Created At</span>
              <strong data-clarity-mask="true">{apiKey.createdAt}</strong>
            </div>
            <div>
              <span>Expires At</span>
              <strong data-clarity-mask="true">{apiKey.expiresAt}</strong>
            </div>
            <div>
              <span>Revoked At</span>
              <strong data-clarity-mask="true">{apiKey.revokedAt}</strong>
            </div>
          </div>
        </Card>
      </section>
    </>
  );
}
