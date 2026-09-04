import { describe, expect, test, vi } from "vitest";
import { AsyncControlPlaneTenancyService } from "./identity-tenancy.js";

class NoGrantTenancyService extends AsyncControlPlaneTenancyService {
  constructor(contexts: Record<string, unknown>) {
    const queries = { identity: contexts.identity, authority: contexts.authority, tenancy: contexts.tenancy };
    const commands = { identityCommands: contexts.identityCommands, tenancyCommands: contexts.tenancyCommands, auditCommands: { record: contexts.audit } };
    const transaction = { ...queries, commands };
    super(queries as never, commands as never, { run: async (callback: (value: never) => Promise<unknown>) => callback(transaction as never) } as never, {} as never);
  }

  override async hasPermission(): Promise<boolean> {
    return false;
  }
}

describe("Team Owner invitation authority", () => {
  test("lets the current Team Owner create an invite without the member-wide grant", async () => {
    const audit = vi.fn();
    const inviteLink = {
      id: "invite_owner",
      teamId: "team_owned",
      createdByUserId: "user_owner",
      maxUses: 1,
      usedCount: 0,
      activeLimitExempt: 1,
      status: "enabled",
      createdAt: "2026-08-26T00:00:00.000Z",
      updatedAt: "2026-08-26T00:00:00.000Z",
    };
    const contexts: Record<string, unknown> = {
      identity: {},
      identityCommands: {},
      authority: {},
      tenancy: {
        getTeam: vi.fn(async () => ({ id: "team_owned", ownerId: "user_owner", status: "enabled" })),
        isTeamAvailable: vi.fn(async () => true),
      },
      tenancyCommands: {
        createInviteLink: vi.fn(async () => inviteLink),
      },
      audit,
    };
    const service = new NoGrantTenancyService(contexts);

    await expect(service.createTeamInviteLink("team_owned", {
      actor: { actorType: "user", actorId: "user_owner" },
      source: "web",
      requestId: "req_owner_invite",
    }, 1)).resolves.toEqual({ inviteLink, outcome: "created" });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "team_invite_link.create",
      result: "success",
      resource: { resourceType: "team_invite_link", resourceId: "invite_owner" },
    }));
  });
});
