import { createId, nowIso, RelayError } from "@frely/core";
import { PrismaAuditEventAppender, type AuditEventAppender } from "@frely/audit/application-internal";
import type { AccessPointTargetsRow } from "../application-model-contracts.js";
import { Prisma, type PrismaTransactionOwner } from "@frely/postgres/server";
import { USD_UNITS_PER_CREDIT } from "../money-units.js";
import type {
  AccessPointPriceParts,
  BillingAuditInput,
  BillingCommands,
  ConfigureInitialAccessPointPriceCommand,
  InitialAccessPointPriceInput,
  InitialAccessPointPriceResult,
  InitialAccessPointPriceTierInput,
} from "./contracts.js";

export class BillingCommandService implements BillingCommands {
  constructor(
    private readonly transactions: PrismaTransactionOwner,
    private readonly auditAppender: AuditEventAppender = new PrismaAuditEventAppender(),
  ) {}

  configureInitialAccessPointPrice(id: string, command: ConfigureInitialAccessPointPriceCommand, audit: BillingAuditInput): Promise<InitialAccessPointPriceResult> {
    return this.transactions.withPrismaTransaction((transaction) => configureInitialAccessPointPrice(transaction, id, command, audit, this.auditAppender));
  }
}

export async function configureInitialAccessPointPrice(
  transaction: Prisma.TransactionClient,
  accessPointId: string,
  command: ConfigureInitialAccessPointPriceCommand,
  audit: BillingAuditInput,
  auditAppender: AuditEventAppender = new PrismaAuditEventAppender(),
): Promise<InitialAccessPointPriceResult> {
  await lockAccessPoint(transaction, accessPointId);
  const accessPoint = await transaction.accessPoint.findUnique({ where: { id: accessPointId }, include: { targets: { where: { removedAt: null, status: "enabled" }, orderBy: [{ position: "asc" }, { id: "asc" }] } } });
  if (!accessPoint || accessPoint.removedAt) throw new RelayError("access_point_not_found", `AccessPoint ${accessPointId} not found`, 404);
  if (accessPoint.status !== "disabled") throw new RelayError("access_point_initial_price_requires_disabled", "Initial AccessPoint price can be configured only while the AccessPoint is disabled", 409);
  const existing = await transaction.access_point_prices.findFirst({ where: { access_point_id: accessPointId, initial_price: 1 }, orderBy: [{ created_at: "asc" }, { id: "asc" }] });
  if (existing) return { accessPointId, priceId: existing.id, replayed: true };

  const price = command.price ?? await copyInitialPriceFromTarget(transaction, accessPoint.targets[0]);
  const normalized = normalizeInitialPrice(price);
  const now = nowIso();
  const priceId = createId("access_price");
  await transaction.access_point_prices.create({ data: {
    id: priceId,
    access_point_id: accessPointId,
    ...priceColumns(normalized),
    status: "enabled",
    initial_price: 1,
    created_at: now,
    updated_at: now,
  } });
  for (const tier of normalized.tiers) {
    await transaction.access_point_price_tiers.create({ data: {
      id: createId("access_price_tier"),
      access_point_price_id: priceId,
      service_tier: tier.serviceTier,
      tier_key: tier.tierKey,
      min_input_tokens: BigInt(tier.minInputTokens),
      max_input_tokens: tier.maxInputTokens === null ? null : BigInt(tier.maxInputTokens),
      ...priceColumns(tier),
      status: "enabled",
      created_at: now,
      updated_at: now,
    } });
  }
  await auditAppender.append(transaction, {
    ...audit,
    action: "access_point_price.create",
    resourceType: "access_point_price",
    resourceId: priceId,
    result: "success",
    metadata: { accessPointId, priceSource: command.price ? "explicit" : "target_copy", tierCount: normalized.tiers.length },
  });
  return { accessPointId, priceId, replayed: false };
}

async function lockAccessPoint(transaction: Prisma.TransactionClient, id: string): Promise<void> {
  const rows = await transaction.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "access_points" WHERE "id" = ${id} FOR UPDATE`;
  if (rows.length === 0) throw new RelayError("access_point_not_found", `AccessPoint ${id} not found`, 404);
}

async function copyInitialPriceFromTarget(
  transaction: Prisma.TransactionClient,
  target: AccessPointTargetsRow | undefined,
): Promise<InitialAccessPointPriceInput> {
  if (!target) throw new RelayError("access_point_initial_price_source_missing", "AccessPoint has no enabled target from which to copy an initial price", 409);
  if (target.targetType === "access-point") {
    const source = await transaction.access_point_prices.findFirst({
      where: { access_point_id: target.targetAccessPointId!, status: "enabled" },
      include: { access_point_price_tiers: { where: { status: "enabled" }, orderBy: [{ service_tier: "asc" }, { min_input_tokens: "asc" }, { tier_key: "asc" }] } },
      orderBy: [{ created_at: "desc" }, { id: "desc" }],
    });
    if (!source) throw new RelayError("access_point_price_not_configured", "Target AccessPoint has no enabled price to copy", 409);
    return priceInputFromRow(source, source.access_point_price_tiers);
  }
  const source = await transaction.provider_model_costs.findFirst({
    where: { provider_id: target.targetProviderId!, provider_model_name: target.targetProviderModelName!, status: "enabled" },
    include: { provider_model_cost_tiers: { where: { status: "enabled" }, orderBy: [{ service_tier: "asc" }, { min_input_tokens: "asc" }, { tier_key: "asc" }] } },
    orderBy: [{ created_at: "desc" }, { id: "desc" }],
  });
  if (!source) throw new RelayError("provider_model_cost_not_configured", "Target ProviderModel has no enabled cost to copy", 409);
  return priceInputFromRow(source, source.provider_model_cost_tiers);
}

function priceInputFromRow(
  row: { input_per_1m: number; cached_input_per_1m: number; cache_write_per_1m: number | null; output_per_1m: number },
  tiers: Array<{ service_tier: string; tier_key: string; min_input_tokens: bigint; max_input_tokens: bigint | null; input_per_1m: number; cached_input_per_1m: number; cache_write_per_1m: number | null; output_per_1m: number }>,
): InitialAccessPointPriceInput {
  return {
    inputPer1M: row.input_per_1m,
    cachedInputPer1M: row.cached_input_per_1m,
    cacheWritePer1M: row.cache_write_per_1m,
    outputPer1M: row.output_per_1m,
    tiers: tiers.map((tier) => ({
      serviceTier: tier.service_tier,
      tierKey: tier.tier_key,
      minInputTokens: safeBigIntNumber(tier.min_input_tokens, "minInputTokens"),
      maxInputTokens: tier.max_input_tokens === null ? null : safeBigIntNumber(tier.max_input_tokens, "maxInputTokens"),
      inputPer1M: tier.input_per_1m,
      cachedInputPer1M: tier.cached_input_per_1m,
      cacheWritePer1M: tier.cache_write_per_1m,
      outputPer1M: tier.output_per_1m,
    })),
  };
}

function normalizeInitialPrice(input: InitialAccessPointPriceInput): AccessPointPriceParts & { cacheWritePer1M: number | null; tiers: Array<AccessPointPriceParts & { cacheWritePer1M: number | null; maxInputTokens: number | null; minInputTokens: number; serviceTier: string; tierKey: string }> } {
  const base = normalizePriceParts(input, "price");
  const seen = new Set<string>();
  const tiers = (input.tiers ?? []).map((tier, index) => {
    const serviceTier = String(tier.serviceTier ?? "standard").trim();
    const tierKey = String(tier.tierKey ?? (tier.minInputTokens <= 0 ? "short_context" : "long_context")).trim();
    const minInputTokens = tier.minInputTokens;
    const maxInputTokens = tier.maxInputTokens ?? null;
    if (!["standard", "batch", "flex", "priority"].includes(serviceTier) || !/^[a-z][a-z0-9_]{1,63}$/u.test(tierKey)
      || !Number.isSafeInteger(minInputTokens) || minInputTokens < 0
      || (maxInputTokens !== null && (!Number.isSafeInteger(maxInputTokens) || maxInputTokens < minInputTokens))) {
      throw new RelayError("invalid_access_point_price_tier", `Price tier ${index} is invalid`, 400);
    }
    const identity = `${serviceTier}:${tierKey}`;
    if (seen.has(identity)) throw new RelayError("invalid_access_point_price_tier", `Duplicate price tier ${identity}`, 400);
    seen.add(identity);
    return { ...normalizePriceParts(tier, `tiers[${index}]`), serviceTier, tierKey, minInputTokens, maxInputTokens };
  });
  return { ...base, tiers };
}

function normalizePriceParts(input: AccessPointPriceParts, field: string) {
  const requiredPrice = (value: unknown, name: string): number => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || !Number.isSafeInteger(Math.round(value * Number(USD_UNITS_PER_CREDIT)))) {
      throw new RelayError("invalid_access_point_price", `${field}.${name} must be a finite non-negative USD value within the BIGINT units range`, 400);
    }
    return value;
  };
  const inputPer1M = requiredPrice(input.inputPer1M, "inputPer1M");
  return {
    inputPer1M,
    cachedInputPer1M: requiredPrice(input.cachedInputPer1M, "cachedInputPer1M"),
    cacheWritePer1M: input.cacheWritePer1M === null ? null : requiredPrice(input.cacheWritePer1M ?? inputPer1M, "cacheWritePer1M"),
    outputPer1M: requiredPrice(input.outputPer1M, "outputPer1M"),
  };
}

function priceColumns(price: { inputPer1M: number; cachedInputPer1M: number; cacheWritePer1M: number | null; outputPer1M: number }) {
  const units = (value: number): bigint => BigInt(Math.round(value * Number(USD_UNITS_PER_CREDIT)));
  return {
    input_per_1m: price.inputPer1M,
    cached_input_per_1m: price.cachedInputPer1M,
    cache_write_per_1m: price.cacheWritePer1M,
    output_per_1m: price.outputPer1M,
    input_price_units_per_1m: units(price.inputPer1M),
    cached_input_price_units_per_1m: units(price.cachedInputPer1M),
    cache_write_price_units_per_1m: price.cacheWritePer1M === null ? null : units(price.cacheWritePer1M),
    output_price_units_per_1m: units(price.outputPer1M),
  };
}

function safeBigIntNumber(value: bigint, field: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new RelayError("invalid_access_point_price_tier", `${field} is outside the supported integer range`, 500);
  return result;
}
