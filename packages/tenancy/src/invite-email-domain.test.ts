import { describe, expect, test, vi } from "vitest";
import { AsyncControlPlaneTenancyService } from "@frely/application/server";
import {
  inviteEmailDomainAllowed,
  normalizeInviteEmailDomainPattern,
  testInviteEmailDomainPattern,
} from "@frely/tenancy-context";

class InviteTestTenancyService extends AsyncControlPlaneTenancyService {
  constructor(transaction: Record<string, unknown>) {
    const queries = { identity: transaction.identity, authority: transaction.authority, tenancy: transaction.tenancy };
    const commands = { identityCommands: transaction.identityCommands, tenancyCommands: transaction.tenancyCommands, audit: transaction.audit };
    super(queries as never, commands as never, { run: async (callback: (value: never) => Promise<unknown>) => callback({ ...queries, commands } as never) } as never, {} as never);
  }
}

describe("invitation email domain rules", () => {
  test("normalizes case and matches only the exact configured domain", () => {
    expect(normalizeInviteEmailDomainPattern(" Example.COM ")).toBe("example.com");
    expect(testInviteEmailDomainPattern("User@Example.COM", "example.com")).toEqual({
      allowed: true,
      domain: "example.com",
    });
    expect(testInviteEmailDomainPattern("user@sub.example.com", "example.com")).toEqual({
      allowed: false,
      domain: "sub.example.com",
    });
  });

  test("canonicalizes a legacy exact escaped-dot value", () => {
    expect(normalizeInviteEmailDomainPattern("example\\.com")).toBe("example.com");
    expect(inviteEmailDomainAllowed("user@example.com", "example\\.com")).toBe(true);
  });

  test("rejects complex expressions and invalid domains", () => {
    expect(() => normalizeInviteEmailDomainPattern("(?:[a-z0-9-]+\\.)*example\\.com")).toThrowError(
      expect.objectContaining({ code: "invalid_invite_email_domain_pattern", status: 400 }),
    );
    expect(() => normalizeInviteEmailDomainPattern("bad_domain.example")).toThrowError(
      expect.objectContaining({ code: "invalid_invite_email_domain_pattern", status: 400 }),
    );
    expect(inviteEmailDomainAllowed("user@example.com", "(?:[a-z0-9-]+\\.)*example\\.com")).toBe(false);
  });

  test("fails a stored complex rule before consuming the invite or creating records", async () => {
    const consumeTeamInviteLinkUse = vi.fn();
    const upsertUser = vi.fn();
    const grantTeamMembershipByInvite = vi.fn();
    const transaction = {
      identity: {
        findUserByEmail: vi.fn(async () => undefined),
        getUser: vi.fn(async () => undefined),
        createUser: upsertUser,
        platformRolesForUser: vi.fn(async () => []),
      },
      tenancy: {
        getInviteLink: vi.fn(async () => ({
          id: "invite_1",
          teamId: "team_1",
          createdByUserId: "owner_1",
          status: "enabled",
        })),
        getTeam: vi.fn(async () => ({
          id: "team_1",
          ownerId: "owner_1",
          inviteEmailDomainPattern: "(?:[a-z0-9-]+\\.)*example\\.com",
        })),
        isTeamAvailable: vi.fn(async () => true),
        getMembership: vi.fn(async () => undefined),
        consumeInviteLink: consumeTeamInviteLinkUse,
        grantMembership: grantTeamMembershipByInvite,
      },
      audit: vi.fn(async () => undefined),
    };
    const service = new InviteTestTenancyService(transaction);

    await expect(service.acceptTeamInviteLink("invite_1", {
      email: "user@example.com",
      passwordHash: "hash",
    })).rejects.toMatchObject({ code: "invite_email_domain_not_allowed", status: 403 });
    expect(consumeTeamInviteLinkUse).not.toHaveBeenCalled();
    expect(upsertUser).not.toHaveBeenCalled();
    expect(grantTeamMembershipByInvite).not.toHaveBeenCalled();
  });
});
