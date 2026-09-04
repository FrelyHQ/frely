import { RelayError, type ScopeRef } from "@frely/core";
import type { GatewayQueries } from "./async-gateway-contract.js";
import { createGatewayRoutingBudget, type GatewayRoutingQueryPort } from "@frely/model-access/routing-runtime";
import type { Principal, ProviderAdapterResponse } from "./index.js";
import type { AsyncGatewayPolicyGuards } from "./async-services.js";

export interface GatewayModelQueries extends Pick<GatewayQueries,
  "listEffectiveUserModelPlanSourceModels" | "pageOrderedPlanSourcesForUser"
> {}

/**
 * Read-only Gateway entry points use the same Promise-based repository shape as
 * the PostgreSQL adapter. Keeping this service small isolates model discovery
 * from the provider and billing executor.
 */
export class AsyncGatewayModelService {
  constructor(
    readonly repo: GatewayModelQueries,
    readonly guards: AsyncGatewayPolicyGuards,
    readonly routingQueries: GatewayRoutingQueryPort,
  ) {}

  async listModels(principal: Pick<Principal, "apiKey" | "user" | "effectiveScopes" | "apiKeyPlanSourceRestriction">, signal?: AbortSignal): Promise<ProviderAdapterResponse> {
    const seen = new Set<string>();
    const routingBudget = createGatewayRoutingBudget(signal);
    const effectiveScopes = new Set(principal.effectiveScopes ?? []);
    const data: Array<{
      id: string;
      object: "model";
      owned_by: string;
      access_point: { id: string; name: string; apiFamily: string };
    }> = [];
    const models = await this.repo.listEffectiveUserModelPlanSourceModels(principal.user.id, principal.apiKeyPlanSourceRestriction);
    for (const model of models) {
      if (seen.has(model)) continue;
      let cursor: Parameters<GatewayQueries["pageOrderedPlanSourcesForUser"]>[2] = null;
      sourcePages: do {
        const page = await this.repo.pageOrderedPlanSourcesForUser(principal.user.id, model, cursor, undefined, principal.apiKeyPlanSourceRestriction);
        for (const source of page.items) {
          if (!source.subscription || !source.accessPoint || !effectiveScopes.has(source.order.subscriptionScopeRef as ScopeRef)) continue;
          if (source.configurationError) break sourcePages;
          try {
            await this.guards.assertPartnerAccessActiveForScope(source.order.subscriptionScopeRef as ScopeRef);
            const snapshot = await this.routingQueries.evaluateGatewayRouting({
              entryAccessPointId: source.accessPoint.id,
              requestedModel: model,
              budget: routingBudget,
            });
            if (snapshot.outcome !== "available") break sourcePages;
            const accessPointScopes = [...new Set(snapshot.scopeReferences.accessPoints.map((accessPoint) => accessPoint.scopeRef as ScopeRef))];
            await this.guards.assertPartnerAccessActiveForScopes(accessPointScopes, snapshot.evaluatedAt);
            const providers = snapshot.scopeReferences.providers.map((provider) => ({ id: provider.id, scopeRef: provider.scopeRef as ScopeRef }));
            await this.guards.assertProviderAccessActiveForProviders(providers, snapshot.evaluatedAt);
            seen.add(model);
            data.push({
              id: model,
              object: "model",
              owned_by: source.order.subscriptionScopeRef,
              access_point: {
                id: source.accessPoint.id,
                name: source.accessPoint.name,
                apiFamily: source.accessPoint.apiFamily,
              },
            });
            break sourcePages;
          } catch (error) {
            if (error instanceof RelayError && (error.code === "graph_compilation_capacity_exceeded" || error.code === "request_aborted")) throw error;
            // Model discovery is best-effort but follows invocation ordering:
            // the first source inside the principal's scopes owns the outcome.
            break sourcePages;
          }
        }
        cursor = page.nextCursor;
      } while (cursor);
    }
    return {
      status: 200,
      body: { object: "list", data },
      gatewaySummary: { providerKind: null, accessPointId: null, billingSubscriptionId: null, usageSource: null, errorCode: null, captureErrorCode: null },
    };
  }
}
