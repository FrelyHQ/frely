import { assertAuditEventDraft } from "@frely/audit";
import { errorStatus, RelayError } from "@frely/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ services: vi.fn() }));

vi.mock("../apps/web/lib/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../apps/web/lib/server")>()),
  handle: async (_request: Request, action: (context: { hostScope: { kind: "platform"; platformHost: "default"; hostname: string; publicOrigin: string } }) => Promise<Response> | Response) => {
    try {
      return await action({ hostScope: { kind: "platform", platformHost: "default", hostname: "localhost", publicOrigin: "http://localhost" } });
    } catch (error) {
      return Response.json({}, { status: errorStatus(error) });
    }
  },
  services: mocks.services
}));

describe("REQ-MEMBER-015 Team member route privacy", () => {
  beforeEach(() => mocks.services.mockReset());

  it("returns 403 before querying members when a default Viewer lacks team.member.read", async () => {
    const listUsers = vi.fn();
    const requirePermission = vi.fn(() => {
      throw new RelayError("forbidden", "Permission team.member.read is required", 403);
    });
    mocks.services.mockResolvedValue({
      config: { app: { publicBaseUrl: "http://localhost" } },
      asyncTenancy: {
        requireUser: vi.fn(async () => ({ sub: "user_viewer", email: "viewer@example.local", platformRoles: [], teamRoles: [] })),
        resolveUserTeamId: vi.fn(async () => "team_viewer"),
        requirePermission,
        listUsers
      },
      application: { queries: {} }
    });
    const route = await import("../apps/web/pages/api/team/[[...path]]/route");

    const response = await route.GET(new Request("http://localhost/api/team/members?teamId=team_viewer", { headers: { host: "localhost" } }), {
      params: Promise.resolve({ path: ["members"] })
    });

    expect(response.status).toBe(403);
    expect(requirePermission).toHaveBeenCalledWith(
      expect.objectContaining({ sub: "user_viewer" }),
      { resourceType: "team", resourceId: "team_viewer", action: "team.member.read" },
      { allowPlatformOwner: false }
    );
    expect(listUsers).not.toHaveBeenCalled();
  });
});

describe("REQ-TA-002 Team Provider route audit", () => {
  beforeEach(() => mocks.services.mockReset());

  it("updates a Team ProviderModel with the web actor and an allowlisted audit draft", async () => {
    const changeProviderModel = vi.fn(async (
      providerId: string,
      providerModelName: string,
      command: { status?: "enabled" | "disabled" },
      audit: Record<string, unknown>,
    ) => {
      assertAuditEventDraft({
        ...audit,
        action: "provider_model.upsert",
        resourceType: "provider_model",
        resourceId: "provider_model_team_gpt_5_4",
        result: "success",
        metadata: {
          providerId,
          providerModelId: "provider_model_team_gpt_5_4",
          status: command.status ?? "disabled",
          changed: true,
        },
      });
      return {
        id: "provider_model_team_gpt_5_4",
        providerId,
        providerModelName,
        displayName: providerModelName,
        status: command.status ?? "disabled",
      };
    });
    mocks.services.mockResolvedValue({
      asyncTenancy: {
        requireUser: vi.fn(async () => ({ sub: "user_team_owner", email: "owner@example.local", platformRoles: [], teamRoles: [] })),
        resolveUserTeamId: vi.fn(async () => "team_provider"),
        requirePermission: vi.fn(async () => undefined),
        tenancy: { getTeam: vi.fn(async () => ({ id: "team_provider", ownerId: "user_team_owner" })) },
      },
      application: {
        queries: {
          assertPartnerManagementActive: vi.fn(async () => undefined),
          getTeamProviderEntitlementState: vi.fn(async () => ({ state: "active" })),
        },
        commands: {},
        modelAccessQueries: {
          getProvider: vi.fn(async () => ({ id: "prv_aaaaaaaaaaaaaaaaaaaaaaaa", scopeRef: "team:team_provider" })),
        },
        modelAccess: { providers: { changeProviderModel } },
      },
    });
    const route = await import("../apps/web/pages/api/team/[[...path]]/route");

    const response = await route.PATCH(new Request("http://localhost/api/team/providers/prv_aaaaaaaaaaaaaaaaaaaaaaaa/models/gpt-5.4", {
      method: "PATCH",
      headers: { host: "localhost", "content-type": "application/json", "x-request-id": "req_team_provider_model_update" },
      body: JSON.stringify({ teamId: "team_provider", status: "enabled" }),
    }), {
      params: Promise.resolve({ path: ["providers", "prv_aaaaaaaaaaaaaaaaaaaaaaaa", "models", "gpt-5.4"] }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      providerId: "prv_aaaaaaaaaaaaaaaaaaaaaaaa",
      providerModelName: "gpt-5.4",
      status: "enabled",
    });
    expect(changeProviderModel).toHaveBeenCalledOnce();
  });
});
