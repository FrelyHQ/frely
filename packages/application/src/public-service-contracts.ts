import type { AuthorityCommands, AuthorityQueries } from "@frely/authority/server";
import type { IdentityCommands, IdentityQueries } from "@frely/identity/server";
import type { TenancyCommands, TenancyQueries } from "@frely/tenancy-context/server";
import type {
  AuthorityProductTerms,
  BillingCommerceCommands,
  BillingCommerceQueries,
  PlanAccessPointPriceOverride,
} from "@frely/billing/server";
import type {
  CreatePlanDefinitionCommand,
  EntitlementCommands,
  EntitlementQueries,
  RevisePlanDefinitionCommand,
  ReviseSubscriptionCompatibilityCommand,
} from "@frely/entitlement/server";
import type { ScopeRef } from "@frely/core";
import type { CreateAccessPointCommand, ModelAccessAuditInput } from "@frely/model-access/server";
import type { AsyncControlPlaneTenancyService, AsyncGatewayTenancyService } from "./identity-tenancy.js";
import type { ApplicationCommands } from "./storage/application-capabilities.js";

export interface IdentityTenancyApplicationService extends AsyncControlPlaneTenancyService {
  readonly identity: IdentityQueries;
  readonly identityCommands: IdentityCommands;
  readonly authority: AuthorityQueries;
  readonly tenancy: TenancyQueries;
  readonly tenancyCommands: TenancyCommands;
  transferTeamOwnership(input: { teamId: string; nextOwnerUserId: string; actorUserId: string; requestId?: string | null }): Promise<any>;
}

export interface GatewayIdentityApplicationService extends AsyncGatewayTenancyService {
  readonly identity: IdentityQueries;
  readonly authority: AuthorityQueries;
  readonly tenancy: TenancyQueries;
}

export interface BillingCommerceApplicationService {
  useCard: ApplicationCommands["useCard"];
  purchasePlanCard: ApplicationCommands["purchasePlanCard"];
  createPlanPurchaseOrder: ApplicationCommands["createPlanPurchaseOrder"];
  completeStripePlanPurchaseOrder: ApplicationCommands["completeStripePlanPurchaseOrder"];
  reversePlanPurchaseOrder: ApplicationCommands["reversePlanPurchaseOrder"];
  approveCreditTopup: ApplicationCommands["approveCreditTopup"];
  completeStripeCreditTopup: ApplicationCommands["completeStripeCreditTopup"];
  reverseCreditTopup: ApplicationCommands["reverseCreditTopup"];
  retryServiceOrderFulfillment: ApplicationCommands["retryServiceOrderFulfillment"];
  consumePartnerTeamCreationAllocation: ApplicationCommands["consumePartnerTeamCreationAllocation"];
}

export {
  AsyncControlPlaneTenancyService,
  AsyncGatewayTenancyService,
  type AsyncControlPlaneTenancyCommands,
  type AsyncControlPlaneTenancyQueries,
  type AsyncGatewayTenancyQueries,
} from "./identity-tenancy.js";
export {
  ownerUser,
  publicUser,
  type ApiKeyPrincipal,
  type AuthSession,
  type OwnerUser,
  type PublicPasskeyCredential,
  type PublicUser,
} from "./session.js";

export interface AuthorityEntitlementApplicationService {
  readonly authority: AuthorityQueries;
  readonly authorityCommands: AuthorityCommands;
  readonly entitlement: EntitlementQueries;
  readonly entitlementCommands: EntitlementCommands;
  readonly commerce: BillingCommerceQueries;
  readonly commerceCommands: BillingCommerceCommands;

  purchaseTeamCreationProduct(input: { buyerUserId: string; productId: string; idempotencyKey: string; requestId?: string | null }): Promise<any>;
  purchaseTeamProviderProduct(input: { buyerUserId: string; productId: string; teamId: string; idempotencyKey: string; requestId?: string | null }): Promise<any>;
  purchasePersonalProviderSlot(input: { buyerUserId: string; productId: string; idempotencyKey: string; requestId?: string | null }): Promise<any>;
  renewPersonalProviderSlot(input: { buyerUserId: string; slotId: string; productId: string; idempotencyKey: string; requestId?: string | null }): Promise<any>;
  createPersonalProvider(input: { slotId: string; userId: string; name: string; requestId?: string | null }): Promise<any>;
  changePersonalProviderModel(input: { slotId: string; userId: string; providerId: string; providerModelName: string; displayName?: string; status?: "enabled" | "disabled"; requestId?: string | null }): Promise<any>;
  createPersonalAccessPoint(input: { slotId: string; userId: string; command: Omit<CreateAccessPointCommand, "ownerId" | "scopeRef">; requestId?: string | null }): Promise<any>;
  createTeamAccessPoint(input: { teamId: string; actorUserId: string; command: CreateAccessPointCommand; audit: ModelAccessAuditInput }): Promise<any>;
  changePersonalAccessPointStatus(input: { slotId: string; userId: string; accessPointId: string; status: "enabled" | "disabled"; requestId?: string | null }): Promise<any>;
  removePersonalAccessPoint(input: { slotId: string; userId: string; accessPointId: string; requestId?: string | null }): Promise<any>;
  finalizePersonalProviderSlotRetention(input: { slotId: string; at?: string; initiatedBy?: string | null; requestId?: string | null }): Promise<any>;
  createTeamByConsumingAuthority(input: { beneficiaryUserId: string; name: string; idempotencyKey: string; requestId?: string | null }): Promise<any>;
  refundUnusedAuthorityGrant(input: { grantId: string; actorOwnerUserId: string; reasonCode: string; idempotencyKey: string; requestId?: string | null }): Promise<any>;
  handoverPlatformOwner(input: { currentOwnerUserId: string; nextOwnerUserId: string; actorUserId: string }): Promise<any>;
  grantTeamProviderEntitlement(input: { teamId: string; productId: string; actorOwnerUserId: string; idempotencyKey: string; requestId?: string | null }): Promise<any>;
  createAuthorityProductVersion(input: AuthorityProductTerms & { code: string; actorOwnerUserId: string; requestId?: string | null }): Promise<any>;
  updateDraftAuthorityProduct(productId: string, input: AuthorityProductTerms & { actorOwnerUserId: string; requestId?: string | null }): Promise<any>;
  listAuthorityProductVersion(productId: string, actorOwnerUserId: string, requestId?: string | null): any;
  closeAuthorityProduct(productId: string, actorOwnerUserId: string, requestId?: string | null): any;
  createPlanDefinition(input: Omit<CreatePlanDefinitionCommand, "financialTerms"> & { billingMode: unknown; purchaseAmount: unknown; accessPointPriceOverrides?: readonly PlanAccessPointPriceOverride[] }): Promise<any>;
  revisePlanDefinition(planId: string, input: Omit<RevisePlanDefinitionCommand, "financialTerms" | "hasHistoricalReferences" | "hasOutstandingEntitlements"> & { billingMode?: unknown; purchaseAmount?: unknown; accessPointPriceOverrides?: readonly PlanAccessPointPriceOverride[] }): Promise<any>;
  retirePlanDefinition(planId: string, input: { actorUserId: string; requestId?: string | null }): Promise<any>;
  createPlanSubscription(input: Parameters<EntitlementCommands["createSubscription"]>[0]): Promise<any>;
  cancelPlanSubscription(subscriptionId: string, input: { actorUserId: string; effectiveEnd?: string; requestId?: string | null }): Promise<any>;
  revisePlanSubscriptionCompatibility(subscriptionId: string, input: ReviseSubscriptionCompatibilityCommand): Promise<any>;
  deletePlanSubscriptionCompatibility(subscriptionId: string, input: { actorUserId: string; requestId?: string | null }): Promise<any>;
  replaceApiKeyPlanSourceRestriction(input: {
    apiKeyId: string;
    actorUserId: string;
    mode: "all" | "restricted";
    sourceKeys?: readonly import("@frely/entitlement").PlanSourceKey[];
    teamScopeRefs?: readonly ScopeRef[];
    auditSource: "web" | "owner";
    requestId?: string | null;
  }): Promise<import("@frely/entitlement").ApiKeyPlanSourceRestrictionDecision>;
  createPlanSubscriptionUnits(input: {
    planId: string;
    scopeRef: ScopeRef;
    units: number;
    source: string;
    purchasedByUserId: string | null;
    paymentMode: "admin_grant" | "charge_account";
    paymentAccountId: string | null;
    priority?: number;
    effectiveStart?: string;
    actorUserId: string;
    requestId?: string | null;
  }): Promise<any>;
}
