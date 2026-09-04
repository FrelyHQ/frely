import { readConsoleApiResponse } from "@frely/console-ui/api-error";
import {
  buildTeamInviteAudienceViewModel,
  type CreateTeamInviteInput,
  type DisableTeamInviteInput,
  type TeamInviteActionResult,
  type TeamInviteCapabilities,
  type TeamInviteLinkViewModel,
  type TeamInvitePageViewModel,
  type TeamInviteSettingsSource,
  type UpdateTeamInviteSettingsInput,
} from "@frely/team-console-ui/models";

export async function fetchTeamInviteData(teamId: string, teamName: string, viewerUserId: string, page: number, pageSize: number, signal?: AbortSignal) {
  const settingsResponse = await fetch(`/api/team/invite-settings?teamId=${encodeURIComponent(teamId)}`, { cache: "no-store", ...(signal ? { signal } : {}) });
  const settings = await readConsoleApiResponse(settingsResponse, "Failed to load invitation settings", parseInviteSettings);
  const scope = settings.capabilities.canManageAllInviteLinks ? "all" : "mine";
  const linksResponse = await fetch(`/api/team/invite-links?teamId=${encodeURIComponent(teamId)}&scope=${scope}&page=${page}&pageSize=${pageSize}`, { cache: "no-store", ...(signal ? { signal } : {}) });
  const links = await readConsoleApiResponse(linksResponse, "Failed to load invitation links", parseInvitePage);
  return buildTeamInviteAudienceViewModel({
    viewerUserId,
    perspective: settings.capabilities.canManageAllInviteLinks ? "teamOwner" : "member",
    team: { id: teamId, name: teamName },
    settings,
    links,
    calculatedAt: new Date().toISOString(),
  });
}

export async function createWebTeamInvite(input: CreateTeamInviteInput): Promise<TeamInviteActionResult> {
  const response = await post("/api/team/invite-links", input);
  const body = await readConsoleApiResponse(response, "Failed to create invitation link", parseCreateInviteResponse);
  const inviteLink = body.inviteLink;
  return { kind: "create-link", inviteLink, ...(body.outcome ? { outcome: body.outcome } : {}) };
}

export async function disableWebTeamInvite(input: DisableTeamInviteInput): Promise<TeamInviteActionResult> {
  const response = await post(`/api/team/invite-links/${encodeURIComponent(input.inviteLinkId)}/disable`, { teamId: input.teamId });
  await readConsoleApiResponse<unknown>(response, "Failed to disable invitation link");
  return { kind: "disable-link" };
}

export async function updateWebTeamInviteSettings(input: UpdateTeamInviteSettingsInput): Promise<TeamInviteActionResult> {
  const payload = {
    teamId: input.teamId,
    ...(input.memberInvitesEnabled === undefined ? {} : { memberInvitesEnabled: input.memberInvitesEnabled }),
    ...(input.inviteEmailDomainPattern === undefined ? {} : { inviteEmailDomainPattern: input.inviteEmailDomainPattern }),
  };
  const response = await fetch("/api/team/invite-settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  const body = await readConsoleApiResponse(response, "Failed to update invitation settings", parseUpdateSettingsResponse);
  if (input.memberInvitesEnabled !== undefined) {
    return {
      kind: "member-invites",
      enabled: input.memberInvitesEnabled,
      ...(typeof body.disabledMemberLinkCount === "number" ? { disabledMemberLinkCount: body.disabledMemberLinkCount } : {}),
    };
  }
  return { kind: "domain-pattern", pattern: input.inviteEmailDomainPattern ?? null };
}

function post(url: string, body: object) { return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }

function parseInviteSettings(value: unknown): TeamInviteSettingsSource {
  const record = objectRecord(value, "invitation settings");
  if (typeof record.teamId !== "string"
    || typeof record.memberInvitesEnabled !== "boolean"
    || typeof record.inviteEmailDomainRestricted !== "boolean") {
    throw new Error("The server returned invalid invitation settings");
  }
  const capabilities = parseCapabilities(record.capabilities);
  const pattern = record.inviteEmailDomainPattern;
  if (pattern !== undefined && pattern !== null && typeof pattern !== "string") {
    throw new Error("The server returned an invalid invitation email domain rule");
  }
  return {
    teamId: record.teamId,
    memberInvitesEnabled: record.memberInvitesEnabled,
    inviteEmailDomainRestricted: record.inviteEmailDomainRestricted,
    ...(pattern === undefined ? {} : { inviteEmailDomainPattern: pattern }),
    capabilities,
  };
}

function parseCapabilities(value: unknown): TeamInviteCapabilities {
  const capabilities = objectRecord(value, "invitation capabilities");
  for (const key of ["canCreateInviteLinks", "canManageInviteSettings", "canManageAllInviteLinks", "canCreateUnlimitedInviteLinks"] as const) {
    if (typeof capabilities[key] !== "boolean") throw new Error("The server returned invalid invitation capabilities");
  }
  return {
    canCreateInviteLinks: capabilities.canCreateInviteLinks as boolean,
    canManageInviteSettings: capabilities.canManageInviteSettings as boolean,
    canManageAllInviteLinks: capabilities.canManageAllInviteLinks as boolean,
    canCreateUnlimitedInviteLinks: capabilities.canCreateUnlimitedInviteLinks as boolean,
  };
}

function parseInvitePage(value: unknown): TeamInvitePageViewModel {
  const page = objectRecord(value, "invitation links");
  if (!Array.isArray(page.items)
    || !Number.isInteger(page.page)
    || !Number.isInteger(page.pageSize)
    || (page.pageSize as number) < 1
    || (page.pageSize as number) > 200
    || !Number.isInteger(page.total)
    || !Number.isInteger(page.totalPages)
    || (page.scope !== "mine" && page.scope !== "all")) {
    throw new Error("The server returned invalid invitation link pagination");
  }
  return {
    items: page.items.map(parseInviteLink),
    page: page.page as number,
    pageSize: page.pageSize as number,
    total: page.total as number,
    totalPages: page.totalPages as number,
    scope: page.scope,
  };
}

function parseInviteLink(value: unknown): TeamInviteLinkViewModel {
  const link = objectRecord(value, "invitation link");
  if (typeof link.id !== "string"
    || typeof link.teamId !== "string"
    || (link.createdByUserId !== undefined && typeof link.createdByUserId !== "string")
    || (link.creatorEmail !== undefined && link.creatorEmail !== null && typeof link.creatorEmail !== "string")
    || (link.maxUses !== null && !Number.isInteger(link.maxUses))
    || (link.usedCount !== null && !Number.isInteger(link.usedCount))
    || typeof link.status !== "string"
    || typeof link.createdAt !== "string"
    || typeof link.updatedAt !== "string") {
    throw new Error("The server returned an invalid invitation link");
  }
  return {
    id: link.id,
    teamId: link.teamId,
    ...(typeof link.createdByUserId === "string" ? { createdByUserId: link.createdByUserId } : {}),
    ...(link.creatorEmail === undefined ? {} : { creatorEmail: link.creatorEmail as string | null }),
    maxUses: link.maxUses as number | null,
    usedCount: link.usedCount as number | null,
    status: link.status,
    createdAt: link.createdAt,
    updatedAt: link.updatedAt,
  };
}

function parseCreateInviteResponse(value: unknown): { inviteLink: TeamInviteLinkViewModel; outcome?: string } {
  const record = objectRecord(value, "invitation creation response");
  if (record.outcome !== undefined && typeof record.outcome !== "string") {
    throw new Error("The server returned an invalid invitation outcome");
  }
  return {
    inviteLink: parseInviteLink(record.inviteLink),
    ...(typeof record.outcome === "string" ? { outcome: record.outcome } : {}),
  };
}

function parseUpdateSettingsResponse(value: unknown): { disabledMemberLinkCount?: number } {
  const record = objectRecord(value, "invitation settings response");
  if (record.disabledMemberLinkCount !== undefined && !Number.isInteger(record.disabledMemberLinkCount)) {
    throw new Error("The server returned an invalid disabled-link count");
  }
  return record.disabledMemberLinkCount === undefined
    ? {}
    : { disabledMemberLinkCount: record.disabledMemberLinkCount as number };
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`The server returned invalid ${label}`);
  return value as Record<string, unknown>;
}
