import { describe, expect, test, vi } from "vitest";
import { createPostgresGatewayPolicyGuards } from "./async-policy-guards.js";
import { assertPersonalProviderPolicy } from "./async-services.js";

describe("personal Provider Gateway guard", () => {
  test("fails closed for a user-scope Provider when composition omits the policy hook", async () => {
    const guards = {
      async assertPartnerAccessActiveForScope() {},
      async assertPartnerAccessActiveForScopes() {},
      async assertTeamProviderAccessActive() {},
      async assertProviderAccessActiveForProviders() {},
    };

    await expect(assertPersonalProviderPolicy(guards, "provider-user", "2026-01-01T00:00:00.000Z", "user:user-a"))
      .rejects.toMatchObject({ code: "personal_provider_policy_unavailable", status: 503 });
    await expect(assertPersonalProviderPolicy(guards, "provider-team", "2026-01-01T00:00:00.000Z", "team:team-a"))
      .resolves.toBeUndefined();
  });

  test("enforces personal entitlement only for slot-bound user Providers", async () => {
    const decidePersonalProviderAccess = vi.fn(async (providerId: string) => providerId === "provider-active"
      ? { kind: "allowed", state: "active", slotId: "slot-active", effectiveEnd: "2027-01-01T00:00:00.000Z" } as const
      : providerId === "provider-expired"
        ? { kind: "denied", state: "expired_hot", slotId: "slot-expired", latestEffectiveEnd: "2026-01-01T00:00:00.000Z", renewalCutoff: "2026-06-30T00:00:00.000Z" } as const
        : { kind: "denied", state: "not_found", slotId: null, latestEffectiveEnd: null, renewalCutoff: null } as const);
    const guards = createPostgresGatewayPolicyGuards({
      async findFirstOrderedPlanSourceForUser() { return null; },
      async getProvider(providerId: string) { return { id: providerId, scopeRef: "user:user-a" } as never; },
    }, {
      async decidePartnerOperating() { return { kind: "denied", state: "not_partner", latestEffectiveEnd: null }; },
      async decidePartnerOperatings() { return new Map(); },
      async getTeamProviderAccessState() { return { state: "not_entitled", entitlement: null, nextEntitlement: null, latestEffectiveEnd: null }; },
      async getTeamProviderAccessStates() { return new Map(); },
      decidePersonalProviderAccess,
      async decidePersonalProviderAccesses(providerIds: readonly string[]) {
        const entries = [];
        for (const providerId of providerIds) entries.push([providerId, await decidePersonalProviderAccess(providerId)] as const);
        return new Map(entries);
      },
    });

    await expect(guards.assertPersonalProviderAccessActive?.("provider-active", undefined, "user:user-a")).resolves.toBeUndefined();
    await expect(guards.assertPersonalProviderAccessActive?.("provider-expired", undefined, "user:user-a")).rejects.toMatchObject({ code: "personal_provider_entitlement_expired", status: 402 });
    await expect(guards.assertPersonalProviderAccessActive?.("provider-legacy", undefined, "user:user-a")).resolves.toBeUndefined();
    expect(decidePersonalProviderAccess).toHaveBeenCalledTimes(3);
  });
});
