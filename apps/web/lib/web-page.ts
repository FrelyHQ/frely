import type { ConsoleNavItem } from "@frely/console-ui";
import type { AccessTokenClaims } from "@frely/auth";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { notFound, redirect } from "@web/navigation";
import { services } from "./server";
import { resolveWebHostScopeAsync, type WebHostScope } from "./domain-binding";
import { buildWebUserConsoleViewAsync, type WebUserConsoleView } from "./user-data";
import { availableUserTeam, userTeamNavigationHref, type AvailableUserTeam } from "./user-teams";

export interface WebPageContext {
  services: WebUserSessionContext["services"];
  claims: WebUserSessionContext["claims"];
  view: WebUserConsoleView;
  availableTeams: AvailableUserTeam[];
  availableTeamCount: number;
  hostScope: WebHostScope;
  teamId: string | null;
  isTeamOwner: boolean;
}

export interface WebUserSessionContext {
  services: Awaited<ReturnType<typeof services>>;
  claims: AccessTokenClaims;
  availableTeams: AvailableUserTeam[];
  availableTeamCount: number;
  hostScope: WebHostScope;
}

export async function requireWebUserSession(nextPath: string): Promise<WebUserSessionContext> {
  const appServices = await services();
  const requestHeaders = new Headers(getRequestHeaders());
  const hostScope = await resolveWebHostScopeAsync(appServices.application.queries, appServices.config, requestHeaders);
  let claims: WebUserSessionContext["claims"];
  try {
    claims = await appServices.asyncTenancy.requireUser(requestHeaders);
  } catch {
    redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  }

  const navigation = await appServices.application.queries.userNavigationSummary(claims.sub);
  const availableTeams = navigation.items.map((team) => availableUserTeam(team, claims.sub));
  return { services: appServices, claims, availableTeams, availableTeamCount: navigation.total, hostScope };
}

export async function requireWebUserPage(nextPath: string): Promise<WebPageContext> {
  const context = await requireWebUserSession(nextPath);
  const { services: appServices, claims, availableTeams } = context;
  const teamId = availableTeams[0]?.id ?? null;
  const view = await buildWebUserConsoleViewAsync(appServices.application.queries, appServices.asyncTenancy.identity, appServices.asyncTenancy.tenancy, claims.sub);
  if (!view) notFound();

  return {
    ...context,
    view,
    teamId,
    isTeamOwner: teamId ? claims.teamRoles.includes(`owner:${teamId}`) : false
  };
}

export function buildWebNavItems(context: {
  availableTeams: AvailableUserTeam[];
  availableTeamCount: number;
} | null): ConsoleNavItem[] {
  if (!context) return [];

  const items: ConsoleNavItem[] = [
    {
      label: "Overview",
      children: [
        { label: "Dashboard", href: "/user" },
        { label: "Account", href: "/user/account" }
      ]
    },
    {
      label: "Use the API",
      children: [
        { label: "Available Models", href: "/user/access/available-models" },
        { label: "Keys", href: "/user/keys" },
        { label: "Access Order", href: "/user/access/order" },
        { label: "Access Points", href: "/user/access/access-points" },
        { label: "Chat", href: "/user/chat" },
        { label: "API Test", href: "/user/tools/api-test" }
      ]
    },
    {
      label: "Usage & Billing",
      children: [
        { label: "Authority", href: "/user/authority" },
        { label: "Request History", href: "/user/request-history" },
        { label: "Credits", href: "/user/credits" },
        { label: "Plans", href: "/user/plans-and-budgets/plans" },
        { label: "Budget", href: "/user/plans-and-budgets/budget" },
        { label: "My Cards", href: "/user/cards" }
      ]
    }
  ];

  const teamHref = userTeamNavigationHref(context.availableTeams, context.availableTeamCount);
  if (teamHref) items.push({ label: "Team", children: [{ label: "Team", href: teamHref }] });
  items.push(
    {
      label: "Tools",
      children: [{ label: "API Key Self Usage", href: "/key" }]
    }
  );

  return items;
}
