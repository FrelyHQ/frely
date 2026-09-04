import { nowIso, RelayError, type ScopeRef } from "@frely/core";
import type { GatewayQueries } from "./async-gateway-contract.js";
import type { EntitlementQueries } from "@frely/entitlement/server";
import type { AsyncGatewayPolicyGuards } from "./async-services.js";
import type { PartnerOperatingDecision, PersonalProviderSlotAccessDecision, TeamProviderAccessStateSnapshot } from "@frely/entitlement";

/** Every policy check is performed against the shared PostgreSQL database. */
export function createPostgresGatewayPolicyGuards(
  repository: Pick<GatewayQueries, "findFirstOrderedPlanSourceForUser" | "getProvider">,
  entitlement: Pick<EntitlementQueries,
    "decidePartnerOperating" | "decidePartnerOperatings"
    | "getTeamProviderAccessState" | "getTeamProviderAccessStates"
    | "decidePersonalProviderAccess" | "decidePersonalProviderAccesses"
  >,
): AsyncGatewayPolicyGuards {
  return {
    async assertPreferredPartnerSourceActive(userId, exposedModel, at = nowIso(), restriction) {
      const preferred = await repository.findFirstOrderedPlanSourceForUser(userId, exposedModel, at, restriction);
      if (preferred) await this.assertPartnerAccessActiveForScope(preferred.order.subscriptionScopeRef as ScopeRef, at);
    },
    async assertPartnerAccessActiveForScope(scopeRef, at = nowIso()) {
      if (!scopeRef.startsWith("team:")) return;
      const state = await entitlement.decidePartnerOperating(scopeRef.slice("team:".length), at);
      assertPartnerDecision(state);
    },
    async assertPartnerAccessActiveForScopes(scopeRefs, at = nowIso()) {
      const teamIds = [...new Set(scopeRefs.filter((scopeRef) => scopeRef.startsWith("team:")).map((scopeRef) => scopeRef.slice("team:".length)))];
      if (teamIds.length === 0) return;
      const states = await entitlement.decidePartnerOperatings(teamIds, at);
      for (const teamId of teamIds) {
        const state = states.get(teamId);
        if (!state) throw new RelayError("partner_policy_snapshot_incomplete", "Partner policy snapshot is incomplete", 500);
        assertPartnerDecision(state);
      }
    },
    async assertTeamProviderAccessActive(providerId, at = nowIso(), providerScopeRef) {
      const scopeRef = providerScopeRef ?? (await repository.getProvider(providerId))?.scopeRef as ScopeRef | undefined;
      if (!scopeRef?.startsWith("team:")) return;
      const state = await entitlement.getTeamProviderAccessState(scopeRef.slice("team:".length), at);
      if (state.state === "active" || state.state === "permanent") return;
      if (state.state === "not_entitled") throw new RelayError("team_provider_entitlement_required", "Team Provider entitlement is required", 402);
      throw new RelayError("team_provider_entitlement_expired", "Team Provider entitlement is expired or not yet active", 402);
    },
    async assertProviderAccessActiveForProviders(providers, at = nowIso()) {
      const teamProviders = providers.filter((provider) => provider.scopeRef.startsWith("team:"));
      const personalProviders = providers.filter((provider) => provider.scopeRef.startsWith("user:"));
      const teamIds = [...new Set(teamProviders.map((provider) => provider.scopeRef.slice("team:".length)))];
      const teamStates = await entitlement.getTeamProviderAccessStates(teamIds, at);
      const personalIds = [...new Set(personalProviders.map((provider) => provider.id))];
      const personalStates = await entitlement.decidePersonalProviderAccesses(personalIds, at);
      for (const provider of teamProviders) {
        const state = teamStates.get(provider.scopeRef.slice("team:".length));
        if (!state) throw new RelayError("team_provider_policy_snapshot_incomplete", "Team Provider policy snapshot is incomplete", 500);
        assertTeamProviderState(state);
      }
      for (const provider of personalProviders) {
        const decision = personalStates.get(provider.id);
        if (!decision) throw new RelayError("personal_provider_policy_snapshot_incomplete", "Personal Provider policy snapshot is incomplete", 500);
        assertPersonalProviderDecision(decision);
      }
    },
    async assertPersonalProviderAccessActive(providerId, at = nowIso(), providerScopeRef) {
      const scopeRef = providerScopeRef ?? (await repository.getProvider(providerId))?.scopeRef as ScopeRef | undefined;
      if (!scopeRef?.startsWith("user:")) return;
      const decision = await entitlement.decidePersonalProviderAccess(providerId, at);
      // A user scope identifies the Provider's resource and economic subject;
      // only an explicit slot relation classifies it as a personal Provider product.
      if (decision.kind === "allowed" || decision.state === "not_found") return;
      throw new RelayError("personal_provider_entitlement_expired", "The personal Provider slot is not active", 402, { state: decision.state });
    },
  };
}

function assertPartnerDecision(state: PartnerOperatingDecision): void {
  if (state.kind === "allowed" || state.state === "not_partner") return;
  throw new RelayError("partner_subscription_expired", "This Partner service has expired. Use the main platform service or ask the Partner to renew.", 402);
}

function assertTeamProviderState(state: TeamProviderAccessStateSnapshot): void {
  if (state.state === "active" || state.state === "permanent") return;
  if (state.state === "not_entitled") throw new RelayError("team_provider_entitlement_required", "Team Provider entitlement is required", 402);
  throw new RelayError("team_provider_entitlement_expired", "Team Provider entitlement is expired or not yet active", 402);
}

function assertPersonalProviderDecision(decision: PersonalProviderSlotAccessDecision): void {
  if (decision.kind === "allowed" || decision.state === "not_found") return;
  throw new RelayError("personal_provider_entitlement_expired", "The personal Provider slot is not active", 402, { state: decision.state });
}
