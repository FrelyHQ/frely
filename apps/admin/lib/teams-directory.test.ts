import { describe, expect, test, vi } from "vitest";
import type { TeamDirectoryPage, UiSyncQueryPort } from "@frely/ui-application/contracts";
import { adminTeamsHref, buildAdminTeamsAggregate, parseAdminTeamsSearch } from "./teams";

describe("Admin Teams directory", () => {
  test("normalizes URL state and preserves it in pagination links", () => {
    const state = parseAdminTeamsSearch({ q: " Relay ", page: "2", sort: "members", direction: "desc" });

    expect(state).toEqual({ query: "relay", page: 2, pageSize: 20, sort: "members", direction: "desc" });
    expect(adminTeamsHref(state, { page: 3 })).toBe("/owner/teams?q=relay&page=3&sort=members&direction=desc");

    const custom = parseAdminTeamsSearch({ pageSize: "37" }, true);
    expect(custom.pageSize).toBe(37);
    expect(adminTeamsHref(custom)).toBe("/owner/teams?pageSize=37");
  });

  test("rejects invalid API pagination and sort values", () => {
    expect(() => parseAdminTeamsSearch({ page: "later" }, true)).toThrow(/positive integer/);
    expect(() => parseAdminTeamsSearch({ pageSize: "201" }, true)).toThrow(/1 to 200/);
    expect(() => parseAdminTeamsSearch({ pageSize: "1.5" }, true)).toThrow(/1 to 200/);
    expect(() => parseAdminTeamsSearch({ sort: "plan" }, true)).toThrow(/Unsupported Team directory sort/);
    expect(() => parseAdminTeamsSearch({ direction: "sideways" }, true)).toThrow(/asc or desc/);
  });

  test("loads a 20-row server page without the removed Plan fields or whole-list methods", () => {
    const page: TeamDirectoryPage = {
      rows: [directoryTeam()],
      page: 2,
      pageSize: 20,
      total: 21,
      totalPages: 2
    };
    const listTeamDirectoryPage = vi.fn(() => page);
    const listTeamDeleteBlockersForTeams = vi.fn(() => new Map([["team_021", []]]));
    const getDirectoryMetrics = vi.fn(() => ({
      totalTeams: 21,
      activeTeams: 21,
      activeUsers: 0,
      apiKeyCount: 0,
      totalTokens: 0,
      totalCost: 0,
      totalBudget: 0
    }));
    const repo = {
      pageAdminTeamDirectory: listTeamDirectoryPage,
      getAdminTeamDirectoryMetrics: getDirectoryMetrics,
      listTeamDeleteBlockersForTeams
    } as unknown as UiSyncQueryPort;

    const result = buildAdminTeamsAggregate(repo, { query: "", page: 2, pageSize: 20, sort: "createdAt", direction: "asc" });

    expect(listTeamDirectoryPage).toHaveBeenCalledWith({ query: "", page: 2, pageSize: 20, sort: "createdAt", direction: "asc" });
    expect(result).toMatchObject({ page: 2, pageSize: 20, total: 21, totalPages: 2 });
    expect(result.rows[0]).not.toHaveProperty("planName");
    expect(result.rows[0]).not.toHaveProperty("usage");
    expect(result.rows[0]).not.toHaveProperty("budgetState");
    expect(listTeamDeleteBlockersForTeams).toHaveBeenCalledWith(["team_021"]);
    expect(getDirectoryMetrics).toHaveBeenCalledOnce();
  });
});

function directoryTeam(): TeamDirectoryPage["rows"][number] {
  return {
    id: "team_021",
    ownerId: "owner_021",
    name: "Team 021",
    status: "enabled",
    teamOwnerCanManageMemberApiKeyLimit: 0,
    teamOwnerCanManageMemberCredit: 0,
    teamOwnerCanCreateCustomProvider: 0,
    teamOwnerCanCreateAccessPoint: 0,
    inviteEmailDomainPattern: null,
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
    memberCount: 2,
    teamAccessCount: 0,
    inheritedAccessCount: 1
  };
}
