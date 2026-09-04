import { createHash } from "node:crypto";
import { PrismaAuditEventAppender, type AuditEventAppender } from "@frely/audit/application-internal";
import { AUTHORITY_PRODUCT_LIMITS, AUTHORITY_REFUND_REASON_CODES, createId, isRuntimeScopeRef, nowIso, RelayError, type ScopeRef } from "@frely/core";
import type { Prisma, PrismaTransactionOwner } from "@frely/postgres/server";
import type {
  AuthorityProductEffectCode,
  AuthorityProductSnapshot,
  AuthorityProductTerms,
  AuthorityPurchaseSnapshot,
  AuthorityRefundSnapshot,
  BillingAuthorityPurchaseResult,
  BillingAuthorityRefundResult,
  BillingCommerceContextCommands,
  BillingCommerceContextQueries,
  BillingPageResult,
  PlanAccessPointPriceOverride,
  PlanAccessPointPriceTierInput,
  PlanCommerceReferenceFacts,
  PlanFinancialTermsDecision,
  PlanSubscriptionPurchaseFunding,
} from "./commerce-contracts.js";
export type * from "./commerce-contracts.js";

type BillingClient = Prisma.TransactionClient;
type RootBillingClient = PrismaTransactionOwner & { prisma: BillingClient };

abstract class BillingCommerceInfrastructure {
  constructor(protected readonly root: RootBillingClient, protected readonly transaction?: BillingClient) {}
  protected client(): BillingClient { return this.transaction ?? this.root.prisma; }
}

export class BillingCommerceQueries extends BillingCommerceInfrastructure implements BillingCommerceContextQueries {
  constructor(root: RootBillingClient, transaction?: BillingClient) {
    super(root, transaction);
  }

  async classifyIdentityMigrationUser(userId: string): Promise<{ unsafeReferenceCount: number }> {
    const userScopeRef = `user:${userId}`;
    const [accounts, transferPolicies, authorityProducts] = await Promise.all([
      this.client().credit_accounts.count({ where: { scope_ref: userScopeRef } }),
      this.client().credit_transfer_policies.count({ where: { scope_ref: userScopeRef } }),
      this.client().authority_products.count({ where: { seller_scope_ref: userScopeRef } }),
    ]);
    return Object.freeze({ unsafeReferenceCount: accounts + transferPolicies + authorityProducts });
  }

  async getAuthorityProduct(productId: string): Promise<AuthorityProductSnapshot | undefined> {
    const row = await this.client().authority_products.findUnique({ where: { id: productId } });
    return row ? productSnapshot(row) : undefined;
  }

  async findCurrentPersonalProviderProduct(): Promise<AuthorityProductSnapshot | undefined> {
    const row = await this.client().authority_products.findFirst({
      where: { lifecycle: "listed", effect_code: "user_custom_provider_access" },
      orderBy: [{ updated_at: "desc" }, { version: "desc" }, { id: "desc" }],
    });
    return row ? productSnapshot(row) : undefined;
  }

  async getAuthorityPurchase(purchaseId: string): Promise<AuthorityPurchaseSnapshot | undefined> {
    const row = await this.client().authority_purchases.findUnique({ where: { id: purchaseId } });
    return row ? purchaseSnapshot(row) : undefined;
  }

  async findAuthorityPurchaseReplay(input: { buyerUserId: string; idempotencyKey: string; requestShape: unknown }): Promise<AuthorityPurchaseSnapshot | undefined> {
    const idempotencyKeyHash = hashRequired(input.idempotencyKey, "Idempotency-Key");
    const requestHash = digest(input.requestShape);
    const row = await this.client().authority_purchases.findFirst({ where: { buyer_user_id: input.buyerUserId, idempotency_key_hash: idempotencyKeyHash } });
    if (!row) return undefined;
    if (row.request_hash !== requestHash) throw new RelayError("authority_idempotency_conflict", "Idempotency key was already used with a different Authority purchase", 409);
    return purchaseSnapshot(row);
  }

  async pageAuthorityProducts(page = 1, requestedPageSize = 20, purchasableOnly = false): Promise<BillingPageResult<AuthorityProductSnapshot>> {
    const pageSize = normalizePageSize(requestedPageSize);
    const where = purchasableOnly ? { lifecycle: "listed" } : {};
    const total = await this.client().authority_products.count({ where });
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const normalizedPage = Math.min(Math.max(1, Math.trunc(page)), totalPages);
    const rows = await this.client().authority_products.findMany({ where, orderBy: [{ code: "asc" }, { version: "desc" }, { id: "desc" }], take: pageSize, skip: (normalizedPage - 1) * pageSize });
    return { items: rows.map(productSnapshot), page: normalizedPage, pageSize, total, totalPages };
  }

  async searchTeamProviderProductCandidates(query = "", page = 1): Promise<BillingPageResult<{ id: string; code: string; version: number; displayName: string; grantDurationSeconds: number }>> {
    const pageSize = 20;
    const normalized = query.trim().toLowerCase().slice(0, 100);
    const where = { lifecycle: "listed", effect_code: "team_custom_provider_access", ...(normalized ? { OR: [{ code: { contains: normalized, mode: "insensitive" as const } }, { display_name: { contains: normalized, mode: "insensitive" as const } }] } : {}) };
    const total = await this.client().authority_products.count({ where });
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const normalizedPage = Math.min(Math.max(1, Math.trunc(page)), totalPages);
    const rows = await this.client().authority_products.findMany({ where, orderBy: [{ display_name: "asc" }, { code: "asc" }, { version: "desc" }, { id: "asc" }], take: pageSize, skip: (normalizedPage - 1) * pageSize });
    return { items: rows.map((row) => ({ id: row.id, code: row.code, version: row.version, displayName: row.display_name, grantDurationSeconds: row.grant_duration_seconds })), page: normalizedPage, pageSize, total, totalPages };
  }

  async getPlanCommerceReferenceFacts(planId: string, at = nowIso()): Promise<PlanCommerceReferenceFacts> {
    const [cards, activationBatches, orders, services, subscriptions, availablePhysicalCardCount, availableActivationCodeCount, activeOrFutureSubscriptionCount] = await Promise.all([
      this.client().cards.count({ where: { plan_id: planId } }),
      this.client().card_activation_batches.count({ where: { plan_id: planId } }),
      this.client().plan_purchase_orders.count({ where: { plan_id: planId } }),
      this.client().service_products.count({ where: { partner_plan_id: planId } }),
      this.client().plan_subscriptions.count({ where: { plan_id: planId } }),
      this.client().cards.count({ where: { plan_id: planId, used_at: null, invalidated_at: null, expires_at: { gt: at }, other_cards: null } }),
      this.client().card_activation_codes.count({ where: { redeemed_at: null, revoked_at: null, card_activation_batches: { plan_id: planId, revoked_at: null, redeem_expires_at: { gt: at } } } }),
      this.client().plan_subscriptions.count({ where: { plan_id: planId, subscription_lifecycle: "active", OR: [{ effective_end: null }, { effective_end: { gt: at } }] } }),
    ]);
    const availableCardCount = availablePhysicalCardCount + availableActivationCodeCount;
    return { hasHistoricalReferences: cards + activationBatches + orders + services + subscriptions > 0, hasOutstandingEntitlements: availableCardCount + activeOrFutureSubscriptionCount > 0, availableCardCount, activeOrFutureSubscriptionCount };
  }

  validatePlanFinancialTerms(input: { billingMode: unknown; purchaseAmount: unknown }): PlanFinancialTermsDecision {
    if (input.billingMode !== "prepaid" && input.billingMode !== "paygo") throw new RelayError("invalid_plan_billing_mode", "Plan billing mode must be prepaid or paygo", 400);
    const purchaseAmount = Number(input.purchaseAmount);
    if (!Number.isFinite(purchaseAmount) || purchaseAmount < 0) throw new RelayError("invalid_plan_purchase_amount", "Plan purchase amount must be finite and non-negative", 400);
    const purchaseAmountUnits = BigInt(Math.round(purchaseAmount * 1_000_000));
    if (purchaseAmountUnits > BigInt(Number.MAX_SAFE_INTEGER)) throw new RelayError("invalid_plan_purchase_amount", "Plan purchase amount is too large", 400);
    return Object.freeze({ billingMode: input.billingMode, purchaseAmount, purchaseAmountUnits });
  }
}

/** Billing/Commerce owns Product, Purchase, Refund and all money facts. */
export class BillingCommerceCommands extends BillingCommerceInfrastructure implements BillingCommerceContextCommands {
  constructor(root: RootBillingClient, transaction?: BillingClient, private readonly auditAppender: AuditEventAppender = new PrismaAuditEventAppender()) { super(root, transaction); }

  private run<T>(callback: (commands: BillingCommerceCommands) => Promise<T>, maxAttempts = 3, isolationLevel: "ReadCommitted" | "Serializable" = "ReadCommitted"): Promise<T> {
    if (this.transaction) return callback(this);
    return this.root.withPrismaTransaction(
      (transaction) => callback(new BillingCommerceCommands(this.root, transaction, this.auditAppender)),
      maxAttempts,
      { isolationLevel },
    );
  }

  async lockTeamProviderGrantProduct(productId: string): Promise<AuthorityProductSnapshot> {
    return this.run(async (commands) => {
      await commands.client().$queryRaw`SELECT "id" FROM "authority_products" WHERE "id" = ${productId} FOR SHARE`;
      const product = await commands.client().authority_products.findUnique({ where: { id: productId } });
      if (!product) throw new RelayError("authority_product_not_found", "Authority Product not found", 404);
      if (product.lifecycle !== "listed" || product.effect_code !== "team_custom_provider_access") throw new RelayError("authority_product_not_grantable", "Authority Product is not grantable for Team Provider access", 409);
      return productSnapshot(product);
    }, 3, "Serializable");
  }

  async createAuthorityProductVersion(input: AuthorityProductTerms & { code: string; actorOwnerUserId: string; requestId?: string | null }): Promise<AuthorityProductSnapshot> {
    return this.run(async (commands) => {
      const terms = await commands.validateAuthorityProductTerms(input);
      const code = requiredCode(input.code);
      const versions = await commands.client().$queryRaw<Array<{ version: number }>>`SELECT COALESCE(MAX("version"), 0)::int + 1 AS "version" FROM "authority_products" WHERE "code" = ${code}`;
      const at = nowIso();
      const row = await commands.client().authority_products.create({ data: {
        id: createId("authority_product"), code, version: versions[0]?.version ?? 1, display_name: terms.displayName, effect_code: terms.effectCode,
        grant_units: BigInt(terms.grantUnits), purchase_amount_units: terms.purchaseAmountUnits, grant_duration_seconds: terms.grantDurationSeconds,
        max_lifetime_purchases_per_user: terms.maxLifetimePurchasesPerUser, max_unconsumed_units_per_user: terms.maxUnconsumedUnitsPerUser,
        max_current_owned_teams: terms.maxCurrentOwnedTeams, max_lifetime_created_teams: terms.maxLifetimeCreatedTeams,
        refund_mode: terms.refundMode, refund_deadline_seconds: terms.refundDeadlineSeconds, settlement_hold_seconds: terms.settlementHoldSeconds,
        seller_scope_ref: terms.sellerScopeRef, lifecycle: "draft", created_by_owner_user_id: input.actorOwnerUserId, created_at: at, updated_at: at,
      } });
      await commands.auditAppender.append(commands.client(), { actor: { actorType: "user", actorId: input.actorOwnerUserId }, action: "authority_product.create", resourceType: "authority_product", resourceId: row.id, result: "success", source: "owner", requestId: input.requestId ?? null, metadata: { code: row.code, version: row.version, effectCode: row.effect_code, lifecycle: row.lifecycle } });
      return productSnapshot(row);
    }, 3, "Serializable");
  }

  async updateDraftAuthorityProduct(productId: string, input: AuthorityProductTerms & { actorOwnerUserId: string; requestId?: string | null }): Promise<AuthorityProductSnapshot> {
    return this.run(async (commands) => {
      await commands.client().$queryRaw`SELECT "id" FROM "authority_products" WHERE "id" = ${productId} FOR UPDATE`;
      const product = await commands.client().authority_products.findUnique({ where: { id: productId } });
      if (!product) throw new RelayError("authority_product_not_found", "Authority Product not found", 404);
      if (product.lifecycle !== "draft") throw new RelayError("authority_product_frozen", "Only draft Authority Products can be edited", 409);
      const terms = await commands.validateAuthorityProductTerms(input);
      const row = await commands.client().authority_products.update({ where: { id: productId }, data: {
        display_name: terms.displayName, effect_code: terms.effectCode, grant_units: BigInt(terms.grantUnits), purchase_amount_units: terms.purchaseAmountUnits,
        grant_duration_seconds: terms.grantDurationSeconds, max_lifetime_purchases_per_user: terms.maxLifetimePurchasesPerUser,
        max_unconsumed_units_per_user: terms.maxUnconsumedUnitsPerUser, max_current_owned_teams: terms.maxCurrentOwnedTeams,
        max_lifetime_created_teams: terms.maxLifetimeCreatedTeams, refund_mode: terms.refundMode, refund_deadline_seconds: terms.refundDeadlineSeconds,
        settlement_hold_seconds: terms.settlementHoldSeconds, seller_scope_ref: terms.sellerScopeRef, updated_at: nowIso(),
      } });
      await commands.auditAppender.append(commands.client(), { actor: { actorType: "user", actorId: input.actorOwnerUserId }, action: "authority_product.update", resourceType: "authority_product", resourceId: productId, result: "success", source: "owner", requestId: input.requestId ?? null, metadata: { code: row.code, version: row.version, lifecycle: row.lifecycle } });
      return productSnapshot(row);
    }, 3, "Serializable");
  }

  async listAuthorityProductVersion(productId: string, actorOwnerUserId: string, requestId?: string | null): Promise<AuthorityProductSnapshot> {
    return this.run(async (commands) => {
      await commands.client().$queryRaw`SELECT "id" FROM "authority_products" WHERE "id" = ${productId} FOR UPDATE`;
      const product = await commands.client().authority_products.findUnique({ where: { id: productId } });
      if (!product) throw new RelayError("authority_product_not_found", "Authority Product not found", 404);
      if (product.lifecycle !== "draft") throw new RelayError("authority_product_not_draft", "Only draft Authority Products can be listed", 409);
      const previous = await commands.client().authority_products.findFirst({ where: { code: product.code, lifecycle: "listed", id: { not: product.id } }, orderBy: { version: "desc" } });
      const at = nowIso();
      if (previous) await commands.client().authority_products.update({ where: { id: previous.id }, data: { lifecycle: "closed", updated_at: at } });
      const row = await commands.client().authority_products.update({ where: { id: product.id }, data: { lifecycle: "listed", updated_at: at } });
      await commands.auditAppender.append(commands.client(), { actor: { actorType: "user", actorId: actorOwnerUserId }, action: "authority_product.list", resourceType: "authority_product", resourceId: row.id, result: "success", source: "owner", requestId: requestId ?? null, metadata: { code: row.code, version: row.version, replacedProductId: previous?.id ?? null } });
      return productSnapshot(row);
    }, 3, "Serializable");
  }

  async closeAuthorityProduct(productId: string, actorOwnerUserId: string, requestId?: string | null): Promise<AuthorityProductSnapshot> {
    return this.run(async (commands) => {
      await commands.client().$queryRaw`SELECT "id" FROM "authority_products" WHERE "id" = ${productId} FOR UPDATE`;
      const product = await commands.client().authority_products.findUnique({ where: { id: productId } });
      if (!product) throw new RelayError("authority_product_not_found", "Authority Product not found", 404);
      if (product.lifecycle === "closed") return productSnapshot(product);
      if (product.lifecycle !== "listed") throw new RelayError("authority_product_not_listed", "Only listed Authority Products can be closed", 409);
      const row = await commands.client().authority_products.update({ where: { id: product.id }, data: { lifecycle: "closed", updated_at: nowIso() } });
      await commands.auditAppender.append(commands.client(), { actor: { actorType: "user", actorId: actorOwnerUserId }, action: "authority_product.close", resourceType: "authority_product", resourceId: row.id, result: "success", source: "owner", requestId: requestId ?? null, metadata: { code: row.code, version: row.version } });
      return productSnapshot(row);
    }, 3, "Serializable");
  }

  /** Transaction-bound Billing participant. Lock order: CreditAccount -> User ->
   * Product -> Purchase identity. Authority/Entitlement participants run after it. */
  async purchaseAuthorityProductFinancialFacts(input: {
    buyerUserId: string;
    productId: string;
    idempotencyKey: string;
    requestShape: unknown;
    expectedEffectCode: AuthorityProductEffectCode;
    authorityUnconsumedUnits: number;
    requestId?: string | null;
  }): Promise<BillingAuthorityPurchaseResult> {
    return this.run(async (commands) => {
      const idempotencyKeyHash = hashRequired(input.idempotencyKey, "Idempotency-Key");
      const requestHash = digest(input.requestShape);
      const prior = await commands.client().authority_purchases.findFirst({ where: { buyer_user_id: input.buyerUserId, idempotency_key_hash: idempotencyKeyHash } });
      if (prior) {
        if (prior.request_hash !== requestHash) throw new RelayError("authority_idempotency_conflict", "Idempotency key was already used with a different Authority purchase", 409);
        return commands.purchaseResult(prior, true);
      }
      const scopeRef = `user:${input.buyerUserId}`;
      const at = nowIso();
      await commands.client().$executeRaw`
        INSERT INTO "credit_accounts" ("id", "scope_ref", "status", "balance_snap_units", "balance_snap_ledger_event_id", "balance_snap_updated_at", "created_at", "updated_at")
        VALUES (${createId("credit_account")}, ${scopeRef}, 'active', 0, NULL, NULL, ${at}, ${at})
        ON CONFLICT ("scope_ref") DO NOTHING`;
      await commands.client().$queryRaw`SELECT "id" FROM "credit_accounts" WHERE "scope_ref" = ${scopeRef} FOR UPDATE`;
      const account = await commands.client().credit_accounts.findUnique({ where: { scope_ref: scopeRef } });
      if (!account || account.status !== "active") throw new RelayError("credit_account_not_found", "An active personal credit account is required", 404);
      await commands.client().$queryRaw`SELECT "id" FROM "authority_products" WHERE "id" = ${input.productId} FOR UPDATE`;
      const product = await commands.client().authority_products.findUnique({ where: { id: input.productId } });
      if (!product || product.lifecycle !== "listed" || product.effect_code !== input.expectedEffectCode) throw new RelayError("authority_product_not_purchasable", "Authority Product is not purchasable", 409);
      const lifetimePurchases = await commands.client().authority_purchases.count({ where: { buyer_user_id: input.buyerUserId, product_code: product.code } });
      if (product.max_lifetime_purchases_per_user !== null && lifetimePurchases >= product.max_lifetime_purchases_per_user) throw new RelayError("authority_purchase_limit_exceeded", "Authority Product purchase limit reached", 409);
      if (product.max_unconsumed_units_per_user !== null && input.authorityUnconsumedUnits + safeNumber(product.grant_units) > product.max_unconsumed_units_per_user) throw new RelayError("authority_unconsumed_limit_exceeded", "Authority Product unconsumed unit limit reached", 409);
      const heldRows = await commands.client().$queryRaw<Array<{ held: bigint }>>`SELECT COALESCE(SUM("held_units"), 0)::bigint AS "held" FROM "usage_reservations" WHERE "credit_account_id" = ${account.id} AND "status" IN ('active', 'reconciling')`;
      const spendable = account.balance_snap_units - (heldRows[0]?.held ?? 0n);
      if (spendable < product.purchase_amount_units) throw new RelayError("insufficient_credit_balance", "Credit balance is insufficient", 402);
      const purchase = await commands.client().authority_purchases.create({ data: {
        id: createId("authority_purchase"), product_id: product.id, buyer_user_id: input.buyerUserId, credit_account_id: account.id,
        product_code: product.code, product_version: product.version, product_display_name: product.display_name, effect_code: product.effect_code,
        grant_units: product.grant_units, purchase_amount_units: product.purchase_amount_units, grant_duration_seconds: product.grant_duration_seconds,
        max_lifetime_purchases_per_user: product.max_lifetime_purchases_per_user, max_unconsumed_units_per_user: product.max_unconsumed_units_per_user,
        max_current_owned_teams: product.max_current_owned_teams, max_lifetime_created_teams: product.max_lifetime_created_teams,
        refund_mode: product.refund_mode, refund_deadline_seconds: product.refund_deadline_seconds, settlement_hold_seconds: product.settlement_hold_seconds,
        seller_scope_ref: product.seller_scope_ref, idempotency_key_hash: idempotencyKeyHash, request_hash: requestHash, created_at: at,
      } });
      const ledger = await commands.client().credit_ledger_events.create({ data: {
        id: createId("ledger"), account_id: account.id, event_type: "authority_purchase", amount_units: -product.purchase_amount_units,
        transfer_id: null, related_event_id: null, plan_subscription_id: null, authority_purchase_id: purchase.id, billing_event_id: null,
        provider_attempt_id: null, related_topup_id: null, card_id: null, from_account_id: account.id, to_account_id: null,
        reason: `authority_product:${product.code}@${product.version}`, actor_user_id: input.buyerUserId, created_at: at,
      } });
      await commands.client().credit_accounts.update({ where: { id: account.id }, data: { balance_snap_units: account.balance_snap_units - product.purchase_amount_units, balance_snap_ledger_event_id: ledger.id, balance_snap_updated_at: at, updated_at: at } });
      const releaseAt = addSeconds(at, product.settlement_hold_seconds);
      const revenue = await commands.client().seller_settlement_events.create({ data: {
        id: createId("seller_settlement"), plan_subscription_id: null, authority_purchase_id: purchase.id, seller_scope_ref: product.seller_scope_ref,
        window_start: at, window_end: releaseAt, release_at: releaseAt, event_type: "revenue", amount_units: product.purchase_amount_units,
        source_type: "authority_purchase", source_id: ledger.id, created_at: at,
      } });
      await commands.auditAppender.append(commands.client(), { actor: { actorType: "user", actorId: input.buyerUserId }, action: "authority_purchase.create", resourceType: "authority_purchase", resourceId: purchase.id, result: "success", source: "web", requestId: input.requestId ?? null, metadata: { productId: product.id, productCode: product.code, productVersion: product.version, grantUnits: safeNumber(product.grant_units), purchaseAmountUnits: safeNumber(product.purchase_amount_units) } });
      return { purchase: purchaseSnapshot(purchase), ledgerEventId: ledger.id, sellerSettlementRevenueId: revenue.id, replayed: false };
    }, 3, "Serializable");
  }

  async findAuthorityRefundReplay(input: { purchaseId: string; actorOwnerUserId: string; reasonCode: string; idempotencyKey: string }): Promise<BillingAuthorityRefundResult | undefined> {
    requireRefundReason(input.reasonCode);
    const idempotencyKeyHash = hashRequired(input.idempotencyKey, "Idempotency-Key");
    const requestHash = digest({ purchaseId: input.purchaseId, reasonCode: input.reasonCode });
    const byOperation = await this.client().authority_refunds.findFirst({ where: { actor_owner_user_id: input.actorOwnerUserId, idempotency_key_hash: idempotencyKeyHash } });
    if (byOperation) {
      if (byOperation.request_hash !== requestHash) throw new RelayError("authority_idempotency_conflict", "Idempotency key was already used with a different Authority refund", 409);
      return this.refundResult(byOperation, true);
    }
    const byPurchase = await this.client().authority_refunds.findUnique({ where: { authority_purchase_id: input.purchaseId } });
    return byPurchase ? this.refundResult(byPurchase, true) : undefined;
  }

  async lockAuthorityRefundCandidate(purchaseId: string): Promise<AuthorityPurchaseSnapshot> {
    return this.run(async (commands) => {
      await commands.client().$queryRaw`SELECT "window_key" FROM "seller_settlement_windows" WHERE "authority_purchase_id" = ${purchaseId} ORDER BY "window_key" FOR UPDATE`;
      await commands.client().$queryRaw`SELECT "id" FROM "authority_purchases" WHERE "id" = ${purchaseId} FOR UPDATE`;
      const purchase = await commands.client().authority_purchases.findUnique({ where: { id: purchaseId } });
      if (!purchase) throw new RelayError("authority_purchase_not_found", "Authority Purchase not found", 404);
      if (purchase.refund_mode !== "unused_by_owner" || purchase.refund_deadline_seconds === null) throw new RelayError("authority_refund_not_allowed", "Authority Purchase is not refundable", 409);
      if (nowIso() >= addSeconds(purchase.created_at, purchase.refund_deadline_seconds)) throw new RelayError("authority_refund_deadline_exceeded", "Authority Purchase refund deadline has elapsed", 409);
      const settlement = await commands.client().seller_settlement_events.findMany({ where: { authority_purchase_id: purchase.id }, select: { event_type: true } });
      if (settlement.some((row) => row.event_type === "release")) throw new RelayError("authority_refund_already_settled", "Released Authority Purchase cannot be refunded", 409);
      return purchaseSnapshot(purchase);
    }, 3, "Serializable");
  }

  /** Prepares and appends Billing-owned refund/reversal facts after the
   * Authority participant has proved the Grant unconsumed and canceled it in
   * the same root transaction. */
  async refundAuthorityPurchaseFinancialFacts(input: { purchaseId: string; grantId: string; actorOwnerUserId: string; reasonCode: string; idempotencyKey: string; grantWasUnconsumedAndCanceled: true; requestId?: string | null }): Promise<BillingAuthorityRefundResult> {
    return this.run(async (commands) => {
      requireRefundReason(input.reasonCode);
      const idempotencyKeyHash = hashRequired(input.idempotencyKey, "Idempotency-Key");
      const requestHash = digest({ purchaseId: input.purchaseId, reasonCode: input.reasonCode });
      const replay = await commands.client().authority_refunds.findFirst({ where: { actor_owner_user_id: input.actorOwnerUserId, idempotency_key_hash: idempotencyKeyHash } });
      if (replay) {
        if (replay.request_hash !== requestHash) throw new RelayError("authority_idempotency_conflict", "Idempotency key was already used with a different Authority refund", 409);
        return commands.refundResult(replay, true);
      }
      await commands.client().$queryRaw`SELECT "window_key" FROM "seller_settlement_windows" WHERE "authority_purchase_id" = ${input.purchaseId} ORDER BY "window_key" FOR UPDATE`;
      await commands.client().$queryRaw`SELECT "id" FROM "authority_purchases" WHERE "id" = ${input.purchaseId} FOR UPDATE`;
      const purchase = await commands.client().authority_purchases.findUnique({ where: { id: input.purchaseId } });
      if (!purchase) throw new RelayError("authority_purchase_not_found", "Authority Purchase not found", 404);
      const existing = await commands.client().authority_refunds.findUnique({ where: { authority_purchase_id: purchase.id } });
      if (existing) return commands.refundResult(existing, true);
      if (purchase.refund_mode !== "unused_by_owner" || purchase.refund_deadline_seconds === null) throw new RelayError("authority_refund_not_allowed", "Authority Purchase is not refundable", 409);
      const at = nowIso();
      if (at >= addSeconds(purchase.created_at, purchase.refund_deadline_seconds)) throw new RelayError("authority_refund_deadline_exceeded", "Authority Purchase refund deadline has elapsed", 409);
      const settlement = await commands.client().seller_settlement_events.findMany({ where: { authority_purchase_id: purchase.id }, orderBy: [{ created_at: "asc" }, { id: "asc" }] });
      const revenue = settlement.find((row) => row.event_type === "revenue");
      if (!revenue) throw new RelayError("authority_purchase_corrupt", "Authority Purchase Seller revenue is missing", 500);
      if (settlement.some((row) => row.event_type === "release")) throw new RelayError("authority_refund_already_settled", "Released Authority Purchase cannot be refunded", 409);
      if (settlement.some((row) => row.event_type === "reversal")) throw new RelayError("authority_purchase_corrupt", "Authority Purchase settlement was reversed without a refund fact", 500);
      const originalLedger = await commands.client().credit_ledger_events.findFirst({ where: { authority_purchase_id: purchase.id, event_type: "authority_purchase" } });
      if (!originalLedger) throw new RelayError("authority_purchase_corrupt", "Authority Purchase credit ledger event is missing", 500);
      await commands.client().$queryRaw`SELECT "id" FROM "credit_accounts" WHERE "id" = ${purchase.credit_account_id} FOR UPDATE`;
      const account = await commands.client().credit_accounts.findUnique({ where: { id: purchase.credit_account_id } });
      if (!account) throw new RelayError("credit_account_not_found", "Authority Purchase credit account is missing", 500);
      const refund = await commands.client().authority_refunds.create({ data: { id: createId("authority_refund"), authority_purchase_id: purchase.id, authority_grant_id: input.grantId, actor_owner_user_id: input.actorOwnerUserId, reason_code: input.reasonCode, idempotency_key_hash: idempotencyKeyHash, request_hash: requestHash, created_at: at } });
      const ledger = await commands.client().credit_ledger_events.create({ data: { id: createId("ledger"), account_id: account.id, event_type: "reversal", amount_units: purchase.purchase_amount_units, transfer_id: null, related_event_id: originalLedger.id, plan_subscription_id: null, authority_purchase_id: purchase.id, billing_event_id: null, provider_attempt_id: null, related_topup_id: null, card_id: null, from_account_id: null, to_account_id: account.id, reason: `authority_refund:${input.reasonCode}`, actor_user_id: input.actorOwnerUserId, created_at: at } });
      await commands.client().credit_accounts.update({ where: { id: account.id }, data: { balance_snap_units: account.balance_snap_units + purchase.purchase_amount_units, balance_snap_ledger_event_id: ledger.id, balance_snap_updated_at: at, updated_at: at } });
      const reversal = await commands.client().seller_settlement_events.create({ data: { id: createId("seller_settlement"), plan_subscription_id: null, authority_purchase_id: purchase.id, seller_scope_ref: purchase.seller_scope_ref, window_start: purchase.created_at, window_end: revenue.release_at, release_at: revenue.release_at, event_type: "reversal", amount_units: purchase.purchase_amount_units, source_type: "authority_refund", source_id: refund.id, created_at: at } });
      await commands.auditAppender.append(commands.client(), { actor: { actorType: "user", actorId: input.actorOwnerUserId }, action: "authority_purchase.refund", resourceType: "authority_purchase", resourceId: purchase.id, result: "success", source: "owner", requestId: input.requestId ?? null, metadata: { refundId: refund.id, grantId: input.grantId, reasonCode: input.reasonCode, purchaseAmountUnits: safeNumber(purchase.purchase_amount_units) } });
      return { refund: refundSnapshot(refund), creditLedgerEventId: ledger.id, sellerSettlementReversalId: reversal.id, replayed: false };
    }, 3, "Serializable");
  }

  async lockPlanSubscriptionPurchaseFunding(input: { accountId: string; planId: string; unitCount: number; actorUserId: string }): Promise<PlanSubscriptionPurchaseFunding> {
    return this.run(async (commands) => {
      if (!Number.isSafeInteger(input.unitCount) || input.unitCount < 1 || input.unitCount > 1_000) throw new RelayError("invalid_plan_units", "Plan subscription units must be a positive integer", 400);
      await commands.client().$queryRaw`SELECT "id" FROM "credit_accounts" WHERE "id" = ${input.accountId} FOR UPDATE`;
      const [account, plan] = await Promise.all([
        commands.client().credit_accounts.findUnique({ where: { id: input.accountId } }),
        commands.client().plans.findUnique({ where: { id: input.planId } }),
      ]);
      if (!account || account.status !== "active") throw new RelayError("credit_account_not_found", "A paying credit account is required", 404);
      if (!plan || plan.plan_status !== "enabled") throw new RelayError("plan_not_open_for_new_entitlements", "Plan does not accept new entitlements", 409);
      const heldRows = await commands.client().$queryRaw<Array<{ held: bigint }>>`SELECT COALESCE(SUM("held_units"), 0)::bigint AS "held" FROM "usage_reservations" WHERE "credit_account_id" = ${account.id} AND "status" IN ('active', 'reconciling')`;
      const total = plan.purchase_amount_units * BigInt(input.unitCount);
      if (account.balance_snap_units - (heldRows[0]?.held ?? 0n) < total) throw new RelayError("insufficient_credit_balance", "Credit balance is insufficient", 402);
      return { accountId: account.id, actorUserId: input.actorUserId, planId: plan.id, sellerScopeRef: plan.scope_ref as ScopeRef, billingMode: plan.billing_mode as "prepaid" | "paygo", amountPerUnit: plan.purchase_amount_units, unitCount: input.unitCount, startingBalance: account.balance_snap_units };
    }, 3, "Serializable");
  }

  async completePlanSubscriptionPurchaseFunding(funding: PlanSubscriptionPurchaseFunding, subscriptions: ReadonlyArray<{ id: string; effectiveStart: string; effectiveEnd: string | null }>): Promise<string[]> {
    return this.run(async (commands) => {
      if (subscriptions.length !== funding.unitCount) throw new RelayError("plan_purchase_subscription_count_mismatch", "Plan purchase Subscription count does not match funding", 500);
      if (funding.amountPerUnit <= 0n) return [];
      let balance = funding.startingBalance;
      const ledgerIds: string[] = [];
      for (const subscription of subscriptions) {
        const at = nowIso();
        const ledger = await commands.client().credit_ledger_events.create({ data: { id: createId("ledger"), account_id: funding.accountId, event_type: "plan_purchase", amount_units: -funding.amountPerUnit, transfer_id: null, related_event_id: null, plan_subscription_id: subscription.id, authority_purchase_id: null, billing_event_id: null, provider_attempt_id: null, related_topup_id: null, card_id: null, from_account_id: funding.accountId, to_account_id: null, reason: `plan:${funding.planId}`, actor_user_id: funding.actorUserId, created_at: at } });
        balance -= funding.amountPerUnit;
        await commands.client().credit_accounts.update({ where: { id: funding.accountId }, data: { balance_snap_units: balance, balance_snap_ledger_event_id: ledger.id, balance_snap_updated_at: at, updated_at: at } });
        ledgerIds.push(ledger.id);
        if (funding.billingMode === "prepaid" && funding.amountPerUnit > 0n) {
          for (const tranche of prepaidTranches(subscription, funding.amountPerUnit)) {
            if (tranche.amountUnits <= 0n) continue;
            await commands.client().seller_settlement_events.create({ data: { id: createId("seller_settlement"), plan_subscription_id: subscription.id, authority_purchase_id: null, seller_scope_ref: funding.sellerScopeRef, window_start: tranche.windowStart, window_end: tranche.windowEnd, release_at: tranche.windowEnd, event_type: "revenue", amount_units: tranche.amountUnits, source_type: "plan_purchase", source_id: ledger.id, created_at: at } });
          }
        }
      }
      return ledgerIds;
    }, 3, "Serializable");
  }

  async appendPlanAccessPointPriceOverrides(planId: string, overrides: ReadonlyArray<PlanAccessPointPriceOverride>): Promise<void> {
    await this.run(async (commands) => {
      for (const override of overrides) {
        const relation = await commands.client().plan_access_points.findUnique({ where: { plan_id_access_point_id: { plan_id: planId, access_point_id: override.accessPointId } } });
        if (!relation) throw new RelayError("plan_access_point_required", "Plan price override requires an included AccessPoint", 409);
        const at = nowIso();
        const units = [override.inputPer1M, override.cachedInputPer1M, override.outputPer1M].map(priceUnits);
        const price = await commands.client().plan_access_point_prices.create({ data: { id: createId("plan_ap_price"), plan_id: planId, access_point_id: override.accessPointId, input_per_1m: override.inputPer1M, cached_input_per_1m: override.cachedInputPer1M, cache_write_per_1m: override.cacheWritePer1M === undefined ? override.inputPer1M : override.cacheWritePer1M, output_per_1m: override.outputPer1M, input_price_units_per_1m: units[0]!, cached_input_price_units_per_1m: units[1]!, cache_write_price_units_per_1m: override.cacheWritePer1M === null ? null : priceUnits(override.cacheWritePer1M ?? override.inputPer1M), output_price_units_per_1m: units[2]!, status: "enabled", created_at: at, updated_at: at } });
        for (const tier of normalizePriceTiers(override.tiers ?? [])) {
          await commands.client().plan_access_point_price_tiers.create({ data: {
            id: createId("plan_ap_price_tier"), plan_access_point_price_id: price.id, service_tier: tier.serviceTier,
            tier_key: tier.tierKey, min_input_tokens: BigInt(tier.minInputTokens), max_input_tokens: tier.maxInputTokens === null ? null : BigInt(tier.maxInputTokens),
            input_per_1m: tier.inputPer1M, cached_input_per_1m: tier.cachedInputPer1M,
            cache_write_per_1m: tier.cacheWritePer1M === undefined ? tier.inputPer1M : tier.cacheWritePer1M, output_per_1m: tier.outputPer1M,
            input_price_units_per_1m: priceUnits(tier.inputPer1M), cached_input_price_units_per_1m: priceUnits(tier.cachedInputPer1M),
            cache_write_price_units_per_1m: tier.cacheWritePer1M === null ? null : priceUnits(tier.cacheWritePer1M ?? tier.inputPer1M), output_price_units_per_1m: priceUnits(tier.outputPer1M),
            status: tier.status ?? "enabled", created_at: tier.createdAt ?? at, updated_at: tier.updatedAt ?? at,
          } });
        }
      }
    }, 3, "Serializable");
  }

  async configurePersonalAccessPointZeroPrice(input: { planId: string; accessPointId: string; actorUserId: string; requestId?: string | null }): Promise<{ accessPointPriceId: string; planAccessPointPriceId: string }> {
    return this.run(async (commands) => {
      const relation = await commands.client().plan_access_points.findUnique({ where: { plan_id_access_point_id: { plan_id: input.planId, access_point_id: input.accessPointId } } });
      if (!relation) throw new RelayError("plan_access_point_required", "Personal managed Plan must include the AccessPoint", 409);
      const at = nowIso();
      let base = await commands.client().access_point_prices.findFirst({ where: { access_point_id: input.accessPointId, initial_price: 1 } });
      const basePriceCreated = !base;
      if (!base) {
        base = await commands.client().access_point_prices.create({ data: {
          id: createId("ap_price"), access_point_id: input.accessPointId,
          input_per_1m: 0, cached_input_per_1m: 0, cache_write_per_1m: 0, output_per_1m: 0,
          input_price_units_per_1m: 0n, cached_input_price_units_per_1m: 0n, cache_write_price_units_per_1m: 0n, output_price_units_per_1m: 0n,
          status: "enabled", initial_price: 1, created_at: at, updated_at: at,
        } });
        await commands.auditAppender.append(commands.client(), {
          actor: { actorType: "user", actorId: input.actorUserId }, action: "access_point_price.create",
          resourceType: "access_point_price", resourceId: base.id, result: "success", source: "web", requestId: input.requestId ?? null,
          metadata: { accessPointId: input.accessPointId, priceSource: "explicit", tierCount: 0 },
        });
      }
      let override = await commands.client().plan_access_point_prices.findFirst({ where: { plan_id: input.planId, access_point_id: input.accessPointId, status: "enabled" }, orderBy: [{ created_at: "desc" }, { id: "desc" }] });
      const planOverrideCreated = !override;
      if (!override) override = await commands.client().plan_access_point_prices.create({ data: {
        id: createId("plan_ap_price"), plan_id: input.planId, access_point_id: input.accessPointId,
        input_per_1m: 0, cached_input_per_1m: 0, cache_write_per_1m: 0, output_per_1m: 0,
        input_price_units_per_1m: 0n, cached_input_price_units_per_1m: 0n, cache_write_price_units_per_1m: 0n, output_price_units_per_1m: 0n,
        status: "enabled", created_at: at, updated_at: at,
      } });
      await commands.auditAppender.append(commands.client(), {
        actor: { actorType: "user", actorId: input.actorUserId }, action: "personal_access_point_zero_price.ensure",
        resourceType: "access_point_price", resourceId: override.id, result: "success", source: "web", requestId: input.requestId ?? null,
        metadata: { accessPointId: input.accessPointId, planId: input.planId, basePriceCreated, planOverrideCreated, zeroPrice: true },
      });
      return { accessPointPriceId: base.id, planAccessPointPriceId: override.id };
    }, 3, "Serializable");
  }

  async ensurePersonalProviderModelZeroCost(input: { providerId: string; providerModelName: string; actorUserId: string; requestId?: string | null }): Promise<string> {
    return this.run(async (commands) => {
      const model = await commands.client().provider_models.findUnique({ where: { provider_id_provider_model_name: { provider_id: input.providerId, provider_model_name: input.providerModelName } } });
      if (!model) throw new RelayError("provider_model_not_found", "ProviderModel not found", 404);
      const existing = await commands.client().provider_model_costs.findFirst({ where: { provider_id: input.providerId, provider_model_name: input.providerModelName, status: "enabled" }, orderBy: [{ created_at: "desc" }, { id: "desc" }] });
      const at = nowIso();
      const row = existing ?? await commands.client().provider_model_costs.create({ data: {
        id: createId("provider_cost"), provider_id: input.providerId, provider_model_name: input.providerModelName,
        input_per_1m: 0, cached_input_per_1m: 0, cache_write_per_1m: 0, output_per_1m: 0,
        input_price_units_per_1m: 0n, cached_input_price_units_per_1m: 0n, cache_write_price_units_per_1m: 0n, output_price_units_per_1m: 0n,
        source: "personal_provider_upstream_account", status: "enabled", created_at: at, updated_at: at,
      } });
      await commands.auditAppender.append(commands.client(), {
        actor: { actorType: "user", actorId: input.actorUserId }, action: "personal_provider_model_zero_cost.ensure",
        resourceType: "provider_model_cost", resourceId: row.id, result: "success", source: "web", requestId: input.requestId ?? null,
        metadata: { providerId: input.providerId, providerModelName: input.providerModelName, costCreated: !existing, zeroCost: true },
      });
      return row.id;
    }, 3, "Serializable");
  }

  private async validateAuthorityProductTerms(input: AuthorityProductTerms): Promise<AuthorityProductTerms> {
    const displayName = requiredText(input.displayName, "displayName", 120);
    if (input.effectCode !== "team_create_unit" && input.effectCode !== "team_custom_provider_access" && input.effectCode !== "user_custom_provider_access") throw new RelayError("authority_product_effect_invalid", "Unsupported Authority Product effect", 400);
    const grantUnits = bounded(input.grantUnits, "grantUnits", AUTHORITY_PRODUCT_LIMITS.maxGrantUnits);
    const purchaseAmountUnits = boundedBigInt(input.purchaseAmountUnits, "purchaseAmountUnits", BigInt(AUTHORITY_PRODUCT_LIMITS.maxPurchaseAmountUnits));
    const grantDurationSeconds = bounded(input.grantDurationSeconds, "grantDurationSeconds", AUTHORITY_PRODUCT_LIMITS.maxGrantDurationSeconds);
    const maxLifetimePurchasesPerUser = optionalBounded(input.maxLifetimePurchasesPerUser, "maxLifetimePurchasesPerUser", AUTHORITY_PRODUCT_LIMITS.maxPurchaseOrUnconsumedLimit);
    const maxUnconsumedUnitsPerUser = optionalBounded(input.maxUnconsumedUnitsPerUser, "maxUnconsumedUnitsPerUser", AUTHORITY_PRODUCT_LIMITS.maxPurchaseOrUnconsumedLimit);
    const maxCurrentOwnedTeams = optionalBounded(input.maxCurrentOwnedTeams, "maxCurrentOwnedTeams", AUTHORITY_PRODUCT_LIMITS.maxTeamLimit);
    const maxLifetimeCreatedTeams = optionalBounded(input.maxLifetimeCreatedTeams, "maxLifetimeCreatedTeams", AUTHORITY_PRODUCT_LIMITS.maxTeamLimit);
    const settlementHoldSeconds = bounded(input.settlementHoldSeconds, "settlementHoldSeconds", AUTHORITY_PRODUCT_LIMITS.maxSettlementHoldSeconds);
    if (input.refundMode !== "none" && input.refundMode !== "unused_by_owner") throw new RelayError("authority_refund_mode_invalid", "Unsupported Authority Product refund mode", 400);
    const refundDeadlineSeconds = optionalBounded(input.refundDeadlineSeconds, "refundDeadlineSeconds", AUTHORITY_PRODUCT_LIMITS.maxGrantDurationSeconds);
    if (input.refundMode === "none" && refundDeadlineSeconds !== null) throw new RelayError("authority_refund_terms_invalid", "Non-refundable products cannot define a refund deadline", 400);
    if (input.refundMode === "unused_by_owner" && (refundDeadlineSeconds === null || refundDeadlineSeconds > grantDurationSeconds || refundDeadlineSeconds >= settlementHoldSeconds)) throw new RelayError("authority_refund_terms_invalid", "Refund deadline must not exceed Grant duration and must end before settlement release", 400);
    if (input.effectCode === "team_custom_provider_access" && (grantUnits !== 1 || maxUnconsumedUnitsPerUser !== null || maxCurrentOwnedTeams !== null || maxLifetimeCreatedTeams !== null || input.refundMode !== "none")) throw new RelayError("authority_product_terms_invalid", "Team Provider access requires one non-refundable Team entitlement and no Team creation limits", 400);
    if (input.effectCode === "user_custom_provider_access" && (
      grantUnits !== 1 || (maxLifetimePurchasesPerUser !== null && maxLifetimePurchasesPerUser < 2) || maxUnconsumedUnitsPerUser !== null
      || maxCurrentOwnedTeams !== null || maxLifetimeCreatedTeams !== null
      || input.refundMode !== "none" || refundDeadlineSeconds !== null
      || grantDurationSeconds % 86_400 !== 0
    )) throw new RelayError("authority_product_terms_invalid", "Personal Provider access requires one non-refundable slot and a positive integer-day duration", 400);
    if (!isRuntimeScopeRef(input.sellerScopeRef)) throw new RelayError("authority_seller_scope_invalid", "Seller scope is invalid", 400);
    return { displayName, effectCode: input.effectCode, grantUnits, purchaseAmountUnits, grantDurationSeconds, maxLifetimePurchasesPerUser, maxUnconsumedUnitsPerUser, maxCurrentOwnedTeams, maxLifetimeCreatedTeams, refundMode: input.refundMode, refundDeadlineSeconds, settlementHoldSeconds, sellerScopeRef: input.sellerScopeRef };
  }

  private async purchaseResult(row: Parameters<typeof purchaseSnapshot>[0], replayed: boolean): Promise<BillingAuthorityPurchaseResult> {
    const [ledger, revenue] = await Promise.all([
      this.client().credit_ledger_events.findFirst({ where: { authority_purchase_id: row.id, event_type: "authority_purchase" } }),
      this.client().seller_settlement_events.findFirst({ where: { authority_purchase_id: row.id, event_type: "revenue" } }),
    ]);
    if (!ledger || !revenue) throw new RelayError("authority_purchase_corrupt", "Authority Purchase financial facts are missing", 500);
    return { purchase: purchaseSnapshot(row), ledgerEventId: ledger.id, sellerSettlementRevenueId: revenue.id, replayed };
  }

  private async refundResult(row: Parameters<typeof refundSnapshot>[0], replayed: boolean): Promise<BillingAuthorityRefundResult> {
    const [ledger, settlement] = await Promise.all([
      this.client().credit_ledger_events.findFirst({ where: { authority_purchase_id: row.authority_purchase_id, event_type: "reversal" } }),
      this.client().seller_settlement_events.findFirst({ where: { authority_purchase_id: row.authority_purchase_id, event_type: "reversal" } }),
    ]);
    if (!ledger || !settlement) throw new RelayError("authority_refund_corrupt", "Authority refund reversal facts are missing", 500);
    return { refund: refundSnapshot(row), creditLedgerEventId: ledger.id, sellerSettlementReversalId: settlement.id, replayed };
  }
}

function prepaidTranches(subscription: { effectiveStart: string; effectiveEnd: string | null }, amountUnits: bigint): Array<{ windowStart: string; windowEnd: string; amountUnits: bigint }> {
  const startMs = Date.parse(subscription.effectiveStart);
  const endMs = subscription.effectiveEnd ? Date.parse(subscription.effectiveEnd) : Number.NaN;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs || amountUnits <= 0n) throw new RelayError("invalid_seller_settlement_window", "Prepaid Seller settlement requires a finite positive Subscription period", 500);
  const durationMs = endMs - startMs;
  const windowMs = 2_592_000_000;
  const result: Array<{ windowStart: string; windowEnd: string; amountUnits: bigint }> = [];
  let allocated = 0n;
  for (let windowStartMs = startMs; windowStartMs < endMs; windowStartMs += windowMs) {
    const windowEndMs = windowStartMs + windowMs;
    const overlapMs = Math.min(endMs, windowEndMs) - windowStartMs;
    const tranche = windowEndMs >= endMs ? amountUnits - allocated : amountUnits * BigInt(overlapMs) / BigInt(durationMs);
    allocated += tranche;
    result.push({ windowStart: new Date(windowStartMs).toISOString(), windowEnd: new Date(windowEndMs).toISOString(), amountUnits: tranche });
  }
  if (allocated !== amountUnits) throw new Error("seller_settlement_tranche_allocation_invalid");
  return result;
}

function productSnapshot(row: { id: string; code: string; version: number; display_name: string; effect_code: string; grant_units: bigint; purchase_amount_units: bigint; grant_duration_seconds: number; max_lifetime_purchases_per_user: number | null; max_unconsumed_units_per_user: number | null; max_current_owned_teams: number | null; max_lifetime_created_teams: number | null; refund_mode: string; refund_deadline_seconds: number | null; settlement_hold_seconds: number; seller_scope_ref: string; lifecycle: string; created_by_owner_user_id: string; created_at: string; updated_at: string }): AuthorityProductSnapshot {
  return { id: row.id, code: row.code, version: row.version, displayName: row.display_name, effectCode: row.effect_code as AuthorityProductEffectCode, grantUnits: safeNumber(row.grant_units), purchaseAmountUnits: row.purchase_amount_units, grantDurationSeconds: row.grant_duration_seconds, maxLifetimePurchasesPerUser: row.max_lifetime_purchases_per_user, maxUnconsumedUnitsPerUser: row.max_unconsumed_units_per_user, maxCurrentOwnedTeams: row.max_current_owned_teams, maxLifetimeCreatedTeams: row.max_lifetime_created_teams, refundMode: row.refund_mode as "none" | "unused_by_owner", refundDeadlineSeconds: row.refund_deadline_seconds, settlementHoldSeconds: row.settlement_hold_seconds, sellerScopeRef: row.seller_scope_ref as ScopeRef, lifecycle: row.lifecycle as "draft" | "listed" | "closed", createdByOwnerUserId: row.created_by_owner_user_id, createdAt: row.created_at, updatedAt: row.updated_at };
}

function purchaseSnapshot(row: { id: string; product_id: string; buyer_user_id: string; credit_account_id: string; product_code: string; product_version: number; product_display_name: string; effect_code: string; grant_units: bigint; purchase_amount_units: bigint; grant_duration_seconds: number; max_lifetime_purchases_per_user: number | null; max_unconsumed_units_per_user: number | null; max_current_owned_teams: number | null; max_lifetime_created_teams: number | null; refund_mode: string; refund_deadline_seconds: number | null; settlement_hold_seconds: number; seller_scope_ref: string; idempotency_key_hash: string; request_hash: string; created_at: string }): AuthorityPurchaseSnapshot {
  return { id: row.id, productId: row.product_id, buyerUserId: row.buyer_user_id, creditAccountId: row.credit_account_id, productCode: row.product_code, productVersion: row.product_version, productDisplayName: row.product_display_name, effectCode: row.effect_code as AuthorityProductEffectCode, grantUnits: safeNumber(row.grant_units), purchaseAmountUnits: row.purchase_amount_units, grantDurationSeconds: row.grant_duration_seconds, maxLifetimePurchasesPerUser: row.max_lifetime_purchases_per_user, maxUnconsumedUnitsPerUser: row.max_unconsumed_units_per_user, maxCurrentOwnedTeams: row.max_current_owned_teams, maxLifetimeCreatedTeams: row.max_lifetime_created_teams, refundMode: row.refund_mode as "none" | "unused_by_owner", refundDeadlineSeconds: row.refund_deadline_seconds, settlementHoldSeconds: row.settlement_hold_seconds, sellerScopeRef: row.seller_scope_ref as ScopeRef, idempotencyKeyHash: row.idempotency_key_hash, requestHash: row.request_hash, createdAt: row.created_at };
}

function refundSnapshot(row: { id: string; authority_purchase_id: string; authority_grant_id: string; actor_owner_user_id: string; reason_code: string; idempotency_key_hash: string; request_hash: string; created_at: string }): AuthorityRefundSnapshot {
  return { id: row.id, authorityPurchaseId: row.authority_purchase_id, authorityGrantId: row.authority_grant_id, actorOwnerUserId: row.actor_owner_user_id, reasonCode: row.reason_code, idempotencyKeyHash: row.idempotency_key_hash, requestHash: row.request_hash, createdAt: row.created_at };
}

function requiredCode(value: string): string { const result = value.trim().toLowerCase(); if (!/^[a-z][a-z0-9_-]{1,63}$/u.test(result)) throw new RelayError("authority_product_code_invalid", "Authority Product code is invalid", 400); return result; }
function requiredText(value: string, name: string, max = 200): string { const result = value.trim(); if (!result || result.length > max) throw new RelayError("authority_text_invalid", `${name} is required`, 400); return result; }
function bounded(value: number, name: string, max: number): number { if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new RelayError("authority_product_value_invalid", `${name} is outside its accepted range`, 400); return value; }
function boundedBigInt(value: bigint, name: string, max: bigint): bigint { if (value < 1n || value > max) throw new RelayError("authority_product_value_invalid", `${name} is outside its accepted range`, 400); return value; }
function optionalBounded(value: number | null, name: string, max: number): number | null { return value === null ? null : bounded(value, name, max); }
function safeNumber(value: bigint): number { const result = Number(value); if (!Number.isSafeInteger(result)) throw new RelayError("billing_integer_out_of_range", "Billing integer is outside the supported range", 500); return result; }
function priceUnits(value: number): bigint { if (!Number.isFinite(value) || value < 0) throw new RelayError("invalid_price_profile", "Price must be finite and non-negative", 400); return BigInt(Math.round(value * 1_000_000)); }
function addSeconds(value: string, seconds: number): string { return new Date(Date.parse(value) + seconds * 1_000).toISOString(); }
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function hashRequired(value: string, name: string): string { return createHash("sha256").update(requiredText(value, name)).digest("hex"); }
function normalizePageSize(value: number): number { return [10, 20, 50, 100].includes(value) ? value : 20; }
function requireRefundReason(value: string): void { if (!(AUTHORITY_REFUND_REASON_CODES as readonly string[]).includes(value)) throw new RelayError("authority_refund_reason_invalid", "Authority refund reason is invalid", 400); }
function normalizePriceTiers(tiers: readonly PlanAccessPointPriceTierInput[]): Array<PlanAccessPointPriceTierInput & { serviceTier: string; tierKey: string; minInputTokens: number; maxInputTokens: number | null }> {
  const seen = new Set<string>();
  return tiers.map((tier, index) => {
    const tierKey = String(tier.tierKey ?? (Number(tier.minInputTokens) <= 0 ? "short_context" : "long_context")).trim();
    const serviceTier = String(tier.serviceTier ?? "standard").trim();
    const minInputTokens = Number(tier.minInputTokens);
    const maxInputTokens = tier.maxInputTokens === undefined || tier.maxInputTokens === null ? null : Number(tier.maxInputTokens);
    if (!/^[a-z][a-z0-9_]{1,63}$/u.test(tierKey) || !["standard", "batch", "flex", "priority"].includes(serviceTier) || !Number.isInteger(minInputTokens) || minInputTokens < 0 || (maxInputTokens !== null && (!Number.isInteger(maxInputTokens) || maxInputTokens < minInputTokens))) throw new RelayError("invalid_plan_access_point_price_tier", `Price tier ${index} is invalid`, 400);
    for (const value of [tier.inputPer1M, tier.cachedInputPer1M, tier.outputPer1M, ...(tier.cacheWritePer1M === null || tier.cacheWritePer1M === undefined ? [] : [tier.cacheWritePer1M])]) priceUnits(value);
    const key = `${serviceTier}:${tierKey}`;
    if (seen.has(key)) throw new RelayError("invalid_plan_access_point_price_tier", `Duplicate price tier key ${key}`, 400);
    seen.add(key);
    return { ...tier, serviceTier, tierKey, minInputTokens, maxInputTokens };
  });
}
