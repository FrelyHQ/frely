import { errorStatus, RelayError } from "@frely/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseTeamUsageUrlState, teamUsageHref } from "../apps/web/features/team-usage/query";

const mocks = vi.hoisted(() => ({ services: vi.fn(), session: vi.fn() }));

vi.mock("../apps/web/lib/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../apps/web/lib/server")>()),
  handle: async (_request: Request, action: (context: { hostScope: { kind: "platform"; platformHost: "default"; hostname: string; publicOrigin: string } }) => Promise<Response> | Response) => {
    try {
      return await action({ hostScope: { kind: "platform", platformHost: "default", hostname: "localhost", publicOrigin: "http://localhost" } });
    } catch (error) {
      return Response.json({ code: error instanceof RelayError ? error.code : "error" }, { status: errorStatus(error) });
    }
  },
  services: mocks.services,
}));

vi.mock("../apps/web/lib/domain-binding", () => ({
  assertTeamAllowed: vi.fn(),
  resolveWebHostScope: vi.fn(() => ({ mode: "default" })),
}));

vi.mock("../apps/web/lib/web-page", () => ({
  requireWebUserSession: mocks.session,
}));

describe("REQ-TA-016 Team member Plan usage", () => {
  beforeEach(() => {
    mocks.services.mockReset();
    mocks.session.mockReset();
  });

  it("normalizes allowlisted URL state and preserves committed filters", () => {
    expect(parseTeamUsageUrlState({
      subscriptionId: " subscription ",
      q: " member ",
      sort: "tokens",
      direction: "asc",
      page: "2",
    })).toEqual({
      subscriptionId: "subscription",
      query: "member",
      sort: "tokens",
      direction: "asc",
      page: 2,
      pageSize: 20,
    });
    expect(parseTeamUsageUrlState({ sort: "secret", direction: "sideways", page: "0" })).toMatchObject({
      sort: "usage",
      direction: "desc",
      page: 1,
    });
    expect(teamUsageHref("team/one", {
      subscriptionId: "subscription",
      query: "member",
      sort: "requests",
      direction: "asc",
      page: 3,
      pageSize: 20,
    })).toBe("/user/team/team%2Fone/usage?subscriptionId=subscription&q=member&sort=requests&direction=asc&page=3");
  });

  it("requires all four permissions before running the bounded candidate query", async () => {
    const pageQuery = vi.fn(() => ({ items: [], page: 1, pageSize: 20, total: 0, totalPages: 1 }));
    const requirePermission = vi.fn((_claims, request: { action: string }) => {
      if (request.action === "team.billing.read") throw new RelayError("forbidden", "forbidden", 403);
    });
    mocks.services.mockResolvedValue({
      config: {},
      asyncTenancy: {
        requireUser: vi.fn(async () => ({ sub: "actor" })),
        resolveUserTeamId: vi.fn(async () => "team"),
        requirePermission,
      },
      application: { queries: { searchActiveTeamSubscriptionCandidates: pageQuery } },
    });
    const route = await import("../apps/web/pages/api/team/[[...path]]/route");
    const response = await route.GET(
      new Request("http://localhost/api/team/plan-subscription-candidates?teamId=team", { headers: { host: "localhost" } }),
      { params: Promise.resolve({ path: ["plan-subscription-candidates"] }) },
    );

    expect(response.status).toBe(403);
    expect(requirePermission.mock.calls.map((call) => call[1].action)).toEqual([
      "team.read",
      "team.member.read",
      "team.usage.read",
      "team.billing.read",
    ]);
    expect(pageQuery).not.toHaveBeenCalled();
  });

  it("rejects unknown candidate parameters and returns real page metadata", async () => {
    const pageQuery = vi.fn(() => ({
      items: [{ id: "subscription", planName: "Plan", planVersion: 1, billingMode: "prepaid", effectiveStart: "2026-07-30T00:00:00.000Z", effectiveEnd: null }],
      page: 2,
      pageSize: 20,
      total: 21,
      totalPages: 2,
    }));
    mocks.services.mockResolvedValue({
      config: {},
      asyncTenancy: {
        requireUser: vi.fn(async () => ({ sub: "actor" })),
        resolveUserTeamId: vi.fn(async () => "team"),
        requirePermission: vi.fn(),
      },
      application: { queries: { searchActiveTeamSubscriptionCandidates: pageQuery } },
    });
    const route = await import("../apps/web/pages/api/team/[[...path]]/route");
    const invalid = await route.GET(
      new Request("http://localhost/api/team/plan-subscription-candidates?teamId=team&secret=value", { headers: { host: "localhost" } }),
      { params: Promise.resolve({ path: ["plan-subscription-candidates"] }) },
    );
    expect(invalid.status).toBe(400);
    expect(pageQuery).not.toHaveBeenCalled();
    const missingTeam = await route.GET(
      new Request("http://localhost/api/team/plan-subscription-candidates", { headers: { host: "localhost" } }),
      { params: Promise.resolve({ path: ["plan-subscription-candidates"] }) },
    );
    expect(missingTeam.status).toBe(400);
    expect(pageQuery).not.toHaveBeenCalled();
    for (const url of [
      `http://localhost/api/team/plan-subscription-candidates?teamId=team&q=${"x".repeat(101)}`,
      "http://localhost/api/team/plan-subscription-candidates?teamId=team&page=0",
      "http://localhost/api/team/plan-subscription-candidates?teamId=team&page=10001",
    ]) {
      const rejected = await route.GET(
        new Request(url, { headers: { host: "localhost" } }),
        { params: Promise.resolve({ path: ["plan-subscription-candidates"] }) },
      );
      expect(rejected.status).toBe(400);
    }
    expect(pageQuery).not.toHaveBeenCalled();

    const response = await route.GET(
      new Request("http://localhost/api/team/plan-subscription-candidates?teamId=team&q=%20Plan%20&page=2", { headers: { host: "localhost" } }),
      { params: Promise.resolve({ path: ["plan-subscription-candidates"] }) },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ page: 2, pageSize: 20, total: 21, totalPages: 2 });
    expect(pageQuery).toHaveBeenCalledWith(expect.objectContaining({ teamId: "team", query: "Plan", page: 2, pageSize: 20 }));
  });

  it("authorizes the RSC before aggregation and audits the same calculated snapshot", async () => {
    const requirePermission = vi.fn();
    const pageQuery = vi.fn(() => ({
      subscription: candidate,
      periodStart: candidate.effectiveStart,
      periodEnd: "2026-07-30T01:00:00.000Z",
      calculatedAt: "2026-07-30T01:00:00.000Z",
      summary: {
        requestCount: 0,
        totalTokens: 0,
        billableAmount: 0,
        currentMemberRequestCount: 0,
        currentMemberTokens: 0,
        currentMemberBillableAmount: 0,
        historicalRequestCount: 0,
        historicalTokens: 0,
        historicalBillableAmount: 0,
      },
      items: [],
      page: 1,
      pageSize: 50,
      total: 0,
      totalPages: 1,
    }));
    const candidateQuery = vi.fn(() => ({
      items: [candidate],
      page: 1,
      pageSize: 20,
      total: 1,
      totalPages: 1,
    }));
    const audit = vi.fn();
    mocks.session.mockResolvedValue({
      claims: { sub: "actor" },
      services: {
        asyncTenancy: {
          resolveUserTeamId: vi.fn(async () => "team"),
          requirePermission,
        },
        application: {
          audit: { record: audit },
          queries: {
            audit,
            searchActiveTeamSubscriptionCandidates: candidateQuery,
            pageTeamMemberUsage: pageQuery,
          },
        },
      },
    });

    const pageModule = await import("../apps/web/pages/user/team/[teamId]/usage/page.server");
    await pageModule.loadPage("team", { subscriptionId: "subscription" });

    expect(requirePermission.mock.calls.map((call) => call[1].action)).toEqual([
      "team.read",
      "team.member.read",
      "team.usage.read",
      "team.billing.read",
    ]);
    expect(pageQuery).toHaveBeenCalledTimes(1);
    const input = pageQuery.mock.calls[0]![0];
    expect(candidateQuery).toHaveBeenCalledWith(expect.objectContaining({ calculatedAt: input.calculatedAt }));
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      actor: { actorType: "user", actorId: "actor" },
      action: "plan_budget_usage.read",
      resourceType: "plan_subscription",
      resourceId: "subscription",
      result: "success",
      source: "web",
      metadata: {
        routePattern: "/user/team/:teamId/usage",
        teamId: "team",
        subscriptionId: "subscription",
        calculatedAt: input.calculatedAt,
      },
    }));
  });

  it("does not aggregate or audit when the Team has no active Plan source", async () => {
    const pageQuery = vi.fn();
    const audit = vi.fn();
    mocks.session.mockResolvedValue({
      claims: { sub: "actor" },
      services: {
        asyncTenancy: {
          resolveUserTeamId: vi.fn(async () => "team"),
          requirePermission: vi.fn(),
        },
        application: {
          queries: {
            audit,
            searchActiveTeamSubscriptionCandidates: vi.fn(() => ({
              items: [],
              page: 1,
              pageSize: 20,
              total: 0,
              totalPages: 1,
            })),
            pageTeamMemberUsage: pageQuery,
          },
        },
      },
    });

    const pageModule = await import("../apps/web/pages/user/team/[teamId]/usage/page.server");
    await pageModule.loadPage("team", {});

    expect(pageQuery).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
});

const candidate = {
  id: "subscription",
  planName: "Team Plan",
  planVersion: 2,
  billingMode: "prepaid" as const,
  effectiveStart: "2026-07-30T00:00:00.000Z",
  effectiveEnd: null,
};
