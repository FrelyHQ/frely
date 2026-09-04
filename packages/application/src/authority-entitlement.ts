import { bindAuditCommands, PrismaAuditEventAppender, type AuditEventAppender } from "@frely/audit/application-internal";
import { authorityOperationHash, authorityRequestHash, type AuthorityCommands, type AuthorityQueries } from "@frely/authority/server";
import { bindAuthorityContext, createAuthorityContext } from "@frely/authority/application-internal";
import type { BillingCommerceCommands, BillingCommerceQueries, AuthorityProductTerms, PlanAccessPointPriceOverride } from "@frely/billing/server";
import { bindBillingCommerceContext, createBillingCommerceContext } from "@frely/billing/application-internal";
import { createId, isRuntimeScopeRef, parseScopeRef, RelayError, type ScopeRef } from "@frely/core";
import { apiKeyPlanSourceRestrictionWritesEnabled, type AccessPointAllowanceDecision, type EntitlementCommands, type EntitlementQueries, type CreatePlanDefinitionCommand, type PlanSourceKey, type RevisePlanDefinitionCommand, type ReviseSubscriptionCompatibilityCommand } from "@frely/entitlement/server";
import { bindEntitlementContext, createEntitlementContext } from "@frely/entitlement/application-internal";
import type { IdentityQueries } from "@frely/identity/server";
import { bindIdentityContext } from "@frely/identity/application-internal";
import { bindPersonalProviderModelAccessParticipant, type AccessPointCreationAdmission, type BoundPersonalProviderModelAccessParticipant } from "@frely/model-access/application-internal";
import type { CreateAccessPointCommand, ModelAccessAuditInput } from "@frely/model-access/server";
import { Prisma, type PrismaTransactionOwner } from "@frely/postgres/server";
import type { TenancyCommands, TenancyQueries } from "@frely/tenancy-context/server";
import { bindTenancyContext } from "@frely/tenancy-context/application-internal";

type PrismaApplicationOwner = PrismaTransactionOwner & { prisma: Prisma.TransactionClient };

/**
 * [L6] Explicit MODERNIZATION-03 application coordinator.
 *
 * It owns only the enumerated same-database use cases. Context participants
 * receive the same Prisma transaction and never begin or commit a nested one.
 * Each named use case fixes its principal/scope, funding, Context aggregate,
 * target, and Audit lock order; participants never reorder or nest it.
 * Provider/Stripe/Email I/O is forbidden here.
 */
export class AuthorityEntitlementApplicationService {
  readonly authority: AuthorityQueries;
  readonly authorityCommands: AuthorityCommands;
  readonly entitlement: EntitlementQueries;
  readonly entitlementCommands: EntitlementCommands;
  readonly commerce: BillingCommerceQueries;
  readonly commerceCommands: BillingCommerceCommands;
  private readonly transactionRunner: AuthorityEntitlementTransactionRunner;

  constructor(owner: PrismaApplicationOwner, private readonly auditAppender: AuditEventAppender = new PrismaAuditEventAppender()) {
    const authority = createAuthorityContext(owner, auditAppender);
    const entitlement = createEntitlementContext(owner, auditAppender);
    const commerce = createBillingCommerceContext(owner, auditAppender);
    this.transactionRunner = new AuthorityEntitlementTransactionRunner(owner, auditAppender);
    this.authority = authority.queries as AuthorityQueries;
    this.authorityCommands = authority.commands as AuthorityCommands;
    this.entitlement = entitlement.queries as EntitlementQueries;
    this.entitlementCommands = entitlement.commands as EntitlementCommands;
    this.commerce = commerce.queries as BillingCommerceQueries;
    this.commerceCommands = commerce.commands as BillingCommerceCommands;
  }

  async replaceApiKeyPlanSourceRestriction(input: {
    apiKeyId: string;
    actorUserId: string;
    mode: "all" | "restricted";
    sourceKeys?: readonly PlanSourceKey[];
    teamScopeRefs?: readonly ScopeRef[];
    auditSource: "web" | "owner";
    requestId?: string | null;
  }) {
    return this.transactionRunner.run(async (contexts) => {
      const apiKey = await contexts.identity.getApiKey(input.apiKeyId);
      if (!apiKey) throw new RelayError("api_key_not_found", "API key not found", 404);
      await contexts.locks.lockUsers([apiKey.userId]);
      const lockedApiKey = await contexts.identity.getApiKey(input.apiKeyId);
      if (!lockedApiKey) throw new RelayError("api_key_not_found", "API key not found", 404);
      const isPlatformOwner = (await contexts.authority.platformRolesForUser(input.actorUserId)).includes("owner");
      if (lockedApiKey.userId !== input.actorUserId && !isPlatformOwner) {
        throw new RelayError("api_key_plan_source_restriction_forbidden", "Only the API key owner or a Platform Owner can manage this policy", 403);
      }
      if (input.mode === "restricted" && !apiKeyPlanSourceRestrictionWritesEnabled()) {
        throw new RelayError("api_key_plan_source_restriction_write_disabled", "API key Plan source restriction writes are not enabled", 409);
      }
      return contexts.entitlementCommands.replaceApiKeyPlanSourceRestriction({
        apiKeyId: lockedApiKey.id,
        ownerUserId: lockedApiKey.userId,
        mode: input.mode,
        sourceKeys: input.sourceKeys ?? [],
        teamScopeRefs: input.teamScopeRefs ?? [],
        actor: { actorType: "user", actorId: input.actorUserId },
        auditSource: input.auditSource,
        requestId: input.requestId ?? null,
      });
    }, 3, { isolationLevel: "Serializable" });
  }

  async purchaseTeamCreationProduct(input: { buyerUserId: string; productId: string; idempotencyKey: string; requestId?: string | null }) {
    return this.transactionRunner.run(async (contexts) => {
      const replay = await contexts.commerce.findAuthorityPurchaseReplay({ buyerUserId: input.buyerUserId, idempotencyKey: input.idempotencyKey, requestShape: { productId: input.productId } });
      if (replay) {
        const grant = await contexts.authority.getGrantForPurchase(replay.id);
        if (!grant) throw new RelayError("authority_purchase_corrupt", "Authority Purchase Grant is missing", 500);
        const quota = await contexts.authority.getQuota(grant.id);
        if (!quota) throw new RelayError("authority_purchase_corrupt", "Authority Purchase quota is missing", 500);
        return { purchase: replay, grant, quota, replayed: true };
      }
      await contexts.locks.lockEnabledUser(input.buyerUserId);
      const product = await contexts.commerce.getAuthorityProduct(input.productId);
      const availableUnits = await contexts.authority.countAvailableTeamCreationUnits(input.buyerUserId, product?.code);
      const financial = await contexts.commerceCommands.purchaseAuthorityProductFinancialFacts({
        buyerUserId: input.buyerUserId,
        productId: input.productId,
        idempotencyKey: input.idempotencyKey,
        requestShape: { productId: input.productId },
        expectedEffectCode: "team_create_unit",
        authorityUnconsumedUnits: availableUnits,
        requestId: input.requestId ?? null,
      });
      const purchase = financial.purchase;
      const granted = await contexts.authorityCommands.createPurchasedGrant({
        beneficiaryUserId: purchase.buyerUserId,
        purchaseId: purchase.id,
        productCode: purchase.productCode,
        productVersion: purchase.productVersion,
        issuedByUserId: product?.createdByOwnerUserId ?? purchase.buyerUserId,
        grantedUnits: purchase.grantUnits,
        effectiveStart: purchase.createdAt,
        effectiveEnd: addSeconds(purchase.createdAt, purchase.grantDurationSeconds),
        maxCurrentOwnedTeams: purchase.maxCurrentOwnedTeams,
        maxLifetimeCreatedTeams: purchase.maxLifetimeCreatedTeams,
      });
      return { purchase, grant: granted.grant, quota: granted.quota, replayed: financial.replayed };
    }, 3, { isolationLevel: "Serializable" });
  }

  async purchaseTeamProviderProduct(input: { buyerUserId: string; productId: string; teamId: string; idempotencyKey: string; requestId?: string | null }) {
    return this.transactionRunner.run(async (contexts) => {
      const replay = await contexts.commerce.findAuthorityPurchaseReplay({
        buyerUserId: input.buyerUserId,
        idempotencyKey: input.idempotencyKey,
        requestShape: { productId: input.productId, teamId: input.teamId },
      });
      if (replay) {
        const entitlement = await contexts.entitlement.getTeamProviderEntitlementForPurchase(replay.id);
        if (!entitlement) throw new RelayError("authority_purchase_corrupt", "Authority Purchase Team Provider entitlement is missing", 500);
        return { purchase: replay, entitlement, replayed: true };
      }
      await contexts.locks.lockEnabledUser(input.buyerUserId);
      await contexts.locks.lockTeam(input.teamId);
      const [team, membership] = await Promise.all([
        contexts.tenancy.getTeam(input.teamId),
        contexts.tenancy.getMembership(input.teamId, input.buyerUserId),
      ]);
      if (!team || team.status !== "enabled") throw new RelayError("team_not_found", "Enabled Team not found", 404);
      const roles = membership ? parseRoles(membership.rolesJson) : [];
      if (team.ownerId !== input.buyerUserId && !roles.includes("billing")) throw new RelayError("team_provider_purchase_forbidden", "Team Owner or Billing membership is required", 403);
      if ((await contexts.entitlement.getTeamProviderAccessState(input.teamId)).state === "permanent") throw new RelayError("team_provider_entitlement_permanent", "Team already has permanent Provider access", 409);
      const financial = await contexts.commerceCommands.purchaseAuthorityProductFinancialFacts({
        buyerUserId: input.buyerUserId,
        productId: input.productId,
        idempotencyKey: input.idempotencyKey,
        requestShape: { productId: input.productId, teamId: input.teamId },
        expectedEffectCode: "team_custom_provider_access",
        authorityUnconsumedUnits: 0,
        requestId: input.requestId ?? null,
      });
      const purchase = financial.purchase;
      const entitled = await contexts.entitlementCommands.createPurchasedTeamProviderEntitlement({
        teamId: input.teamId,
        purchaseId: purchase.id,
        productId: purchase.productId,
        productCode: purchase.productCode,
        productVersion: purchase.productVersion,
        productDisplayName: purchase.productDisplayName,
        buyerUserId: input.buyerUserId,
        durationSeconds: purchase.grantDurationSeconds,
        effectiveAt: purchase.createdAt,
        purchaseAmountUnits: purchase.purchaseAmountUnits,
        requestId: input.requestId ?? null,
      });
      return { purchase, entitlement: entitled.entitlement, replayed: financial.replayed };
    }, 3, { isolationLevel: "Serializable" });
  }

  async purchasePersonalProviderSlot(input: { buyerUserId: string; productId: string; idempotencyKey: string; requestId?: string | null }) {
    return this.transactionRunner.run(async (contexts) => {
      const requestShape = { productId: input.productId, fulfillment: "new_personal_provider_slot" };
      const replay = await contexts.commerce.findAuthorityPurchaseReplay({ buyerUserId: input.buyerUserId, idempotencyKey: input.idempotencyKey, requestShape });
      if (replay) {
        const period = await contexts.entitlement.getPersonalProviderEntitlementPeriodForPurchase(replay.id);
        if (!period) throw new RelayError("authority_purchase_corrupt", "Authority Purchase personal Provider entitlement is missing", 500);
        const slot = await contexts.entitlement.getPersonalProviderSlot(period.providerSlotId);
        if (!slot) throw new RelayError("authority_purchase_corrupt", "Authority Purchase personal Provider slot is missing", 500);
        return { purchase: replay, slot, period, replayed: true };
      }
      await contexts.locks.lockEnabledUser(input.buyerUserId);
      const financial = await contexts.commerceCommands.purchaseAuthorityProductFinancialFacts({
        buyerUserId: input.buyerUserId, productId: input.productId, idempotencyKey: input.idempotencyKey,
        requestShape, expectedEffectCode: "user_custom_provider_access", authorityUnconsumedUnits: 0, requestId: input.requestId ?? null,
      });
      const purchase = financial.purchase;
      const fulfilled = await contexts.entitlementCommands.createPurchasedPersonalProviderSlotFulfillment({
        purchaseId: purchase.id, productId: purchase.productId, productCode: purchase.productCode,
        productVersion: purchase.productVersion, productDisplayName: purchase.productDisplayName,
        buyerUserId: purchase.buyerUserId, durationSeconds: purchase.grantDurationSeconds,
        purchaseAmountUnits: purchase.purchaseAmountUnits, fulfilledAt: purchase.createdAt, requestId: input.requestId ?? null,
      });
      return { purchase, ...fulfilled, replayed: financial.replayed || fulfilled.replayed };
    }, 3, { isolationLevel: "Serializable" });
  }

  async renewPersonalProviderSlot(input: { buyerUserId: string; slotId: string; productId: string; idempotencyKey: string; requestId?: string | null }) {
    return this.transactionRunner.run(async (contexts) => {
      const requestShape = { productId: input.productId, slotId: input.slotId, fulfillment: "renew_personal_provider_slot" };
      const replay = await contexts.commerce.findAuthorityPurchaseReplay({ buyerUserId: input.buyerUserId, idempotencyKey: input.idempotencyKey, requestShape });
      if (replay) {
        const period = await contexts.entitlement.getPersonalProviderEntitlementPeriodForPurchase(replay.id);
        if (!period || period.providerSlotId !== input.slotId) throw new RelayError("authority_purchase_corrupt", "Authority Purchase personal Provider renewal is missing", 500);
        const slot = await contexts.entitlement.getPersonalProviderSlot(input.slotId);
        if (!slot) throw new RelayError("authority_purchase_corrupt", "Authority Purchase personal Provider slot is missing", 500);
        return { purchase: replay, slot, period, replayed: true };
      }
      await contexts.locks.lockEnabledUser(input.buyerUserId);
      const admittedAt = await contexts.entitlement.currentDatabaseTime();
      await contexts.entitlementCommands.lockPersonalProviderSlotForRenewal(input.slotId, input.buyerUserId, admittedAt);
      const financial = await contexts.commerceCommands.purchaseAuthorityProductFinancialFacts({
        buyerUserId: input.buyerUserId, productId: input.productId, idempotencyKey: input.idempotencyKey,
        requestShape, expectedEffectCode: "user_custom_provider_access", authorityUnconsumedUnits: 0, requestId: input.requestId ?? null,
      });
      const purchase = financial.purchase;
      const fulfilledAt = await contexts.entitlement.currentDatabaseTime();
      const fulfilled = await contexts.entitlementCommands.renewPurchasedPersonalProviderSlotFulfillment({
        slotId: input.slotId, purchaseId: purchase.id, productId: purchase.productId, productCode: purchase.productCode,
        productVersion: purchase.productVersion, productDisplayName: purchase.productDisplayName,
        buyerUserId: purchase.buyerUserId, durationSeconds: purchase.grantDurationSeconds,
        purchaseAmountUnits: purchase.purchaseAmountUnits, renewalAdmittedAt: admittedAt,
        fulfilledAt, requestId: input.requestId ?? null,
      });
      return { purchase, ...fulfilled, replayed: financial.replayed || fulfilled.replayed };
    }, 3, { isolationLevel: "Serializable" });
  }

  async createTeamByConsumingAuthority(input: { beneficiaryUserId: string; name: string; idempotencyKey: string; requestId?: string | null }) {
    const name = requiredName(input.name);
    const idempotencyKeyHash = authorityOperationHash(input.idempotencyKey);
    const requestHash = authorityRequestHash({ name });
    return this.transactionRunner.run(async (contexts) => {
      const prior = await contexts.authority.getUseForOperation(input.beneficiaryUserId, "team.create", idempotencyKeyHash);
      if (prior) {
        if (prior.requestHash !== requestHash) throw new RelayError("authority_idempotency_conflict", "Idempotency key was already used with a different Team request", 409);
        const team = await contexts.tenancy.getTeam(prior.targetIdSnapshot);
        return { use: prior, targetStatus: team?.status === "enabled" && team.ownerId === input.beneficiaryUserId ? "active" as const : "unavailable" as const, replayed: true };
      }
      await contexts.locks.lockEnabledUser(input.beneficiaryUserId);
      const user = await contexts.identity.decideUserAccess(input.beneficiaryUserId);
      if (!user?.enabled) throw new RelayError("user_not_found", "Enabled user not found", 404);
      const currentOwnedTeams = await contexts.tenancy.countCurrentOwnedTeams(input.beneficiaryUserId);
      const teamId = createId("team");
      const consumed = await contexts.authorityCommands.consumeTeamCreationUnit({
        beneficiaryUserId: input.beneficiaryUserId,
        targetTeamId: teamId,
        idempotencyKeyHash,
        requestHash,
        currentOwnedTeams,
        actorUserId: input.beneficiaryUserId,
        source: "web",
        requestId: input.requestId ?? null,
      });
      await contexts.tenancyCommands.createTeamWithOwnerMembership({ id: teamId, ownerUserId: input.beneficiaryUserId, name });
      await contexts.audit.record({
        actor: { actorType: "user", actorId: input.beneficiaryUserId },
        action: "team.create",
        resourceType: "team",
        resourceId: teamId,
        result: "success",
        source: "web",
        requestId: input.requestId ?? null,
        metadata: { name, ownerId: input.beneficiaryUserId, status: "enabled" },
      });
      return { use: consumed.use, targetStatus: "active" as const, replayed: false };
    }, 3, { isolationLevel: "Serializable" });
  }

  async refundUnusedAuthorityGrant(input: { grantId: string; actorOwnerUserId: string; reasonCode: string; idempotencyKey: string; requestId?: string | null }) {
    return this.transactionRunner.run(async (contexts) => {
      const grant = await contexts.authority.getGrant(input.grantId);
      if (!grant?.sourcePurchaseId) throw new RelayError("authority_refund_not_allowed", "Authority Grant is not backed by a refundable Purchase", 409);
      const replay = await contexts.commerceCommands.findAuthorityRefundReplay({ purchaseId: grant.sourcePurchaseId, actorOwnerUserId: input.actorOwnerUserId, reasonCode: input.reasonCode, idempotencyKey: input.idempotencyKey });
      if (replay) return replay;
      // Keep the release/refund lock order stable before touching Authority.
      await contexts.commerceCommands.lockAuthorityRefundCandidate(grant.sourcePurchaseId);
      const serializedReplay = await contexts.commerceCommands.findAuthorityRefundReplay({ purchaseId: grant.sourcePurchaseId, actorOwnerUserId: input.actorOwnerUserId, reasonCode: input.reasonCode, idempotencyKey: input.idempotencyKey });
      if (serializedReplay) return serializedReplay;
      const canceled = await contexts.authorityCommands.cancelUnconsumedGrantForRefund({ grantId: grant.id, purchaseId: grant.sourcePurchaseId, actorOwnerUserId: input.actorOwnerUserId, requestId: input.requestId ?? null });
      return contexts.commerceCommands.refundAuthorityPurchaseFinancialFacts({ purchaseId: grant.sourcePurchaseId, grantId: canceled.id, actorOwnerUserId: input.actorOwnerUserId, reasonCode: input.reasonCode, idempotencyKey: input.idempotencyKey, grantWasUnconsumedAndCanceled: true, requestId: input.requestId ?? null });
    }, 3, { isolationLevel: "Serializable" });
  }

  async handoverPlatformOwner(input: { currentOwnerUserId: string; nextOwnerUserId: string; actorUserId: string }) {
    return this.transactionRunner.run(async (contexts) => {
      const userIds = [input.currentOwnerUserId, input.nextOwnerUserId].sort();
      await contexts.locks.lockUsers(userIds);
      const [current, next] = await Promise.all([contexts.identity.decideUserAccess(input.currentOwnerUserId), contexts.identity.decideUserAccess(input.nextOwnerUserId)]);
      if (!current?.enabled || !next?.enabled) throw new RelayError("platform_owner_handover_target_invalid", "Platform Owner handover requires enabled users", 409);
      return contexts.authorityCommands.handoverBootstrapOwner(input);
    }, 1, { isolationLevel: "Serializable" });
  }

  async grantTeamProviderEntitlement(input: { teamId: string; productId: string; actorOwnerUserId: string; idempotencyKey: string; requestId?: string | null }) {
    return this.transactionRunner.run(async (contexts) => {
      await contexts.locks.lockTeam(input.teamId);
      const product = await contexts.commerceCommands.lockTeamProviderGrantProduct(input.productId);
      return contexts.entitlementCommands.grantTeamProviderEntitlement({
        teamId: input.teamId,
        product: { id: product.id, code: product.code, version: product.version, displayName: product.displayName, durationSeconds: product.grantDurationSeconds },
        actorOwnerUserId: input.actorOwnerUserId,
        idempotencyKey: input.idempotencyKey,
        requestId: input.requestId ?? null,
      });
    }, 3, { isolationLevel: "Serializable" });
  }

  async createAuthorityProductVersion(input: AuthorityProductTerms & { code: string; actorOwnerUserId: string; requestId?: string | null }) {
    return this.transactionRunner.run(async (contexts) => {
      await this.assertEconomicScope(contexts, input.sellerScopeRef);
      return contexts.commerceCommands.createAuthorityProductVersion(input);
    }, 3, { isolationLevel: "Serializable" });
  }

  async updateDraftAuthorityProduct(productId: string, input: AuthorityProductTerms & { actorOwnerUserId: string; requestId?: string | null }) {
    return this.transactionRunner.run(async (contexts) => {
      await this.assertEconomicScope(contexts, input.sellerScopeRef);
      return contexts.commerceCommands.updateDraftAuthorityProduct(productId, input);
    }, 3, { isolationLevel: "Serializable" });
  }
  listAuthorityProductVersion(productId: string, actorOwnerUserId: string, requestId?: string | null) { return this.commerceCommands.listAuthorityProductVersion(productId, actorOwnerUserId, requestId); }
  closeAuthorityProduct(productId: string, actorOwnerUserId: string, requestId?: string | null) { return this.commerceCommands.closeAuthorityProduct(productId, actorOwnerUserId, requestId); }

  async createPersonalProvider(input: { slotId: string; userId: string; name: string; requestId?: string | null }) {
    return this.transactionRunner.run(async (contexts) => {
      const slot = await contexts.entitlementCommands.requireActivePersonalProviderSlot(input.slotId, input.userId);
      if (slot.providerId) {
        const provider = await contexts.modelAccess.getPersonalProvider(slot.providerId, input.userId);
        if (provider.name !== input.name.trim()) throw new RelayError("personal_provider_create_conflict", "This slot already has a Provider with a different name", 409);
        return { provider, slot, replayed: true };
      }
      const provider = await contexts.modelAccess.createPersonalProvider({ slotId: slot.id, userId: input.userId, name: input.name },
        { actor: { actorType: "user", actorId: input.userId }, source: "web", requestId: input.requestId ?? null });
      const bound = await contexts.entitlementCommands.bindPersonalProviderToSlot({ slotId: slot.id, userId: input.userId, providerId: provider.id });
      return { provider, slot: bound, replayed: false };
    }, 3, { isolationLevel: "Serializable" });
  }

  async changePersonalProviderModel(input: { slotId: string; userId: string; providerId: string; providerModelName: string; displayName?: string; status?: "enabled" | "disabled"; requestId?: string | null }) {
    return this.transactionRunner.run(async (contexts) => {
      const slot = await contexts.entitlementCommands.requireActivePersonalProviderSlot(input.slotId, input.userId);
      if (slot.providerId !== input.providerId) throw new RelayError("provider_slot_provider_mismatch", "Provider does not belong to the selected slot", 403);
      const model = await contexts.modelAccess.changePersonalProviderModel({
        providerId: input.providerId,
        providerModelName: input.providerModelName,
        ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
        ...(input.status === undefined ? {} : { status: input.status }),
      }, { actor: { actorType: "user", actorId: input.userId }, source: "web", requestId: input.requestId ?? null });
      if (model.status === "enabled") await contexts.commerceCommands.ensurePersonalProviderModelZeroCost({ providerId: model.providerId, providerModelName: model.providerModelName, actorUserId: input.userId, requestId: input.requestId ?? null });
      return model;
    }, 3, { isolationLevel: "Serializable" });
  }

  async createPersonalAccessPoint(input: {
    slotId: string; userId: string; command: Omit<CreateAccessPointCommand, "ownerId" | "scopeRef">; requestId?: string | null;
  }) {
    return this.transactionRunner.run(async (contexts) => {
      const slot = await contexts.entitlementCommands.requireActivePersonalProviderSlot(input.slotId, input.userId);
      const admission: AccessPointCreationAdmission = async (admissionInput) => {
        const allowance = await contexts.entitlement.decideAccessPointAllowance(admissionInput.scopeRef);
        assertAccessPointAllowance(allowance);
        const usedAccessPoints = await admissionInput.countUnremovedAccessPoints();
        if (usedAccessPoints >= allowance.maxAccessPoints) {
          throw new RelayError("personal_access_point_limit_reached", "This Provider already has the maximum number of personal AccessPoints", 409, {
            maxAccessPoints: allowance.maxAccessPoints,
            usedAccessPoints,
          });
        }
      };
      const created = await contexts.modelAccess.createPersonalAccessPoint({
        id: slot.id, userId: slot.userId, providerId: slot.providerId, lifecycle: "active",
      }, input.command, { actor: { actorType: "user", actorId: input.userId }, source: "web", requestId: input.requestId ?? null }, admission);
      await contexts.entitlementCommands.includePersonalAccessPointInManagedPlan({ slotId: slot.id, accessPointId: created.id });
      const prices = await contexts.commerceCommands.configurePersonalAccessPointZeroPrice({ planId: slot.managedPlanId, accessPointId: created.id, actorUserId: input.userId, requestId: input.requestId ?? null });
      return { ...created, prices, slotId: slot.id, usedAccessPoints: (await contexts.entitlement.getPersonalProviderSlot(slot.id))!.usedAccessPoints };
    }, 3, { isolationLevel: "Serializable" });
  }

  async createTeamAccessPoint(input: {
    teamId: string; actorUserId: string; command: CreateAccessPointCommand; audit: ModelAccessAuditInput;
  }) {
    const scopeRef = `team:${input.teamId}` as ScopeRef;
    if (input.command.scopeRef !== scopeRef || input.command.ownerId !== input.actorUserId) {
      throw new RelayError("team_access_point_scope_mismatch", "Team AccessPoint scope and owner must match the authenticated Team actor", 403);
    }
    if (input.audit.actor.actorType !== "user" || input.audit.actor.actorId !== input.actorUserId) {
      throw new RelayError("team_access_point_actor_mismatch", "Team AccessPoint audit actor must match the authenticated Team actor", 403);
    }
    return this.transactionRunner.run(async (contexts) => {
      const admission: AccessPointCreationAdmission = async (admissionInput) => {
        const team = await contexts.tenancy.getTeam(input.teamId);
        if (!team || team.status !== "enabled") throw new RelayError("team_not_found", "Enabled Team not found", 404);
        const permission = await contexts.tenancy.decidePermission({
          userId: input.actorUserId,
          resourceType: "team",
          resourceId: input.teamId,
          action: "team.access_point.create",
          platformOwner: false,
        });
        if (!permission.allowed) throw new RelayError("team_access_point_create_forbidden", "Team AccessPoint permission is required", 403);
        if (!team.teamOwnerCanCreateAccessPoint) throw new RelayError("team_owner_access_point_create_forbidden", "Team owner cannot create AccessPoints", 403);
        const providerAccess = await contexts.entitlement.decideTeamProviderAccess(input.teamId);
        if (providerAccess.kind !== "allowed") {
          if (providerAccess.state === "not_entitled") {
            throw new RelayError("team_provider_entitlement_required", "Team Provider entitlement is required", 402);
          }
          throw new RelayError("team_provider_entitlement_expired", "Team Provider entitlement is expired or not yet active", 402, {
            state: providerAccess.state,
          });
        }
      };
      return contexts.modelAccess.createAccessPoint(input.command, input.audit, admission);
    }, 3, { isolationLevel: "Serializable" });
  }

  async changePersonalAccessPointStatus(input: { slotId: string; userId: string; accessPointId: string; status: "enabled" | "disabled"; requestId?: string | null }) {
    return this.transactionRunner.run(async (contexts) => {
      const slot = await contexts.entitlement.getPersonalProviderSlot(input.slotId);
      if (!slot || slot.userId !== input.userId || slot.lifecycle === "retention_expired") throw new RelayError("provider_slot_not_found", "Personal Provider slot not found", 404);
      const result = await contexts.modelAccess.changePersonalAccessPointStatus({
        slotId: slot.id,
        userId: input.userId,
        accessPointId: input.accessPointId,
        status: input.status,
        slotLifecycle: slot.lifecycle,
      }, { actor: { actorType: "user", actorId: input.userId }, source: "web", requestId: input.requestId ?? null });
      return { ...result, slotId: slot.id };
    }, 3, { isolationLevel: "Serializable" });
  }

  async removePersonalAccessPoint(input: { slotId: string; userId: string; accessPointId: string; requestId?: string | null }) {
    return this.transactionRunner.run(async (contexts) => {
      const slot = await contexts.entitlement.getPersonalProviderSlot(input.slotId);
      if (!slot || slot.userId !== input.userId || slot.lifecycle === "retention_expired") throw new RelayError("provider_slot_not_found", "Personal Provider slot not found", 404);
      await contexts.entitlementCommands.detachPersonalAccessPointFromManagedPlan({ slotId: slot.id, accessPointId: input.accessPointId });
      const removed = await contexts.modelAccess.removePersonalAccessPoint({ slotId: slot.id, userId: input.userId, accessPointId: input.accessPointId },
        { actor: { actorType: "user", actorId: input.userId }, source: "web", requestId: input.requestId ?? null });
      return { ...removed, slotId: slot.id, usedAccessPoints: (await contexts.entitlement.getPersonalProviderSlot(slot.id))!.usedAccessPoints };
    }, 3, { isolationLevel: "Serializable" });
  }

  finalizePersonalProviderSlotRetention(input: { slotId: string; at?: string; initiatedBy?: string | null; requestId?: string | null }) {
    return this.entitlementCommands.finalizePersonalProviderSlotRetention(input);
  }

  async createPlanDefinition(input: Omit<CreatePlanDefinitionCommand, "financialTerms"> & { billingMode: unknown; purchaseAmount: unknown; accessPointPriceOverrides?: readonly PlanAccessPointPriceOverride[] }) {
    return this.transactionRunner.run(async (contexts) => {
      const financialTerms = contexts.commerce.validatePlanFinancialTerms({ billingMode: input.billingMode, purchaseAmount: input.purchaseAmount });
      const plan = await contexts.entitlementCommands.createPlanDefinition({ ...input, financialTerms });
      if (input.accessPointPriceOverrides?.length) await contexts.commerceCommands.appendPlanAccessPointPriceOverrides(plan.id, input.accessPointPriceOverrides);
      return plan;
    }, 3, { isolationLevel: "Serializable" });
  }

  async revisePlanDefinition(planId: string, input: Omit<RevisePlanDefinitionCommand, "financialTerms" | "hasHistoricalReferences" | "hasOutstandingEntitlements"> & { billingMode?: unknown; purchaseAmount?: unknown; accessPointPriceOverrides?: readonly PlanAccessPointPriceOverride[] }) {
    return this.transactionRunner.run(async (contexts) => {
      const existing = await contexts.entitlement.getPlan(planId);
      if (!existing) throw new RelayError("plan_template_not_found", `Plan template ${planId} not found`, 404);
      const references = await contexts.commerce.getPlanCommerceReferenceFacts(planId);
      if (references.hasHistoricalReferences && (input.accessPointPriceOverrides?.length ?? 0) > 0) throw new RelayError("sold_plan_terms_immutable", "Sold Plan commercial terms require a new Plan version", 409);
      const financialTerms = input.billingMode === undefined && input.purchaseAmount === undefined ? undefined : contexts.commerce.validatePlanFinancialTerms({ billingMode: input.billingMode ?? existing.billingMode, purchaseAmount: input.purchaseAmount ?? existing.purchaseAmount });
      const plan = await contexts.entitlementCommands.revisePlanDefinition(planId, { ...input, ...(financialTerms === undefined ? {} : { financialTerms }), hasHistoricalReferences: references.hasHistoricalReferences, hasOutstandingEntitlements: references.hasOutstandingEntitlements });
      if (input.accessPointPriceOverrides?.length) await contexts.commerceCommands.appendPlanAccessPointPriceOverrides(plan.id, input.accessPointPriceOverrides);
      return { plan, references };
    }, 3, { isolationLevel: "Serializable" });
  }

  async retirePlanDefinition(planId: string, input: { actorUserId: string; requestId?: string | null }) {
    return this.transactionRunner.run(async (contexts) => {
      const references = await contexts.commerce.getPlanCommerceReferenceFacts(planId);
      return contexts.entitlementCommands.retireUnreferencedPlan(planId, { hasHistoricalReferences: references.hasHistoricalReferences, actorUserId: input.actorUserId, requestId: input.requestId ?? null });
    }, 3, { isolationLevel: "Serializable" });
  }

  async createPlanSubscription(input: Parameters<EntitlementCommands["createSubscription"]>[0]) { return this.entitlementCommands.createSubscription(input); }
  async cancelPlanSubscription(subscriptionId: string, input: { actorUserId: string; effectiveEnd?: string; requestId?: string | null }) { return this.entitlementCommands.cancelSubscription(subscriptionId, input); }
  async revisePlanSubscriptionCompatibility(subscriptionId: string, input: ReviseSubscriptionCompatibilityCommand) { return this.entitlementCommands.reviseSubscriptionCompatibility(subscriptionId, input); }
  async deletePlanSubscriptionCompatibility(subscriptionId: string, input: { actorUserId: string; requestId?: string | null }) { return this.entitlementCommands.deleteSubscriptionCompatibility(subscriptionId, input); }

  async createPlanSubscriptionUnits(input: {
    planId: string; scopeRef: ScopeRef; units: number; source: string; purchasedByUserId: string | null;
    paymentMode: "admin_grant" | "charge_account"; paymentAccountId: string | null; priority?: number; effectiveStart?: string;
    actorUserId: string; requestId?: string | null;
  }) {
    return this.transactionRunner.run(async (contexts) => {
      const funding = input.paymentMode === "charge_account"
        ? await contexts.commerceCommands.lockPlanSubscriptionPurchaseFunding({ accountId: input.paymentAccountId ?? "", planId: input.planId, unitCount: input.units, actorUserId: input.actorUserId })
        : null;
      const subscriptions = await contexts.entitlementCommands.createSubscriptionUnits({
        planId: input.planId, scopeRef: input.scopeRef, units: input.units, source: input.source,
        purchasedByUserId: input.purchasedByUserId, fundingAccountId: null,
        ...(input.priority === undefined ? {} : { priority: input.priority }),
        ...(input.effectiveStart === undefined ? {} : { effectiveStart: input.effectiveStart }),
        actor: { actorType: "user", actorId: input.actorUserId }, auditSource: "owner", requestId: input.requestId ?? null,
      });
      const ledgerEventIds = funding ? await contexts.commerceCommands.completePlanSubscriptionPurchaseFunding(funding, subscriptions) : [];
      return { subscriptions, ledgerEventIds };
    }, 3, { isolationLevel: "Serializable" });
  }

  private async assertEconomicScope(contexts: { identity: Pick<IdentityQueries, "decideUserAccess">; tenancy: Pick<TenancyQueries, "getTeam" | "isTeamAvailable"> }, scopeRef: ScopeRef): Promise<void> {
    if (!isRuntimeScopeRef(scopeRef)) throw new RelayError("authority_seller_scope_invalid", "Seller scope is invalid", 400);
    const scope = parseScopeRef(scopeRef);
    if (scope.scopeType === "global") return;
    if (scope.scopeType === "user") {
      if ((await contexts.identity.decideUserAccess(scope.scopeId))?.enabled) return;
    } else if (scope.scopeType === "team") {
      const team = await contexts.tenancy.getTeam(scope.scopeId);
      if (team?.status === "enabled" && await contexts.tenancy.isTeamAvailable(team.id)) return;
    }
    throw new RelayError("authority_seller_scope_not_found", "Seller scope does not resolve to an economic principal", 404);
  }

}

interface BoundAuthorityEntitlementParticipants {
  readonly identity: IdentityQueries;
  readonly tenancy: TenancyQueries;
  readonly tenancyCommands: TenancyCommands;
  readonly authority: AuthorityQueries;
  readonly authorityCommands: AuthorityCommands;
  readonly entitlement: EntitlementQueries;
  readonly entitlementCommands: EntitlementCommands;
  readonly commerce: BillingCommerceQueries;
  readonly commerceCommands: BillingCommerceCommands;
  readonly modelAccess: BoundPersonalProviderModelAccessParticipant;
  readonly audit: ReturnType<typeof bindAuditCommands>;
  readonly locks: {
    lockEnabledUser(userId: string): Promise<void>;
    lockTeam(teamId: string): Promise<void>;
    lockUsers(userIds: readonly string[]): Promise<void>;
  };
}

class AuthorityEntitlementTransactionRunner {
  constructor(private readonly owner: PrismaApplicationOwner, private readonly auditAppender: AuditEventAppender) {}

  run<T>(
    callback: (participants: BoundAuthorityEntitlementParticipants) => Promise<T>,
    maxAttempts = 3,
    options: { isolationLevel?: "ReadCommitted" | "Serializable" } = {},
  ): Promise<T> {
    return this.owner.withPrismaTransaction(
      (transaction) => callback(this.bind(transaction)),
      maxAttempts,
      options,
    );
  }

  private bind(transaction: Prisma.TransactionClient): BoundAuthorityEntitlementParticipants {
    const identity = bindIdentityContext(this.owner, transaction, this.auditAppender);
    const tenancy = bindTenancyContext(this.owner, transaction);
    const authority = bindAuthorityContext(this.owner, transaction, this.auditAppender);
    const entitlement = bindEntitlementContext(this.owner, transaction, this.auditAppender);
    const commerce = bindBillingCommerceContext(this.owner, transaction, this.auditAppender);
    return Object.freeze({
      identity: identity.queries as IdentityQueries,
      tenancy: tenancy.queries as TenancyQueries,
      tenancyCommands: tenancy.commands as TenancyCommands,
      authority: authority.queries as AuthorityQueries,
      authorityCommands: authority.commands as AuthorityCommands,
      entitlement: entitlement.queries as EntitlementQueries,
      entitlementCommands: entitlement.commands as EntitlementCommands,
      commerce: commerce.queries as BillingCommerceQueries,
      commerceCommands: commerce.commands as BillingCommerceCommands,
      modelAccess: bindPersonalProviderModelAccessParticipant(transaction, this.auditAppender),
      audit: bindAuditCommands(transaction, this.auditAppender),
      locks: Object.freeze({
        lockEnabledUser: async (userId: string) => {
          await transaction.$queryRaw`SELECT "id" FROM "user_controls" WHERE "id" = ${userId} FOR UPDATE`;
          if (!(await identity.queries.decideUserAccess(userId))?.enabled) {
            throw new RelayError("user_not_found", "Enabled user not found", 404);
          }
        },
        lockTeam: async (teamId: string) => {
          await transaction.$queryRaw`SELECT "id" FROM "teams" WHERE "id" = ${teamId} FOR UPDATE`;
        },
        lockUsers: async (userIds: readonly string[]) => {
          await transaction.$queryRaw`SELECT "id" FROM "user_controls" WHERE "id" IN (${Prisma.join([...userIds])}) ORDER BY "id" FOR UPDATE`;
        },
      }),
    });
  }
}

function requiredName(value: string): string { const name = value.trim(); if (!name || name.length > 120) throw new RelayError("authority_text_invalid", "name is required and must not exceed 120 characters", 400); return name; }
function addSeconds(value: string, seconds: number): string { return new Date(Date.parse(value) + seconds * 1_000).toISOString(); }
function parseRoles(value: string): string[] { try { const parsed = JSON.parse(value) as unknown; return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []; } catch { return []; } }

function assertAccessPointAllowance(allowance: AccessPointAllowanceDecision): asserts allowance is Extract<AccessPointAllowanceDecision, { kind: "allowed" }> {
  if (allowance.kind !== "allowed") {
    throw new RelayError("access_point_allowance_required", "A valid paid AccessPoint allowance is required", 403, { scopeRef: allowance.scopeRef });
  }
  if (!Number.isSafeInteger(allowance.maxAccessPoints) || allowance.maxAccessPoints < 1) {
    throw new RelayError("access_point_allowance_invalid", "The AccessPoint allowance is not enforceable", 503, { scopeRef: allowance.scopeRef });
  }
}
