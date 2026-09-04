import { describe, expect, test, vi } from "vitest";
import { decideCanonicalEmailUpgrade, EmailAddr } from "./index.js";
import { IdentityCanonicalEmailUpgrade, IdentityCommands } from "./server.js";

describe("EmailAddr", () => {
  test("canonicalizes command input and rejects non-canonical stored values", () => {
    const canonical = EmailAddr.parse("  User@Example.COM  ");
    expect(canonical.value).toBe("user@example.com");
    expect(canonical.equals(EmailAddr.parse("user@example.com"))).toBe(true);
    expect(() => EmailAddr.restore("User@example.com")).toThrowError(/not canonical/i);
    expect(EmailAddr.parse("first.last+tag@example.com").value).toBe("first.last+tag@example.com");
  });
});

describe("retired OIDC authorization-code protocol", () => {
  test("fails closed before reading or mutating legacy credential state", async () => {
    const updateMany = vi.fn();
    const findUser = vi.fn();
    const transaction = {
      oidc_authorization_codes: {
        findUnique: vi.fn(async () => ({
          id: "oidc_code_expired",
          code_hash: "expired-hash",
          user_id: "user_oidc",
          client_id: "client_oidc",
          redirect_uri: "https://client.example.test/callback",
          scope: "openid",
          code_challenge: "challenge",
          nonce: "nonce",
          created_at: "2026-08-26T00:00:00.000Z",
          expires_at: "2026-08-26T00:01:00.000Z",
          consumed_at: null,
        })),
        updateMany,
      },
      users: { findUnique: findUser },
    };
    const commands = new IdentityCommands({
      prisma: transaction,
      withPrismaTransaction: (callback: (client: typeof transaction) => Promise<unknown>) => callback(transaction),
    } as never);

    await expect(commands.exchangeOidcAuthorizationCode({
      codeHash: "expired-hash",
      clientId: "client_oidc",
      redirectUri: "https://client.example.test/callback",
      codeChallenge: "challenge",
      accessTokenHash: "unused-access-hash",
      accessTokenAudience: "client_oidc",
      accessTokenExpiresAt: "2026-08-26T00:06:00.000Z",
      now: "2026-08-26T00:01:00.000Z",
    })).rejects.toMatchObject({ code: "auth_method_retired", status: 404 });
    expect(updateMany).not.toHaveBeenCalled();
    expect(findUser).not.toHaveBeenCalled();
  });
});

describe("canonical email upgrade decision", () => {
  test("rejects execution when the recorded batch no longer matches the user snapshot", async () => {
    const transaction = {
      $queryRaw: async () => [],
      users: { findMany: async () => [] },
      identity_migration_batches: {
        findUnique: async () => ({
          id: "identity_migration_test",
          migration_kind: "canonical_email_v1",
          rule_version: "canonical-email-v1",
          snapshot_digest: "0".repeat(64),
          observed_user_count: 0,
          status: "preflighted",
        }),
      },
    };
    const upgrade = new IdentityCanonicalEmailUpgrade({
      prisma: {} as never,
      withPrismaTransaction: (callback: (client: typeof transaction) => Promise<unknown>) => callback(transaction),
    } as never, {
      bind: () => ({
        classifyUser: async () => ({ activePlatformOwner: false, ownedTenantCount: 0, unsafeReferenceCount: 0, transferStateFingerprint: "empty" }),
        transferMemberships: async () => undefined,
      }),
    });
    await expect(upgrade.run({ batchId: "identity_migration_test", execute: true, offlineConfirmed: true }))
      .rejects.toMatchObject({ code: "identity_email_upgrade_snapshot_changed" });
  });

  test("keeps oldest identity then id and freezes deterministic conflicts", () => {
    const decisions = decideCanonicalEmailUpgrade([
      { id: "user_b", createdAt: "2026-01-01T00:00:00.000Z", credentialConflict: false, credentialCount: 0, activePlatformOwner: false, ownedTenantCount: 0, otherFactReferenceCount: 0, transferStateFingerprint: "b" },
      { id: "user_a", createdAt: "2026-01-01T00:00:00.000Z", credentialConflict: false, credentialCount: 0, activePlatformOwner: false, ownedTenantCount: 0, otherFactReferenceCount: 0, transferStateFingerprint: "a" },
      { id: "user_z", createdAt: "2026-01-02T00:00:00.000Z", credentialConflict: false, credentialCount: 0, activePlatformOwner: false, ownedTenantCount: 0, otherFactReferenceCount: 0, transferStateFingerprint: "z" },
      { id: "user_c", createdAt: "2026-01-03T00:00:00.000Z", credentialConflict: true, credentialCount: 1, activePlatformOwner: true, ownedTenantCount: 1, otherFactReferenceCount: 0, transferStateFingerprint: "c" },
    ]);
    expect(decisions).toEqual([
      { survivorUserId: "user_a", sourceUserId: "user_b", outcome: "merge", conflicts: [] },
      { survivorUserId: "user_a", sourceUserId: "user_z", outcome: "merge", conflicts: [] },
      { survivorUserId: "user_a", sourceUserId: "user_c", outcome: "freeze", conflicts: ["credential_conflict", "platform_owner_conflict", "tenant_ownership_conflict"] },
    ]);
  });
});
