import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAdminTeamInvite,
  disableAdminTeamInvite,
  updateAdminTeamInviteSettings,
} from "../apps/admin/features/teams/api/team-api";
import {
  createWebTeamInvite,
  disableWebTeamInvite,
  fetchTeamInviteData,
  updateWebTeamInviteSettings,
} from "../apps/web/features/team-invites/api/team-invite-api";

afterEach(() => vi.unstubAllGlobals());

describe("Team invitation application adapters", () => {
  it("maps the paged Web API response into the shared audience model", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json(settings()))
      .mockResolvedValueOnce(Response.json({
        items: [inviteLink()],
        page: 2,
        pageSize: 50,
        total: 51,
        totalPages: 2,
        scope: "all",
      }));
    vi.stubGlobal("fetch", fetchMock);

    const model = await fetchTeamInviteData("team-1", "Team One", "owner-1", 2, 50);

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/team/invite-settings?teamId=team-1");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/team/invite-links?teamId=team-1&scope=all&page=2&pageSize=50");
    expect(model.audience).toEqual({ userId: "owner-1", teamId: "team-1", perspective: "teamOwner" });
    expect(model.links).toMatchObject({ page: 2, pageSize: 50, total: 51, totalPages: 2, scope: "all" });
  });

  it("keeps Web mutations on Team API action ports", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ inviteLink: inviteLink(), outcome: "created" }))
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(Response.json({ disabledMemberLinkCount: 3 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createWebTeamInvite({ teamId: "team-1", maxUses: 5 })).resolves.toMatchObject({ kind: "create-link", outcome: "created" });
    await expect(disableWebTeamInvite({ teamId: "team-1", inviteLinkId: "invite-1" })).resolves.toEqual({ kind: "disable-link" });
    await expect(updateWebTeamInviteSettings({ teamId: "team-1", memberInvitesEnabled: false })).resolves.toEqual({ kind: "member-invites", enabled: false, disabledMemberLinkCount: 3 });

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "/api/team/invite-links",
      "/api/team/invite-links/invite-1/disable",
      "/api/team/invite-settings",
    ]);
  });

  it("keeps Platform Owner mutations on Owner API action ports", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ inviteLink: inviteLink(), outcome: "created" }))
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(Response.json({}));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createAdminTeamInvite({ teamId: "team-1", maxUses: null })).resolves.toMatchObject({ kind: "create-link", outcome: "created" });
    await expect(disableAdminTeamInvite({ teamId: "team-1", inviteLinkId: "invite-1" })).resolves.toEqual({ kind: "disable-link" });
    await expect(updateAdminTeamInviteSettings({ teamId: "team-1", inviteEmailDomainPattern: null })).resolves.toEqual({ kind: "domain-pattern", pattern: null });

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "/api/owner/teams/team-1/invite-links",
      "/api/owner/teams/team-1/invite-links/invite-1/disable",
      "/api/owner/teams/team-1/invite-settings",
    ]);
  });
});

function settings() {
  return {
    teamId: "team-1",
    memberInvitesEnabled: true,
    inviteEmailDomainRestricted: false,
    inviteEmailDomainPattern: null,
    capabilities: {
      canCreateInviteLinks: true,
      canManageInviteSettings: true,
      canManageAllInviteLinks: true,
      canCreateUnlimitedInviteLinks: false,
    },
  };
}

function inviteLink() {
  return {
    id: "invite-1",
    teamId: "team-1",
    createdByUserId: "owner-1",
    creatorEmail: "owner@example.local",
    maxUses: 5,
    usedCount: 0,
    status: "enabled",
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z",
  };
}
