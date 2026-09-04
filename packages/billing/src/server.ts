import { createId, RelayError } from "@frely/core";
import { Prisma } from "@frely/postgres/server";
import {
  actualInvocationChargeUnits,
  encodeFrozenPriceProfile,
  encodeFrozenPriceUnits,
  parseFrozenPriceUnits,
  selectFrozenPriceProfile,
  type FrozenPriceUnits,
  type InvocationUsageUnits,
} from "./invocation-domain.js";
import type {
  ClaimlessInvocationBillingFinancialTerms,
  ClaimlessInvocationBillingFinancialTermsInput,
  FrozenAccessPointPriceEvidence,
  FrozenAccessPointPriceProfile,
  InvocationBillingAdmissionFundingInput,
  InvocationBillingAttemptSnapshot,
  InvocationBillingBudgetInput,
  InvocationBillingFinancialTerms,
  InvocationBillingFinancialTermsInput,
  InvocationBillingOccupationInput,
  InvocationBillingOccupationSnapshot,
  InvocationBillingSettlementResult,
  ClaimlessInvocationBillingAttemptSnapshot,
  SettleInvocationBillingCommand,
  TransitionInvocationReconciliationInput,
  UsageReconciliationProjection,
} from "./invocation-contracts.js";

export type * from "./invocation-contracts.js";
export * from "./commerce.js";
export * from "./runtime.js";

interface LockedCreditAccount {
  id: string;
  status: string;
  balanceSnapUnits: bigint;
}

interface SettleInvocationBillingInput extends SettleInvocationBillingCommand {
  account: LockedCreditAccount | null;
}

export class AdmitInvocationBilling {
  constructor(readonly userPaygoConcurrencyLimit = 2) {
    if (!Number.isSafeInteger(userPaygoConcurrencyLimit) || userPaygoConcurrencyLimit < 1 || userPaygoConcurrencyLimit > 100) {
      throw new Error("user_paygo_concurrency_limit_invalid");
    }
  }

  lockAdmissionFunding(transaction: Prisma.TransactionClient, input: InvocationBillingAdmissionFundingInput): Promise<LockedCreditAccount | null> {
    return lockInvocationBillingAdmissionFunding(transaction, input);
  }

  assertCapacity(transaction: Prisma.TransactionClient, input: Omit<Parameters<typeof assertInvocationBillingCapacity>[1], "userPaygoConcurrencyLimit">): Promise<void> {
    return assertInvocationBillingCapacity(transaction, { ...input, userPaygoConcurrencyLimit: this.userPaygoConcurrencyLimit });
  }

  assertPlanBudgets(transaction: Prisma.TransactionClient, input: InvocationBillingBudgetInput): Promise<void> {
    return assertInvocationPlanBudgets(transaction, input);
  }

  assertDirectBudgets(transaction: Prisma.TransactionClient, input: InvocationBillingBudgetInput): Promise<void> {
    return assertInvocationDirectBudgets(transaction, input);
  }

  readOccupation(transaction: Prisma.TransactionClient, billableInvocationRef: string): Promise<InvocationBillingOccupationSnapshot> {
    return readInvocationBillingOccupation(transaction, billableInvocationRef);
  }

  prepareFinancialTerms(transaction: Prisma.TransactionClient, input: InvocationBillingFinancialTermsInput): Promise<InvocationBillingFinancialTerms> {
    return prepareInvocationBillingFinancialTerms(transaction, input);
  }

  execute(transaction: Prisma.TransactionClient, input: InvocationBillingOccupationInput): Promise<{ usageReservationId: string | null }> {
    return createInvocationBillingOccupation(transaction, input);
  }
}

export class PrepareClaimlessInvocationBilling {
  execute(
    transaction: Prisma.TransactionClient,
    input: ClaimlessInvocationBillingFinancialTermsInput,
  ): Promise<ClaimlessInvocationBillingFinancialTerms> {
    return prepareClaimlessInvocationBillingFinancialTerms(transaction, input);
  }
}

export async function prepareClaimlessInvocationBillingFinancialTerms(
  transaction: Prisma.TransactionClient,
  input: ClaimlessInvocationBillingFinancialTermsInput,
): Promise<ClaimlessInvocationBillingFinancialTerms> {
  const pricing = await loadInvocationPriceRows(transaction, input);
  if (!pricing.priceBase
    || (input.billablePriceSource === "plan_access_point" && (!("planId" in pricing.priceBase) || pricing.priceBase.planId !== input.planId))
    || pricing.priceBase.accessPointId !== input.accessPointPriceContexts[0]?.accessPointId) {
    throw new RelayError("billable_price_changed", "Billable price no longer belongs to the admitted Plan and entry AccessPoint", 409);
  }
  if (!pricing.providerCost
    || pricing.providerCost.providerId !== input.providerId
    || pricing.providerCost.providerModelName !== input.providerModelName) {
    throw new RelayError("access_configuration_changed", "Provider cost no longer belongs to the admitted ProviderModel", 409);
  }
  const accessPointProfiles: FrozenAccessPointPriceProfile[] = [];
  for (const context of input.accessPointPriceContexts) {
    const accessPointPrice = pricing.accessPointPriceById.get(context.priceId);
    if (!accessPointPrice || accessPointPrice.accessPointId !== context.accessPointId) {
      throw new RelayError("access_configuration_changed", "AccessPoint price no longer belongs to the admitted path", 409);
    }
    accessPointProfiles.push({
      accessPointId: context.accessPointId,
      targetAccessPointId: context.targetAccessPointId,
      buyerScopeRef: context.buyerScopeRef,
      sellerScopeRef: context.sellerScopeRef,
      priceId: context.priceId,
      profileJson: freezePriceProfileRow(accessPointPrice, pricing.accessPointTiersByPriceId.get(accessPointPrice.id) ?? []),
    });
  }
  return {
    billablePriceProfileJson: freezePriceProfileRow(pricing.priceBase, pricing.priceTiers),
    providerCostProfileJson: freezePriceProfileRow(pricing.providerCost, pricing.providerCostTiers),
    accessPointPriceProfilesJson: JSON.stringify(accessPointProfiles),
  };
}

export async function prepareInvocationBillingFinancialTerms(
  transaction: Prisma.TransactionClient,
  input: InvocationBillingFinancialTermsInput,
): Promise<InvocationBillingFinancialTerms> {
  const pricing = await loadInvocationPriceRows(transaction, input);
  if (!pricing.priceBase
    || (input.billablePriceSource === "plan_access_point" && (!("planId" in pricing.priceBase) || pricing.priceBase.planId !== input.planId))
    || pricing.priceBase.accessPointId !== input.accessPointPriceContexts[0]?.accessPointId) {
    throw new RelayError("billable_price_changed", "Billable price no longer belongs to the admitted Plan and entry AccessPoint", 409);
  }
  const price = freezePriceRow(pricing.priceBase, pricing.priceTiers, input);
  if (!pricing.providerCost
    || pricing.providerCost.providerId !== input.providerId
    || pricing.providerCost.providerModelName !== input.providerModelName) {
    throw new RelayError("access_configuration_changed", "Provider cost no longer belongs to the admitted ProviderModel", 409);
  }
  const frozenProviderCost = freezePriceRow(pricing.providerCost, pricing.providerCostTiers, input);
  const accessPointPrices: FrozenAccessPointPriceEvidence[] = [];
  for (const context of input.accessPointPriceContexts) {
    const accessPointPrice = pricing.accessPointPriceById.get(context.priceId);
    if (!accessPointPrice || accessPointPrice.accessPointId !== context.accessPointId) throw new RelayError("access_configuration_changed", "AccessPoint price no longer belongs to the admitted path", 409);
    const frozen = freezePriceRow(accessPointPrice, pricing.accessPointTiersByPriceId.get(accessPointPrice.id) ?? [], input);
    accessPointPrices.push({
      accessPointId: context.accessPointId, targetAccessPointId: context.targetAccessPointId,
      buyerScopeRef: context.buyerScopeRef, sellerScopeRef: context.sellerScopeRef,
      priceId: context.priceId, tierKey: frozen.tierKey, snapshotJson: frozen.snapshotJson,
    });
  }
  return {
    price,
    providerOwnerScopeRef: input.providerOwnerScopeRef,
    providerCost: { tierKey: frozenProviderCost.tierKey, snapshotJson: frozenProviderCost.snapshotJson },
    accessPointPrices,
  };
}

interface InvocationPriceInput {
  planId: string;
  providerId: string;
  providerModelName: string;
  providerModelCostId: string;
  billablePriceSource: "access_point" | "plan_access_point";
  billablePriceId: string;
  accessPointPriceContexts: readonly { accessPointId: string; targetAccessPointId: string | null; buyerScopeRef: string; sellerScopeRef: string; priceId: string }[];
}

interface AdmissionAccessPointPriceRow extends UnitPriceRow {
  id: string;
  accessPointId: string;
}

interface AdmissionPlanAccessPointPriceRow extends UnitPriceRow {
  id: string;
  planId: string;
  accessPointId: string;
}

interface AdmissionProviderCostRow extends UnitPriceRow {
  id: string;
  providerId: string;
  providerModelName: string;
}

interface AdmissionAccessPointTierRow extends UnitPriceTierRow {
  priceId: string;
}

interface AdmissionPlanAccessPointTierRow extends UnitPriceTierRow {
  priceId: string;
}

interface AdmissionProviderCostTierRow extends UnitPriceTierRow {
  priceId: string;
}

interface InvocationPriceRows {
  accessPointPriceById: ReadonlyMap<string, AdmissionAccessPointPriceRow>;
  accessPointTiersByPriceId: ReadonlyMap<string, AdmissionAccessPointTierRow[]>;
  priceBase: AdmissionAccessPointPriceRow | AdmissionPlanAccessPointPriceRow | undefined;
  priceTiers: UnitPriceTierRow[];
  providerCost: AdmissionProviderCostRow | undefined;
  providerCostTiers: AdmissionProviderCostTierRow[];
}

async function loadInvocationPriceRows(
  transaction: Prisma.TransactionClient,
  input: InvocationPriceInput,
): Promise<InvocationPriceRows> {
  const accessPointPriceIds = [...new Set([
    ...input.accessPointPriceContexts.map((context) => context.priceId),
    ...(input.billablePriceSource === "access_point" ? [input.billablePriceId] : []),
  ])];
  if (accessPointPriceIds.length === 0) {
    throw new RelayError("access_configuration_changed", "Provider invocation has no AccessPoint price references", 409);
  }
  const accessPointPrices = await transaction.$queryRaw<AdmissionAccessPointPriceRow[]>(Prisma.sql`
    SELECT "id", "access_point_id" AS "accessPointId", "status",
           "input_price_units_per_1m" AS "input_price_units_per_1m",
           "cached_input_price_units_per_1m" AS "cached_input_price_units_per_1m",
           "cache_write_price_units_per_1m" AS "cache_write_price_units_per_1m",
           "output_price_units_per_1m" AS "output_price_units_per_1m"
    FROM "access_point_prices"
    WHERE "id" = ANY(${accessPointPriceIds}::text[])
    ORDER BY "id" ASC
    FOR SHARE
  `);
  const accessPointTiers = await transaction.$queryRaw<AdmissionAccessPointTierRow[]>(Prisma.sql`
    SELECT "access_point_price_id" AS "priceId", "service_tier", "tier_key",
           "min_input_tokens", "max_input_tokens", "status",
           "input_price_units_per_1m", "cached_input_price_units_per_1m",
           "cache_write_price_units_per_1m", "output_price_units_per_1m"
    FROM "access_point_price_tiers"
    WHERE "access_point_price_id" = ANY(${accessPointPriceIds}::text[])
    ORDER BY "access_point_price_id" ASC, "min_input_tokens" ASC, "tier_key" ASC
    FOR SHARE
  `);
  const planPrices = input.billablePriceSource === "plan_access_point"
    ? await transaction.$queryRaw<AdmissionPlanAccessPointPriceRow[]>(Prisma.sql`
      SELECT "id", "plan_id" AS "planId", "access_point_id" AS "accessPointId", "status",
             "input_price_units_per_1m" AS "input_price_units_per_1m",
             "cached_input_price_units_per_1m" AS "cached_input_price_units_per_1m",
             "cache_write_price_units_per_1m" AS "cache_write_price_units_per_1m",
             "output_price_units_per_1m" AS "output_price_units_per_1m"
      FROM "plan_access_point_prices"
      WHERE "id" = ${input.billablePriceId}
      FOR SHARE
    `)
    : [];
  const planTiers = input.billablePriceSource === "plan_access_point"
    ? await transaction.$queryRaw<AdmissionPlanAccessPointTierRow[]>(Prisma.sql`
      SELECT "plan_access_point_price_id" AS "priceId", "service_tier", "tier_key",
             "min_input_tokens", "max_input_tokens", "status",
             "input_price_units_per_1m", "cached_input_price_units_per_1m",
             "cache_write_price_units_per_1m", "output_price_units_per_1m"
      FROM "plan_access_point_price_tiers"
      WHERE "plan_access_point_price_id" = ${input.billablePriceId}
      ORDER BY "min_input_tokens" ASC, "tier_key" ASC
      FOR SHARE
    `)
    : [];
  const providerCosts = await transaction.$queryRaw<AdmissionProviderCostRow[]>(Prisma.sql`
    SELECT "id", "provider_id" AS "providerId", "provider_model_name" AS "providerModelName", "status",
           "input_price_units_per_1m" AS "input_price_units_per_1m",
           "cached_input_price_units_per_1m" AS "cached_input_price_units_per_1m",
           "cache_write_price_units_per_1m" AS "cache_write_price_units_per_1m",
           "output_price_units_per_1m" AS "output_price_units_per_1m"
    FROM "provider_model_costs"
    WHERE "id" = ${input.providerModelCostId}
    FOR SHARE
  `);
  const providerTiers = await transaction.$queryRaw<AdmissionProviderCostTierRow[]>(Prisma.sql`
    SELECT "provider_model_cost_id" AS "priceId", "service_tier", "tier_key",
           "min_input_tokens", "max_input_tokens", "status",
           "input_price_units_per_1m", "cached_input_price_units_per_1m",
           "cache_write_price_units_per_1m", "output_price_units_per_1m"
    FROM "provider_model_cost_tiers"
    WHERE "provider_model_cost_id" = ${input.providerModelCostId}
    ORDER BY "min_input_tokens" ASC, "tier_key" ASC
    FOR SHARE
  `);
  const accessPointPriceById = new Map(accessPointPrices.map((price) => [price.id, price]));
  const accessPointTiersByPriceId = new Map<string, AdmissionAccessPointTierRow[]>();
  for (const tier of accessPointTiers) {
    const tiers = accessPointTiersByPriceId.get(tier.priceId) ?? [];
    tiers.push(tier);
    accessPointTiersByPriceId.set(tier.priceId, tiers);
  }
  const priceBase = input.billablePriceSource === "plan_access_point" ? planPrices[0] : accessPointPriceById.get(input.billablePriceId);
  const priceTiers = input.billablePriceSource === "plan_access_point"
    ? planTiers
    : accessPointTiersByPriceId.get(input.billablePriceId) ?? [];
  return {
    accessPointPriceById,
    accessPointTiersByPriceId,
    priceBase,
    priceTiers,
    providerCost: providerCosts[0],
    providerCostTiers: providerTiers,
  };
}

interface UnitPriceRow {
  status: string;
  input_price_units_per_1m: bigint;
  cached_input_price_units_per_1m: bigint;
  cache_write_price_units_per_1m: bigint | null;
  output_price_units_per_1m: bigint;
}

interface UnitPriceTierRow extends UnitPriceRow {
  service_tier: string;
  tier_key: string;
  min_input_tokens: bigint;
  max_input_tokens: bigint | null;
}

function freezePriceProfileRow(base: UnitPriceRow, tiers: UnitPriceTierRow[]): string {
  return encodeFrozenPriceProfile({
    status: base.status,
    inputPriceUnitsPer1M: base.input_price_units_per_1m,
    cachedInputPriceUnitsPer1M: base.cached_input_price_units_per_1m,
    cacheWritePriceUnitsPer1M: base.cache_write_price_units_per_1m,
    outputPriceUnitsPer1M: base.output_price_units_per_1m,
    tiers: tiers.map((tier) => ({
      status: tier.status,
      serviceTier: tier.service_tier,
      tierKey: tier.tier_key,
      minInputTokens: tier.min_input_tokens,
      maxInputTokens: tier.max_input_tokens,
      inputPriceUnitsPer1M: tier.input_price_units_per_1m,
      cachedInputPriceUnitsPer1M: tier.cached_input_price_units_per_1m,
      cacheWritePriceUnitsPer1M: tier.cache_write_price_units_per_1m,
      outputPriceUnitsPer1M: tier.output_price_units_per_1m,
    })),
  });
}

function freezePriceRow(
  base: UnitPriceRow,
  tiers: UnitPriceTierRow[],
  input: Pick<InvocationBillingFinancialTermsInput, "inputTokens" | "serviceTier">,
): { units: FrozenPriceUnits; serviceTier: string; tierKey: string; snapshotJson: string } {
  if (base.status !== "enabled") throw new RelayError("billable_price_changed", "Billable price is no longer enabled", 409);
  const eligible = tiers.filter((tier) => tier.status === "enabled" && tier.min_input_tokens <= input.inputTokens && (tier.max_input_tokens === null || tier.max_input_tokens >= input.inputTokens));
  const byMostSpecificTier = (left: UnitPriceTierRow, right: UnitPriceTierRow) => left.min_input_tokens === right.min_input_tokens ? 0 : left.min_input_tokens > right.min_input_tokens ? -1 : 1;
  const requestedTier = eligible.filter((tier) => tier.service_tier === input.serviceTier).sort(byMostSpecificTier)[0];
  const standardTier = eligible.filter((tier) => tier.service_tier === "standard").sort(byMostSpecificTier)[0];
  if (input.serviceTier !== "standard" && !requestedTier) throw new RelayError("price_service_tier_unavailable", "The requested Provider service tier has no frozen price contract", 409);
  const allStandardTiers = tiers.filter((tier) => tier.status === "enabled" && tier.service_tier === "standard")
    .sort((left, right) => left.min_input_tokens < right.min_input_tokens ? -1 : left.min_input_tokens > right.min_input_tokens ? 1 : 0);
  const baseCoversStandardInput = allStandardTiers.length === 0 || input.inputTokens < allStandardTiers[0]!.min_input_tokens;
  if (input.serviceTier === "standard" && !standardTier && !baseCoversStandardInput) throw new RelayError("price_tier_not_available", "No enabled standard price tier covers the admitted input tokens", 409);
  const tier = requestedTier ?? standardTier;
  const units: FrozenPriceUnits = tier ? {
    inputPriceUnitsPer1M: tier.input_price_units_per_1m,
    cachedInputPriceUnitsPer1M: tier.cached_input_price_units_per_1m,
    cacheWritePriceUnitsPer1M: tier.cache_write_price_units_per_1m,
    outputPriceUnitsPer1M: tier.output_price_units_per_1m,
  } : {
    inputPriceUnitsPer1M: base.input_price_units_per_1m,
    cachedInputPriceUnitsPer1M: base.cached_input_price_units_per_1m,
    cacheWritePriceUnitsPer1M: base.cache_write_price_units_per_1m,
    outputPriceUnitsPer1M: base.output_price_units_per_1m,
  };
  const serviceTier = tier?.service_tier ?? "standard";
  const tierKey = tier?.tier_key ?? "legacy_flat";
  return { units, serviceTier, tierKey, snapshotJson: encodeFrozenPriceUnits({ ...units, serviceTier, tierKey }) };
}

export async function readInvocationBillingOccupation(
  transaction: Prisma.TransactionClient,
  billableInvocationRef: string,
): Promise<InvocationBillingOccupationSnapshot> {
  const claim = await transaction.budget_claims.findUnique({ where: { provider_attempt_id: billableInvocationRef } });
  const reservation = await transaction.usage_reservations.findUnique({ where: { provider_attempt_id: billableInvocationRef } });
  if (reservation && (reservation.preparation_evidence_id === null
    || reservation.preparation_evidence_version === null
    || reservation.prepared_payload_id === null)) {
    throw new RelayError("provider_attempt_preparation_binding_missing", "Protected Billing occupation lacks CPA preparation binding evidence", 409);
  }
  return {
    claim: claim ? {
      requestId: claim.request_id, planId: claim.plan_id, planSubscriptionId: claim.plan_subscription_id,
      apiKeyId: claim.api_key_id, userId: claim.user_id,
      maximumTokens: claim.max_total_tokens, maximumChargeUnits: claim.max_charge_units,
    } : null,
    reservation: reservation ? {
      id: reservation.id, creditAccountId: reservation.credit_account_id,
      planSubscriptionId: reservation.plan_subscription_id, userId: reservation.user_id,
      inputTokens: reservation.input_tokens, maxOutputTokens: reservation.max_output_tokens,
      tokenizerId: reservation.tokenizer_id, tokenizerVersion: reservation.tokenizer_version,
      preparationEvidenceId: reservation.preparation_evidence_id!, preparationEvidenceVersion: reservation.preparation_evidence_version!,
      preparedPayloadId: reservation.prepared_payload_id!,
      billablePriceSource: reservation.billable_price_source, billablePriceId: reservation.billable_price_id,
      reservationUnits: reservation.reservation_units,
    } : null,
  };
}

export async function assertInvocationPlanBudgets(
  transaction: Prisma.TransactionClient,
  input: InvocationBillingBudgetInput,
): Promise<void> {
  const limits = await transaction.plan_budget_limits.findMany({ where: { plan_id: input.planId } });
  if (limits.length === 0) return;
  const windows = limits.map((limit) => {
    const window = fixedBudgetWindow(input.subscriptionEffectiveStart, input.subscriptionEffectiveEnd, limit.window_type, limit.window_seconds, input.occurredAt);
    return { id: limit.id, scope: limit.limit_scope, start: window.start, end: window.end };
  });
  const usage = await transaction.$queryRaw<Array<{
    limitId: string;
    settledTokens: bigint;
    settledUnits: bigint;
    claimedTokens: bigint;
    claimedUnits: bigint;
  }>>(Prisma.sql`
    WITH budget_windows("limit_id", "limit_scope", "start_at", "end_at") AS (
      SELECT window_row."id", window_row."scope", window_row."start", window_row."end"
      FROM jsonb_to_recordset(${JSON.stringify(windows)}::jsonb)
        AS window_row("id" text, "scope" text, "start" text, "end" text)
    ),
    settled AS (
      SELECT bw."limit_id",
             COALESCE(SUM(fact."total_tokens"), 0)::bigint AS "tokens",
             COALESCE(SUM(fact."actual_charge_units"), 0)::bigint AS "units"
      FROM budget_windows bw
      LEFT JOIN "provider_invocation_usage_facts" fact
        ON fact."occurred_at" >= bw."start_at"
       AND fact."occurred_at" < bw."end_at"
       AND fact."plan_subscription_id" = ${input.planSubscriptionId}
       AND (bw."limit_scope" <> 'user' OR fact."user_id" = ${input.userId})
      GROUP BY bw."limit_id"
    ),
    claimed AS (
      SELECT bw."limit_id",
             COALESCE(SUM(claim."max_total_tokens"), 0)::bigint AS "tokens",
             COALESCE(SUM(claim."max_charge_units"), 0)::bigint AS "units"
      FROM budget_windows bw
      LEFT JOIN "request_provider_attempts" attempt
        ON attempt."started_at" >= bw."start_at"
       AND attempt."started_at" < bw."end_at"
      LEFT JOIN "budget_claims" claim
        ON claim."provider_attempt_id" = attempt."id"
       AND claim."plan_subscription_id" = ${input.planSubscriptionId}
       AND (bw."limit_scope" <> 'user' OR claim."user_id" = ${input.userId})
      GROUP BY bw."limit_id"
    )
    SELECT bw."limit_id" AS "limitId",
           COALESCE(settled."tokens", 0)::bigint AS "settledTokens",
           COALESCE(settled."units", 0)::bigint AS "settledUnits",
           COALESCE(claimed."tokens", 0)::bigint AS "claimedTokens",
           COALESCE(claimed."units", 0)::bigint AS "claimedUnits"
    FROM budget_windows bw
    LEFT JOIN settled ON settled."limit_id" = bw."limit_id"
    LEFT JOIN claimed ON claimed."limit_id" = bw."limit_id"
  `);
  const usageByLimit = new Map(usage.map((row) => [row.limitId, row]));
  for (const limit of limits) {
    const current = usageByLimit.get(limit.id) ?? { settledTokens: 0n, settledUnits: 0n, claimedTokens: 0n, claimedUnits: 0n };
    if (limit.metric === "tokens") {
      if (current.settledTokens + current.claimedTokens + input.maximumTokens > BigInt(Math.trunc(limit.limit_value))) throw new RelayError("plan_subscription_budget_tokens_exceeded", "Provider invocation would exceed Plan token budget", 402);
    } else {
      if (limit.limit_amount_units === null) throw new RelayError("budget_units_missing", "Plan amount budget has no units value", 500);
      if (current.settledUnits + current.claimedUnits + input.maximumChargeUnits > limit.limit_amount_units) throw new RelayError("plan_subscription_budget_amount_exceeded", "Provider invocation would exceed Plan amount budget", 402);
    }
  }
}

export async function assertInvocationDirectBudgets(
  transaction: Prisma.TransactionClient,
  input: InvocationBillingBudgetInput,
): Promise<void> {
  const assignments = await transaction.$queryRaw<Array<{
    id: string;
    scopeRef: string;
    budgetPolicyId: string;
    status: string;
    createdAt: string;
    updatedAt: string;
    policyId: string;
    policyMetric: string;
    policyLimitValue: number;
    policyLimitAmountUnits: bigint | null;
    policyWindowType: string;
    policyWindowSeconds: number | null;
    policyStatus: string;
  }>>(Prisma.sql`
    SELECT assignment."id", assignment."scope_ref" AS "scopeRef", assignment."budget_policy_id" AS "budgetPolicyId",
           assignment."status", assignment."created_at" AS "createdAt", assignment."updated_at" AS "updatedAt",
           policy."id" AS "policyId", policy."metric" AS "policyMetric",
           policy."limit_value" AS "policyLimitValue", policy."limit_amount_units" AS "policyLimitAmountUnits",
           policy."window_type" AS "policyWindowType", policy."window_seconds" AS "policyWindowSeconds",
           policy."status" AS "policyStatus"
    FROM "scope_budget_policies" assignment
    INNER JOIN "budget_policies" policy ON policy."id" = assignment."budget_policy_id"
    WHERE assignment."scope_ref" = ${`key:${input.apiKeyId}`}
      AND assignment."status" = 'enabled'
    ORDER BY assignment."created_at" ASC, assignment."id" ASC
    FOR SHARE OF assignment, policy
  `);
  const activeAssignments = assignments.filter((assignment) => assignment.policyStatus === "enabled");
  if (activeAssignments.length === 0) return;
  const windows = activeAssignments.map((assignment) => {
    const start = assignment.policyWindowType === "rolling" && assignment.policyWindowSeconds
      ? new Date(Date.parse(input.occurredAt) - assignment.policyWindowSeconds * 1_000).toISOString()
      : assignment.createdAt;
    return { id: assignment.id, start, end: input.occurredAt };
  });
  const usage = await transaction.$queryRaw<Array<{
    assignmentId: string;
    settledTokens: bigint;
    settledUnits: bigint;
    claimedTokens: bigint;
    claimedUnits: bigint;
  }>>(Prisma.sql`
    WITH budget_windows("assignment_id", "start_at", "end_at") AS (
      SELECT window_row."id", window_row."start", window_row."end"
      FROM jsonb_to_recordset(${JSON.stringify(windows)}::jsonb)
        AS window_row("id" text, "start" text, "end" text)
    ),
    settled AS (
      SELECT bw."assignment_id",
             COALESCE(SUM(fact."total_tokens"), 0)::bigint AS "tokens",
             COALESCE(SUM(fact."actual_charge_units"), 0)::bigint AS "units"
      FROM budget_windows bw
      LEFT JOIN "provider_invocation_usage_facts" fact
        ON fact."occurred_at" >= bw."start_at"
       AND fact."occurred_at" < bw."end_at"
       AND fact."api_key_id" = ${input.apiKeyId}
      GROUP BY bw."assignment_id"
    ),
    claimed AS (
      SELECT bw."assignment_id",
             COALESCE(SUM(claim."max_total_tokens"), 0)::bigint AS "tokens",
             COALESCE(SUM(claim."max_charge_units"), 0)::bigint AS "units"
      FROM budget_windows bw
      LEFT JOIN "request_provider_attempts" attempt
        ON attempt."started_at" >= bw."start_at"
       AND attempt."started_at" < bw."end_at"
      LEFT JOIN "budget_claims" claim
        ON claim."provider_attempt_id" = attempt."id"
       AND claim."api_key_id" = ${input.apiKeyId}
      GROUP BY bw."assignment_id"
    )
    SELECT bw."assignment_id" AS "assignmentId",
           COALESCE(settled."tokens", 0)::bigint AS "settledTokens",
           COALESCE(settled."units", 0)::bigint AS "settledUnits",
           COALESCE(claimed."tokens", 0)::bigint AS "claimedTokens",
           COALESCE(claimed."units", 0)::bigint AS "claimedUnits"
    FROM budget_windows bw
    LEFT JOIN settled ON settled."assignment_id" = bw."assignment_id"
    LEFT JOIN claimed ON claimed."assignment_id" = bw."assignment_id"
  `);
  const usageByAssignment = new Map(usage.map((row) => [row.assignmentId, row]));
  for (const assignment of activeAssignments) {
    const policy = assignment;
    const current = usageByAssignment.get(assignment.id) ?? { settledTokens: 0n, settledUnits: 0n, claimedTokens: 0n, claimedUnits: 0n };
    if (policy.policyMetric === "tokens") {
      if (current.settledTokens + current.claimedTokens + input.maximumTokens > BigInt(Math.trunc(policy.policyLimitValue))) throw new RelayError("budget_token_limit_exceeded", "Provider invocation would exceed API Key token budget", 402);
    } else {
      if (policy.policyLimitAmountUnits === null) throw new RelayError("budget_units_missing", "API Key amount budget has no units value", 500);
      if (current.settledUnits + current.claimedUnits + input.maximumChargeUnits > policy.policyLimitAmountUnits) throw new RelayError("budget_amount_limit_exceeded", "Provider invocation would exceed API Key amount budget", 402);
    }
  }
}

export class SettleInvocationBilling {
  lockFunding(transaction: Prisma.TransactionClient, billableInvocationRef: string): Promise<LockedCreditAccount | null> {
    return lockInvocationBillingSettlementAccount(transaction, billableInvocationRef);
  }

  execute(transaction: Prisma.TransactionClient, input: SettleInvocationBillingInput): Promise<InvocationBillingSettlementResult> {
    return settleInvocationBilling(transaction, input);
  }
}

export class TransitionInvocationReconciliation {
  lockFunding(transaction: Prisma.TransactionClient, billableInvocationRef: string): Promise<LockedCreditAccount | null> {
    return lockInvocationBillingSettlementAccount(transaction, billableInvocationRef);
  }

  execute(transaction: Prisma.TransactionClient, input: TransitionInvocationReconciliationInput): Promise<void> {
    return markInvocationBillingReconciliation(transaction, input);
  }
}

export class ListUsageReconciliations {
  execute(transaction: Prisma.TransactionClient, limit = 100): Promise<UsageReconciliationProjection[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new RelayError("invalid_reconciliation_limit", "Reconciliation limit must be between 1 and 500", 400);
    return transaction.$queryRaw<UsageReconciliationProjection[]>(usageReconciliationProjectionSql(Prisma.empty, Prisma.sql`LIMIT ${limit}`));
  }

  executeForBillableInvocationRefs(
    transaction: Prisma.TransactionClient,
    billableInvocationRefs: string[],
  ): Promise<UsageReconciliationProjection[]> {
    const refs = [...new Set(billableInvocationRefs)];
    if (refs.length === 0) return Promise.resolve([]);
    if (refs.length > 500 || refs.some((ref) => ref.length < 1 || ref.length > 192)) {
      throw new RelayError("invalid_reconciliation_refs", "Reconciliation references must contain between 1 and 500 bounded values", 400);
    }
    return transaction.$queryRaw<UsageReconciliationProjection[]>(usageReconciliationProjectionSql(
      Prisma.sql`WHERE claim."provider_attempt_id" = ANY(${refs}::text[])`,
      Prisma.empty,
    ));
  }
}

function usageReconciliationProjectionSql(where: Prisma.Sql, limit: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
      SELECT claim."provider_attempt_id" AS "billableInvocationRef",
             reservation."id" AS "usageReservationId", reservation."status" AS "reservationStatus",
             reservation."held_units" AS "heldUnits", reservation."reservation_units" AS "reservationUnits",
             claim."max_total_tokens" AS "maximumTokens", claim."max_charge_units" AS "maximumChargeUnits",
             claim."created_at" AS "createdAt"
      FROM "budget_claims" claim
      LEFT JOIN "usage_reservations" reservation ON reservation."provider_attempt_id" = claim."provider_attempt_id"
      ${where}
      ORDER BY claim."created_at" ASC, claim."provider_attempt_id" ASC
      ${limit}
    `;
}

export async function lockInvocationBillingAdmissionFunding(
  transaction: Prisma.TransactionClient,
  input: InvocationBillingAdmissionFundingInput,
): Promise<LockedCreditAccount | null> {
  const account = input.usageChargeAccountId
    ? await lockCreditAccount(transaction, input.usageChargeAccountId)
    : await lockUserCreditAccountIfPresent(transaction, input.userId);
  if (account && account.balanceSnapUnits < 0n) throw new RelayError("negative_credit_balance", "Credit balance is negative; only balance-restoring activity is allowed", 402);
  if (input.usageChargeAccountId && (!account || account.id !== input.usageChargeAccountId || account.status !== "active")) {
    throw new RelayError("usage_charge_account_not_found", "PayGo usage charge account is unavailable", 402);
  }
  if (input.usageChargeAccountId) await lockPaygoUser(transaction, input.userId);
  return account;
}

export async function assertInvocationBillingCapacity(
  transaction: Prisma.TransactionClient,
  input: { account: LockedCreditAccount; userId: string; requiredUnits: bigint; now: string; userPaygoConcurrencyLimit: number },
): Promise<void> {
  const rows = await transaction.$queryRaw<Array<{ held: bigint; activeForUser: bigint }>>(Prisma.sql`
    SELECT
      COALESCE((
        SELECT SUM("held_units")
        FROM "usage_reservations"
        WHERE "credit_account_id" = ${input.account.id}
          AND "status" IN ('active', 'reconciling')
      ), 0)::bigint AS "held",
      (
        SELECT COUNT(*)
        FROM "usage_reservations"
        WHERE "user_id" = ${input.userId}
          AND "status" IN ('active', 'reconciling')
      )::bigint AS "activeForUser"
  `);
  const held = rows[0]?.held ?? 0n;
  const spendable = input.account.balanceSnapUnits - held;
  if (spendable < input.requiredUnits) {
    throw new RelayError("insufficient_credit_reservation", "Balance is sufficient before other holds, but spendable balance cannot cover this invocation reservation", 402, {
      balanceUnits: input.account.balanceSnapUnits.toString(), activeHeldUnits: held.toString(), requiredReservationUnits: input.requiredUnits.toString(),
    });
  }
  const activeForUser = rows[0]?.activeForUser ?? 0n;
  if (activeForUser >= BigInt(input.userPaygoConcurrencyLimit)) throw new RelayError("paygo_concurrency_limit_exceeded", "Personal PayGo invocation concurrency limit is reached", 429, { limit: input.userPaygoConcurrencyLimit });
}

export async function createInvocationBillingOccupation(
  transaction: Prisma.TransactionClient,
  input: InvocationBillingOccupationInput,
): Promise<{ usageReservationId: string | null }> {
  if (input.maxOutputTokens < 1n
    || !boundedEvidenceIdentity(input.preparationEvidenceId)
    || !Number.isSafeInteger(input.preparationEvidenceVersion) || input.preparationEvidenceVersion < 1
    || !boundedEvidenceIdentity(input.preparedPayloadId)) {
    throw new RelayError("invalid_cpa_preparation_evidence", "CPA preparation identity, version, payload binding, and positive output cap are required", 400);
  }
  await transaction.budget_claims.create({ data: {
    provider_attempt_id: input.billableInvocationRef, request_id: input.requestId, plan_id: input.planId,
    plan_subscription_id: input.planSubscriptionId, api_key_id: input.apiKeyId, user_id: input.userId,
    max_total_tokens: input.maximumTokens, max_charge_units: input.maximumChargeUnits, created_at: input.createdAt,
  } });
  if (!input.usageChargeAccountId) return { usageReservationId: null };
  const usageReservationId = createId("usage_reservation");
  await transaction.usage_reservations.create({ data: {
    id: usageReservationId, provider_attempt_id: input.billableInvocationRef, request_id: input.requestId,
    credit_account_id: input.usageChargeAccountId, plan_subscription_id: input.planSubscriptionId,
    user_id: input.userId, status: "active", reservation_units: input.maximumChargeUnits, held_units: input.maximumChargeUnits,
    input_tokens: input.inputTokens, max_output_tokens: input.maxOutputTokens,
    tokenizer_id: input.tokenizerId, tokenizer_version: input.tokenizerVersion,
    preparation_evidence_id: input.preparationEvidenceId, preparation_evidence_version: input.preparationEvidenceVersion,
    prepared_payload_id: input.preparedPayloadId, service_tier: input.serviceTier,
    billable_price_source: input.billablePriceSource, billable_price_id: input.billablePriceId,
    billable_price_tier_key: input.billablePriceTierKey, price_snapshot_json: input.priceSnapshotJson,
    posting_ledger_event_id: null, created_at: input.createdAt, updated_at: input.createdAt,
  } });
  return { usageReservationId };
}

export async function lockInvocationBillingSettlementAccount(
  transaction: Prisma.TransactionClient,
  providerAttemptId: string,
): Promise<LockedCreditAccount | null> {
  const reservation = await transaction.usage_reservations.findUnique({ where: { provider_attempt_id: providerAttemptId }, select: { credit_account_id: true } });
  if (reservation) return lockCreditAccount(transaction, reservation.credit_account_id);
  const attempt = await transaction.request_provider_attempts.findUnique({
    where: { id: providerAttemptId },
    select: { invocation_contract: true, usage_charge_account_id: true },
  });
  return attempt?.invocation_contract === "cpa-basic@1" && attempt.usage_charge_account_id
    ? lockCreditAccount(transaction, attempt.usage_charge_account_id)
    : null;
}

export async function settleInvocationBilling(
  transaction: Prisma.TransactionClient,
  input: SettleInvocationBillingInput,
): Promise<InvocationBillingSettlementResult> {
  const existingFact = await transaction.provider_invocation_usage_facts.findUnique({ where: { provider_attempt_id: input.billableInvocationRef } });
  if (existingFact) {
    const sameUsage = existingFact.input_tokens === input.usage.inputTokens
      && existingFact.cached_input_tokens === input.usage.cachedInputTokens
      && existingFact.cache_write_tokens === input.usage.cacheWriteTokens
      && existingFact.output_tokens === input.usage.outputTokens
      && existingFact.total_tokens === input.usage.totalTokens
      && existingFact.usage_source === input.usage.source;
    if (!sameUsage) throw new RelayError("provider_attempt_settlement_conflict", "Existing ProviderAttempt settlement does not match the final usage command", 409);
    return { actualChargeUnits: existingFact.actual_charge_units, postingLedgerEventId: existingFact.posting_ledger_event_id, billingEventId: existingFact.billing_event_id, replayed: true };
  }
  return input.attempt.invocationContract === "cpa-basic@1"
    ? settleClaimlessInvocationBilling(transaction, input as SettleInvocationBillingInput & { attempt: ClaimlessInvocationBillingAttemptSnapshot })
    : settleProtectedInvocationBilling(transaction, input as SettleInvocationBillingInput & { attempt: Extract<SettleInvocationBillingInput["attempt"], { invocationContract: "protected@1" }> });
}

async function settleProtectedInvocationBilling(
  transaction: Prisma.TransactionClient,
  input: SettleInvocationBillingInput & { attempt: Extract<SettleInvocationBillingInput["attempt"], { invocationContract: "protected@1" }> },
): Promise<InvocationBillingSettlementResult> {
  const claim = await transaction.budget_claims.findUnique({ where: { provider_attempt_id: input.billableInvocationRef } });
  if (!claim) throw new RelayError("provider_attempt_budget_claim_missing", "ProviderAttempt BudgetClaim is missing", 409);
  const reservation = await transaction.usage_reservations.findUnique({ where: { provider_attempt_id: input.billableInvocationRef } });
  const zeroReservationOutcome = input.zeroReservationOutcome ?? "settled";
  if (zeroReservationOutcome === "released") assertReleasedUsageIsZero(input.usage);
  const priceSnapshotJson = reservation?.price_snapshot_json ?? input.attempt.billablePriceSnapshotJson;
  const accessPointPrices = parseFrozenAccessPointPrices(input.attempt.accessPointPriceSnapshotsJson);
  assertCacheWritePriceAvailable(input.usage, [
    priceSnapshotJson,
    input.attempt.providerCostSnapshotJson,
    ...accessPointPrices.map((price) => price.snapshotJson),
  ]);
  const actualChargeUnits = zeroReservationOutcome === "released" ? 0n : actualInvocationChargeUnits(input.usage, parseFrozenPriceUnits(priceSnapshotJson));
  const providerCostUnits = zeroReservationOutcome === "released" ? 0n : actualInvocationChargeUnits(input.usage, parseFrozenPriceUnits(input.attempt.providerCostSnapshotJson));
  const billingEventId = createId("billing");
  const now = input.settledAt;
  await createFinalBillingFacts(transaction, {
    billingEventId,
    attempt: input.attempt,
    references: { requestId: claim.request_id, planSubscriptionId: claim.plan_subscription_id, apiKeyId: claim.api_key_id, userId: claim.user_id },
    usage: input.usage,
    actualChargeUnits,
    providerCostUnits,
    grossMarginUnits: actualChargeUnits - providerCostUnits,
    billablePriceTierKey: input.attempt.billablePriceTierKey,
    billablePriceSnapshotJson: priceSnapshotJson,
    providerCostTierKey: input.attempt.providerCostTierKey,
    providerCostSnapshotJson: input.attempt.providerCostSnapshotJson,
    accessPointPrices,
  });
  const postingLedgerEventId = actualChargeUnits > 0n && reservation
    ? await appendUsageCharge(transaction, {
      account: input.account,
      actualChargeUnits,
      billingEventId,
      billableInvocationRef: input.billableInvocationRef,
      planSubscriptionId: claim.plan_subscription_id,
      actorUserId: null,
      settledAt: now,
    })
    : null;
  await appendInvocationUsageFact(transaction, {
    billableInvocationRef: input.billableInvocationRef,
    references: { requestId: claim.request_id, planSubscriptionId: claim.plan_subscription_id, apiKeyId: claim.api_key_id, userId: claim.user_id },
    usage: input.usage,
    actualChargeUnits,
    priceSnapshotJson,
    occurredAt: input.attempt.startedAt,
    settledAt: now,
    postingLedgerEventId,
    billingEventId,
  });
  await transaction.budget_claims.delete({ where: { provider_attempt_id: input.billableInvocationRef } });
  if (reservation) await transaction.usage_reservations.update({ where: { id: reservation.id }, data: {
    status: zeroReservationOutcome, held_units: 0n, posting_ledger_event_id: postingLedgerEventId, updated_at: now,
  } });
  return { actualChargeUnits, postingLedgerEventId, billingEventId, replayed: false };
}

async function settleClaimlessInvocationBilling(
  transaction: Prisma.TransactionClient,
  input: SettleInvocationBillingInput & { attempt: ClaimlessInvocationBillingAttemptSnapshot },
): Promise<InvocationBillingSettlementResult> {
  const [claim, reservation] = await Promise.all([
    transaction.budget_claims.findUnique({ where: { provider_attempt_id: input.billableInvocationRef }, select: { provider_attempt_id: true } }),
    transaction.usage_reservations.findUnique({ where: { provider_attempt_id: input.billableInvocationRef }, select: { id: true } }),
  ]);
  if (claim || reservation) throw new RelayError("cpa_basic_billing_occupation_invalid", "Claimless ProviderAttempt cannot have a protected Billing occupation", 409);
  const billablePrice = selectFrozenPriceProfile(
    input.attempt.billablePriceProfileJson,
    input.usage.inputTokens,
    input.attempt.requestedServiceTier,
    input.attempt.requireServiceTier,
  );
  const providerCost = selectFrozenPriceProfile(
    input.attempt.providerCostProfileJson,
    input.usage.inputTokens,
    input.attempt.requestedServiceTier,
    input.attempt.requireServiceTier,
  );
  const accessPointPrices = selectClaimlessAccessPointPrices(input.attempt, input.usage.inputTokens);
  if (input.usage.cacheWriteTokens > 0n && [
    billablePrice.units,
    providerCost.units,
    ...accessPointPrices.map((price) => parseFrozenPriceUnits(price.snapshotJson)),
  ].some((price) => price.cacheWritePriceUnitsPer1M === null)) {
    throw new RelayError("unexpected_cache_write_usage", "The Provider returned Cache write usage for a frozen price tier configured as Unavailable", 500);
  }
  const actualChargeUnits = actualInvocationChargeUnits(input.usage, billablePrice.units);
  const providerCostUnits = actualInvocationChargeUnits(input.usage, providerCost.units);
  const billingEventId = createId("billing");
  const now = input.settledAt;
  const references = {
    requestId: input.attempt.requestId,
    planSubscriptionId: input.attempt.planSubscriptionId,
    apiKeyId: input.attempt.apiKeyId,
    userId: input.attempt.userId,
  };
  await createFinalBillingFacts(transaction, {
    billingEventId,
    attempt: input.attempt,
    references,
    usage: input.usage,
    actualChargeUnits,
    providerCostUnits,
    grossMarginUnits: actualChargeUnits - providerCostUnits,
    billablePriceTierKey: billablePrice.tierKey,
    billablePriceSnapshotJson: billablePrice.snapshotJson,
    providerCostTierKey: providerCost.tierKey,
    providerCostSnapshotJson: providerCost.snapshotJson,
    accessPointPrices,
  });
  const postingLedgerEventId = input.attempt.planBillingMode === "paygo" && actualChargeUnits > 0n
    ? await appendUsageCharge(transaction, {
      account: input.account,
      actualChargeUnits,
      billingEventId,
      billableInvocationRef: input.billableInvocationRef,
      planSubscriptionId: input.attempt.planSubscriptionId,
      actorUserId: input.attempt.userId,
      settledAt: now,
    })
    : null;
  await appendInvocationUsageFact(transaction, {
    billableInvocationRef: input.billableInvocationRef,
    references,
    usage: input.usage,
    actualChargeUnits,
    priceSnapshotJson: billablePrice.snapshotJson,
    occurredAt: input.attempt.startedAt,
    settledAt: now,
    postingLedgerEventId,
    billingEventId,
  });
  return { actualChargeUnits, postingLedgerEventId, billingEventId, replayed: false };
}

export async function markInvocationBillingReconciliation(
  transaction: Prisma.TransactionClient,
  input: TransitionInvocationReconciliationInput,
): Promise<void> {
  const reservation = await transaction.usage_reservations.findUnique({ where: { provider_attempt_id: input.billableInvocationRef } });
  if (reservation && (reservation.status === "active" || reservation.status === "reconciling")) {
    await transaction.usage_reservations.update({ where: { id: reservation.id }, data: {
      status: "reconciling", held_units: input.costExposure === "stopped" ? 0n : reservation.held_units, updated_at: input.transitionedAt,
    } });
  }
}

function parseFrozenAccessPointPrices(json: string): FrozenAccessPointPriceEvidence[] {
  let value: unknown;
  try { value = JSON.parse(json) as unknown; } catch { throw new RelayError("invalid_price_snapshot", "Frozen AccessPoint price snapshots are invalid", 500); }
  if (!Array.isArray(value)) throw new RelayError("invalid_price_snapshot", "Frozen AccessPoint price snapshots are invalid", 500);
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new RelayError("invalid_price_snapshot", "Frozen AccessPoint price snapshot is invalid", 500);
    const record = item as Record<string, unknown>;
    for (const field of ["accessPointId", "buyerScopeRef", "sellerScopeRef", "priceId", "tierKey", "snapshotJson"] as const) {
      if (typeof record[field] !== "string") throw new RelayError("invalid_price_snapshot", `Frozen AccessPoint price ${field} is invalid`, 500);
    }
    if (record.targetAccessPointId !== null && typeof record.targetAccessPointId !== "string") throw new RelayError("invalid_price_snapshot", "Frozen AccessPoint target is invalid", 500);
    parseFrozenPriceUnits(record.snapshotJson as string);
    return record as unknown as FrozenAccessPointPriceEvidence;
  });
}

function selectClaimlessAccessPointPrices(
  attempt: ClaimlessInvocationBillingAttemptSnapshot,
  inputTokens: bigint,
): FrozenAccessPointPriceEvidence[] {
  let value: unknown;
  try { value = JSON.parse(attempt.accessPointPriceProfilesJson) as unknown; } catch {
    throw new RelayError("invalid_price_profile", "Frozen AccessPoint price profiles are invalid", 500);
  }
  if (!Array.isArray(value)) throw new RelayError("invalid_price_profile", "Frozen AccessPoint price profiles are invalid", 500);
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new RelayError("invalid_price_profile", "Frozen AccessPoint price profile is invalid", 500);
    const profile = item as Record<string, unknown>;
    for (const field of ["accessPointId", "buyerScopeRef", "sellerScopeRef", "priceId", "profileJson"] as const) {
      if (typeof profile[field] !== "string") throw new RelayError("invalid_price_profile", `Frozen AccessPoint price ${field} is invalid`, 500);
    }
    if (profile.targetAccessPointId !== null && typeof profile.targetAccessPointId !== "string") {
      throw new RelayError("invalid_price_profile", "Frozen AccessPoint target is invalid", 500);
    }
    const selected = selectFrozenPriceProfile(
      profile.profileJson as string,
      inputTokens,
      attempt.requestedServiceTier,
      attempt.requireServiceTier,
    );
    return {
      accessPointId: profile.accessPointId as string,
      targetAccessPointId: profile.targetAccessPointId as string | null,
      buyerScopeRef: profile.buyerScopeRef as string,
      sellerScopeRef: profile.sellerScopeRef as string,
      priceId: profile.priceId as string,
      tierKey: selected.tierKey,
      snapshotJson: selected.snapshotJson,
    };
  });
}

interface FinalBillingReferences {
  requestId: string;
  planSubscriptionId: string;
  apiKeyId: string;
  userId: string;
}

async function appendUsageCharge(
  transaction: Prisma.TransactionClient,
  input: {
    account: LockedCreditAccount | null;
    actualChargeUnits: bigint;
    billingEventId: string;
    billableInvocationRef: string;
    planSubscriptionId: string;
    actorUserId: string | null;
    settledAt: string;
  },
): Promise<string> {
  if (!input.account) throw new RelayError("credit_account_not_found", "Provider invocation CreditAccount is missing", 409);
  const postingLedgerEventId = createId("ledger");
  await transaction.credit_ledger_events.create({ data: {
    id: postingLedgerEventId, account_id: input.account.id, event_type: "usage_charge", amount_units: -input.actualChargeUnits,
    transfer_id: null, related_event_id: null, plan_subscription_id: input.planSubscriptionId,
    authority_purchase_id: null, billing_event_id: input.billingEventId, provider_attempt_id: input.billableInvocationRef,
    related_topup_id: null, card_id: null, from_account_id: input.account.id, to_account_id: null,
    reason: `provider_attempt:${input.billableInvocationRef}`, actor_user_id: input.actorUserId, created_at: input.settledAt,
  } });
  await transaction.credit_accounts.update({ where: { id: input.account.id }, data: {
    balance_snap_units: input.account.balanceSnapUnits - input.actualChargeUnits,
    balance_snap_ledger_event_id: postingLedgerEventId,
    balance_snap_updated_at: input.settledAt,
    updated_at: input.settledAt,
  } });
  return postingLedgerEventId;
}

async function appendInvocationUsageFact(
  transaction: Prisma.TransactionClient,
  input: {
    billableInvocationRef: string;
    references: FinalBillingReferences;
    usage: InvocationUsageUnits;
    actualChargeUnits: bigint;
    priceSnapshotJson: string;
    occurredAt: string;
    settledAt: string;
    postingLedgerEventId: string | null;
    billingEventId: string;
  },
): Promise<void> {
  await transaction.provider_invocation_usage_facts.create({ data: {
    provider_attempt_id: input.billableInvocationRef,
    request_id: input.references.requestId,
    plan_subscription_id: input.references.planSubscriptionId,
    api_key_id: input.references.apiKeyId,
    user_id: input.references.userId,
    input_tokens: input.usage.inputTokens,
    cached_input_tokens: input.usage.cachedInputTokens,
    cache_write_tokens: input.usage.cacheWriteTokens,
    output_tokens: input.usage.outputTokens,
    total_tokens: input.usage.totalTokens,
    actual_charge_units: input.actualChargeUnits,
    usage_source: input.usage.source,
    price_snapshot_json: input.priceSnapshotJson,
    occurred_at: input.occurredAt,
    settled_at: input.settledAt,
    posting_ledger_event_id: input.postingLedgerEventId,
    billing_event_id: input.billingEventId,
  } });
}

async function createFinalBillingFacts(
  transaction: Prisma.TransactionClient,
  input: {
    billingEventId: string;
    attempt: InvocationBillingAttemptSnapshot;
    references: FinalBillingReferences;
    usage: InvocationUsageUnits;
    actualChargeUnits: bigint;
    providerCostUnits: bigint;
    grossMarginUnits: bigint;
    billablePriceTierKey: string;
    billablePriceSnapshotJson: string;
    providerCostTierKey: string;
    providerCostSnapshotJson: string;
    accessPointPrices: FrozenAccessPointPriceEvidence[];
  },
): Promise<void> {
  const createdAt = input.attempt.startedAt;
  await transaction.billing_events.create({ data: {
    id: input.billingEventId, request_id: input.references.requestId, billing_subscription_id: input.references.planSubscriptionId,
    billing_scope_ref: input.attempt.billingScopeRef, billable_price_id: input.attempt.billablePriceId,
    billable_price_source: input.attempt.billablePriceSource, billable_price_tier_key: input.billablePriceTierKey,
    operation_kind: "inference",
    provider_model_cost_id: input.attempt.providerModelCostId, provider_cost_tier_key: input.providerCostTierKey,
    input_tokens: input.usage.inputTokens, cached_input_tokens: input.usage.cachedInputTokens,
    cache_write_tokens: input.usage.cacheWriteTokens, output_tokens: input.usage.outputTokens, total_tokens: input.usage.totalTokens,
    billable_amount: unitsToCompatibilityUsd(input.actualChargeUnits), provider_cost_amount: unitsToCompatibilityUsd(input.providerCostUnits),
    gross_margin_amount: unitsToCompatibilityUsd(input.grossMarginUnits), billable_amount_units: input.actualChargeUnits,
    provider_cost_amount_units: input.providerCostUnits, gross_margin_amount_units: input.grossMarginUnits,
    usage_source: input.usage.source, billable_price_snapshot_json: input.billablePriceSnapshotJson,
    cost_price_snapshot_json: input.providerCostSnapshotJson, created_at: createdAt,
  } });
  await transaction.billing_history_refs.create({ data: {
    billing_event_id: input.billingEventId, request_id: input.references.requestId,
    billing_subscription_id: input.references.planSubscriptionId, billing_scope_ref: input.attempt.billingScopeRef,
    input_tokens: input.usage.inputTokens, cached_input_tokens: input.usage.cachedInputTokens,
    cache_write_tokens: input.usage.cacheWriteTokens, output_tokens: input.usage.outputTokens, total_tokens: input.usage.totalTokens,
    billable_amount: unitsToCompatibilityUsd(input.actualChargeUnits), provider_cost_amount: unitsToCompatibilityUsd(input.providerCostUnits),
    gross_margin_amount: unitsToCompatibilityUsd(input.grossMarginUnits), billable_amount_units: input.actualChargeUnits,
    provider_cost_amount_units: input.providerCostUnits, gross_margin_amount_units: input.grossMarginUnits,
    provider_model_cost_id: input.attempt.providerModelCostId, usage_source: input.usage.source,
    occurred_at: createdAt, archive_month: null, object_sha256: null, row_key: null, archived_at: null,
  } });
  await transaction.billing_provider_cost_events.create({ data: {
    id: createId("billing_provider_cost"), request_id: input.references.requestId, provider_attempt_id: input.attempt.billableInvocationRef,
    operation_kind: "inference", provider_owner_scope_ref: input.attempt.providerOwnerScopeRef,
    provider_id: input.attempt.providerId, provider_model_name: input.attempt.providerModelName,
    provider_model_cost_id: input.attempt.providerModelCostId, cost_tier_key: input.providerCostTierKey,
    cost_snapshot_json: input.providerCostSnapshotJson, input_tokens: input.usage.inputTokens,
    cached_input_tokens: input.usage.cachedInputTokens, cache_write_tokens: input.usage.cacheWriteTokens,
    output_tokens: input.usage.outputTokens, amount: unitsToCompatibilityUsd(input.providerCostUnits),
    amount_units: input.providerCostUnits, created_at: createdAt,
  } });
  for (const [index, frozen] of input.accessPointPrices.entries()) {
    const amountUnits = actualInvocationChargeUnits(input.usage, parseFrozenPriceUnits(frozen.snapshotJson));
    await transaction.billing_access_point_edges.create({ data: {
      id: createId("billing_ap_edge"), request_id: input.references.requestId, edge_order: index + 1, chain_index: index,
      buyer_scope_ref: frozen.buyerScopeRef, seller_scope_ref: frozen.sellerScopeRef,
      access_point_id: frozen.accessPointId, target_access_point_id: frozen.targetAccessPointId,
      is_internal: frozen.buyerScopeRef === frozen.sellerScopeRef ? 1 : 0, access_point_price_id: frozen.priceId,
      price_tier_key: frozen.tierKey, price_snapshot_json: frozen.snapshotJson,
      input_tokens: input.usage.inputTokens, cached_input_tokens: input.usage.cachedInputTokens,
      cache_write_tokens: input.usage.cacheWriteTokens, output_tokens: input.usage.outputTokens,
      amount: unitsToCompatibilityUsd(amountUnits), amount_units: amountUnits, created_at: createdAt,
    } });
  }
  const window = sellerSettlementWindow(input.attempt.subscriptionEffectiveStart, createdAt);
  if (input.attempt.planBillingMode === "paygo" && input.actualChargeUnits > 0n) {
    await insertSellerSettlement(transaction, input.billingEventId, input.references.planSubscriptionId, input.attempt.planSellerScopeRef, "revenue", input.actualChargeUnits, window, createdAt);
  }
  const entry = input.accessPointPrices[0];
  if (entry && entry.sellerScopeRef !== input.attempt.planSellerScopeRef) {
    const amountUnits = actualInvocationChargeUnits(input.usage, parseFrozenPriceUnits(entry.snapshotJson));
    if (amountUnits > 0n) await insertSellerSettlement(transaction, input.billingEventId, input.references.planSubscriptionId, input.attempt.planSellerScopeRef, "upstream_cost", amountUnits, window, createdAt);
  }
}

async function insertSellerSettlement(
  transaction: Prisma.TransactionClient,
  billingEventId: string,
  planSubscriptionId: string,
  sellerScopeRef: string,
  eventType: "revenue" | "upstream_cost",
  amountUnits: bigint,
  window: { start: string; end: string },
  createdAt: string,
): Promise<void> {
  await transaction.seller_settlement_events.create({ data: {
    id: createId("seller_settlement"), plan_subscription_id: planSubscriptionId, authority_purchase_id: null,
    seller_scope_ref: sellerScopeRef, window_start: window.start, window_end: window.end, release_at: window.end,
    event_type: eventType, amount_units: amountUnits, source_type: "billing_event", source_id: billingEventId, created_at: createdAt,
  } });
}

function sellerSettlementWindow(effectiveStart: string, occurredAt: string): { start: string; end: string } {
  const startMs = Date.parse(effectiveStart);
  const occurredMs = Date.parse(occurredAt);
  const sizeMs = 2_592_000_000;
  if (!Number.isFinite(startMs) || !Number.isFinite(occurredMs)) throw new RelayError("invalid_seller_settlement_window", "Seller settlement timestamps are invalid", 500);
  const index = Math.max(0, Math.floor((occurredMs - startMs) / sizeMs));
  return { start: new Date(startMs + index * sizeMs).toISOString(), end: new Date(startMs + (index + 1) * sizeMs).toISOString() };
}

function unitsToCompatibilityUsd(units: bigint): number {
  const value = Number(units) / 1_000_000;
  if (!Number.isSafeInteger(Number(units)) || !Number.isFinite(value)) throw new RelayError("invalid_credit_units", "USD units are outside legacy compatibility range", 500);
  return value;
}

async function lockCreditAccount(transaction: Prisma.TransactionClient, accountId: string): Promise<LockedCreditAccount | null> {
  const rows = await transaction.$queryRaw<Array<{ id: string; status: string; balanceSnapUnits: bigint }>>`
    SELECT "id", "status", "balance_snap_units" AS "balanceSnapUnits" FROM "credit_accounts" WHERE "id" = ${accountId} FOR UPDATE
  `;
  return rows[0] ?? null;
}

async function lockUserCreditAccountIfPresent(transaction: Prisma.TransactionClient, userId: string): Promise<LockedCreditAccount | null> {
  const rows = await transaction.$queryRaw<Array<{ id: string; status: string; balanceSnapUnits: bigint }>>`
    SELECT "id", "status", "balance_snap_units" AS "balanceSnapUnits" FROM "credit_accounts" WHERE "scope_ref" = ${`user:${userId}`} FOR UPDATE
  `;
  return rows[0] ?? null;
}

async function lockPaygoUser(transaction: Prisma.TransactionClient, userId: string): Promise<void> {
  const rows = await transaction.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "user_controls" WHERE "id" = ${userId} FOR UPDATE`;
  if (rows.length !== 1) throw new RelayError("request_execution_not_found", "Provider invocation user is unavailable", 409);
}

function boundedEvidenceIdentity(value: string): boolean {
  return value.length >= 1 && value.length <= 256;
}

function assertReleasedUsageIsZero(usage: InvocationUsageUnits): void {
  if (usage.inputTokens !== 0n || usage.cachedInputTokens !== 0n || usage.cacheWriteTokens !== 0n
    || usage.outputTokens !== 0n || usage.totalTokens !== 0n) {
    throw new RelayError("released_reservation_requires_zero_usage", "A released reservation requires authoritative zero usage", 409);
  }
}

function assertCacheWritePriceAvailable(usage: InvocationUsageUnits, snapshots: readonly string[]): void {
  if (usage.cacheWriteTokens <= 0n) return;
  if (snapshots.some((snapshot) => parseFrozenPriceUnits(snapshot).cacheWritePriceUnitsPer1M === null)) {
    throw new RelayError("unexpected_cache_write_usage", "Provider Cache write usage conflicts with a frozen Unavailable price dimension", 500);
  }
}

function fixedBudgetWindow(
  effectiveStart: string,
  effectiveEnd: string | null,
  windowType: string,
  windowSeconds: number | null,
  occurredAt: string,
): { start: string; end: string } {
  if (windowType === "cumulative") return { start: effectiveStart, end: effectiveEnd ?? "9999-12-31T23:59:59.999Z" };
  if (!windowSeconds || windowSeconds <= 0) throw new RelayError("invalid_budget_window", "Fixed budget window is invalid", 500);
  const base = Date.parse(effectiveStart);
  const occurred = Date.parse(occurredAt);
  const size = windowSeconds * 1_000;
  const index = Math.max(0, Math.floor((occurred - base) / size));
  return { start: new Date(base + index * size).toISOString(), end: new Date(base + (index + 1) * size).toISOString() };
}
