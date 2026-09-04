import { formatUtcDateTime } from "@frely/ui/lib/date-time";

type Tone = "good" | "warn" | "bad" | "neutral" | "info";
type DurationUnit = "seconds" | "hours" | "days" | "years";
type WindowUnit = "seconds" | "hours" | "days";
type BudgetLimitScope = "subscription" | "user";

interface BudgetPolicy {
  id: string;
  metric: string;
  limitValue: number;
  windowType: "fixed" | "cumulative";
  windowSeconds: number | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

interface AccessPointSummary {
  id: string;
  ownerId: string;
  scopeRef: string;
  name: string;
  description: string | null;
  apiFamily: string;
  exposedModel: string;
  status: string;
  basePrice?: PriceSummary | null;
  effectivePrice?: EffectivePriceSummary | null;
}

interface PriceSummary {
  id: string;
  inputPer1M: number;
  cachedInputPer1M: number;
  cacheWritePer1M: number | null;
  outputPer1M: number;
  tiers?: PriceTierSummary[];
}

interface PriceTierSummary {
  serviceTier?: string;
  tierKey: string;
  minInputTokens: number;
  maxInputTokens: number | null;
  inputPer1M: number;
  cachedInputPer1M: number;
  cacheWritePer1M: number | null;
  outputPer1M: number;
  status: string;
}

interface EffectivePriceSummary {
  source: "access_point" | "plan_access_point";
  price: PriceSummary;
  basePrice: PriceSummary | null;
  planAccessPointPrice: PriceSummary | null;
}

interface PlanTemplate {
  id: string;
  ownerId: string;
  scopeRef: string;
  name: string;
  version: number;
  description: string | null;
  adminNote: string | null;
  billingMode: "prepaid" | "paygo";
  purchaseAmount: number;
  durationSeconds: number;
  status: string;
  catalogStatus: "listed" | "unlisted";
  createdAt: string;
  updatedAt: string;
  budgetLimits: PlanBudgetLimit[];
  accessPoints: AccessPointSummary[];
}

interface PlanBudgetLimit {
  limitScope: BudgetLimitScope;
  metric: "tokens" | "amount";
  limitValue: number;
  windowType: "fixed" | "cumulative";
  windowSeconds: number | null;
}

export interface BudgetLimitDraft {
  localId: string;
  metric: string;
  limitValue: string;
  windowType: string;
  windowValue: string;
  windowUnit: WindowUnit;
  limitScope: BudgetLimitScope;
}

export interface PriceDraft {
  multiplier: string;
}

export interface TemplateDraft {
  name: string;
  description: string;
  adminNote: string;
  billingMode: "prepaid" | "paygo";
  purchaseAmount: string;
  catalogStatus: "listed" | "unlisted";
  noDurationLimit: boolean;
  durationValue: string;
  durationUnit: DurationUnit;
  budgetLimits: BudgetLimitDraft[];
  accessPointIds: string[];
  accessPointPriceDrafts: Record<string, PriceDraft>;
}

interface PlanBudgetLimitPayload {
  metric: "tokens" | "amount";
  limitValue: number;
  windowType: "fixed" | "cumulative";
  windowSeconds: number | null;
  limitScope: BudgetLimitScope;
}

export interface TokenLimitPreviewItem {
  sourceIndex: number;
  windowType: "fixed" | "cumulative";
  label: string;
}

export interface PlanTokenLimitPreview {
  userLimits: TokenLimitPreviewItem[];
  subscriptionLimits: TokenLimitPreviewItem[];
  incompleteRuleIndexes: number[];
}

interface PlanAccessPointPriceDraftPayload {
  accessPointId: string;
  inputPer1M: number;
  cachedInputPer1M: number;
  cacheWritePer1M: number | null;
  outputPer1M: number;
  tiers: PlanAccessPointPriceTierPayload[];
}

interface EditedPlanVersionDraft {
  description: string;
  adminNote: string;
  budgetLimits: BudgetLimitDraft[];
  accessPointIds: string[];
}

interface PlanAccessPointPriceTierPayload {
  serviceTier?: string;
  tierKey: string;
  minInputTokens: number;
  maxInputTokens: number | null;
  inputPer1M: number;
  cachedInputPer1M: number;
  cacheWritePer1M: number | null;
  outputPer1M: number;
}


export function defaultTemplateDraft(): TemplateDraft {
  return {
    name: "Annual Team Plan",
    description: "",
    adminNote: "",
    billingMode: "prepaid",
    purchaseAmount: "0",
    catalogStatus: "unlisted",
    noDurationLimit: false,
    durationValue: "1",
    durationUnit: "years",
    budgetLimits: [],
    accessPointIds: [],
    accessPointPriceDrafts: {},
  };
}

export function templateDraftFromTemplate(template: PlanTemplate): TemplateDraft {
  const durationDraft = durationDraftFromSeconds(template.durationSeconds);
  return {
    name: template.name,
    description: template.description ?? "",
    adminNote: template.adminNote ?? "",
    billingMode: template.billingMode,
    purchaseAmount: String(template.purchaseAmount),
    catalogStatus: "unlisted",
    noDurationLimit: isNoLimitPayGoTemplate(template),
    durationValue: durationDraft.value,
    durationUnit: durationDraft.unit,
    budgetLimits: budgetLimitDraftsFromTemplate(template),
    accessPointIds: template.accessPoints.map((accessPoint) => accessPoint.id),
    accessPointPriceDrafts: copyPriceDraftsFromTemplate(template),
  };
}

export function defaultBudgetLimitDraft(localId: string): BudgetLimitDraft {
  return { localId, metric: "amount", limitValue: "", windowType: "fixed", windowValue: "4", windowUnit: "hours", limitScope: "subscription" };
}

export function validateBudgetLimits(limits: BudgetLimitDraft[]): { ok: true; payloads: PlanBudgetLimitPayload[] } | { ok: false; message: string } {
  const payloads: PlanBudgetLimitPayload[] = [];
  const seen = new Set<string>();
  for (const [index, limit] of limits.entries()) {
    const limitValue = Number(limit.limitValue);
    const windowSeconds = limit.windowType === "fixed" ? secondsFromDraft(limit.windowValue, limit.windowUnit) : null;
    if (limit.metric !== "tokens" && limit.metric !== "amount") return { ok: false, message: `Limit ${index + 1}: metric must be tokens or amount.` };
    if (limit.windowType !== "fixed" && limit.windowType !== "cumulative") return { ok: false, message: `Limit ${index + 1}: window type must be fixed or cumulative.` };
    if (!Number.isFinite(limitValue) || limitValue <= 0) return { ok: false, message: `Limit ${index + 1}: limit must be a positive number.` };
    if (limit.metric === "tokens" && !Number.isSafeInteger(limitValue)) return { ok: false, message: `Limit ${index + 1}: token limit must be a positive integer.` };
    if (limit.windowType === "fixed" && (!Number.isSafeInteger(windowSeconds) || Number(windowSeconds) <= 0)) return { ok: false, message: `Limit ${index + 1}: fixed window must be a positive whole number of seconds.` };
    const payload: PlanBudgetLimitPayload = {
      metric: limit.metric,
      limitValue,
      windowType: limit.windowType,
      windowSeconds,
      limitScope: limit.limitScope
    };
    const key = budgetLimitKey(payload);
    if (seen.has(key)) continue;
    seen.add(key);
    payloads.push({
      ...payload
    });
  }
  return { ok: true, payloads };
}

export function budgetLimitLabel(limit: PlanBudgetLimit) {
  return `${limitScopeLabel(limit.limitScope)}: ${policyLabel(limit)}`;
}

export function limitScopeLabel(limitScope: BudgetLimitScope) {
  return limitScope === "subscription" ? "Subscription limits" : "User limits";
}

export function policyLabel(policy: Pick<BudgetPolicy, "metric" | "limitValue" | "windowType" | "windowSeconds">) {
  const limit = policyLimitLabel(policy);
  const window = policy.windowType === "fixed" ? `${formatDuration(policy.windowSeconds ?? 0)} fixed reset` : "plan cumulative";
  return `${titleCase(policy.metric)} - ${limit} - ${window}`;
}

export function policyLimitLabel(policy: Pick<BudgetPolicy, "metric" | "limitValue">) {
  return policy.metric === "amount" ? formatCurrency(policy.limitValue) : `${policy.limitValue.toLocaleString("en-US")} tokens`;
}

// REQ-GA-005: explain the token limits configured by the current create/copy draft
// without inventing Subscription usage, Team size, or amount-to-token estimates.
export function buildPlanTokenLimitPreview(input: {
  budgetLimits: BudgetLimitDraft[];
}): PlanTokenLimitPreview {
  const userLimits: TokenLimitPreviewItem[] = [];
  const subscriptionLimits: TokenLimitPreviewItem[] = [];
  const incompleteRuleIndexes: number[] = [];

  const addLimit = (limitScope: BudgetLimitScope, item: TokenLimitPreviewItem) => {
    (limitScope === "user" ? userLimits : subscriptionLimits).push(item);
  };

  for (const [limitIndex, limit] of input.budgetLimits.entries()) {
    if (limit.metric !== "tokens") continue;
    const limitValue = Number(limit.limitValue);
    const windowSeconds = limit.windowType === "fixed" ? secondsFromDraft(limit.windowValue, limit.windowUnit) : null;
    const hasCompleteDraft = limit.limitValue.trim().length > 0
      && (limit.windowType !== "fixed" || limit.windowValue.trim().length > 0);
    if (!hasCompleteDraft || !isPreviewableTokenLimit(limitValue, limit.windowType, windowSeconds)) {
      incompleteRuleIndexes.push(limitIndex);
      continue;
    }
    addLimit(limit.limitScope, {
      sourceIndex: limitIndex,
      windowType: normalizePreviewWindowType(limit.windowType),
      label: tokenLimitPreviewLabel(limitValue, limit.windowType, windowSeconds)
    });
  }

  const byWindowThenSource = (left: TokenLimitPreviewItem, right: TokenLimitPreviewItem) => {
    const windowOrder = (item: TokenLimitPreviewItem) => item.windowType === "fixed" ? 0 : 1;
    return windowOrder(left) - windowOrder(right);
  };
  userLimits.sort(byWindowThenSource);
  subscriptionLimits.sort(byWindowThenSource);

  return { userLimits, subscriptionLimits, incompleteRuleIndexes };
}

function normalizePreviewWindowType(windowType: string): "fixed" | "cumulative" {
  return windowType === "fixed" ? "fixed" : "cumulative";
}

function isPreviewableTokenLimit(limitValue: number, windowType: string, windowSeconds: number | null): boolean {
  if (!Number.isFinite(limitValue) || limitValue <= 0) return false;
  return windowType !== "fixed" || (Number.isFinite(windowSeconds) && Number(windowSeconds) > 0);
}

function tokenLimitPreviewLabel(limitValue: number, windowType: string, windowSeconds: number | null): string {
  const limit = `${limitValue.toLocaleString("en-US")} tokens`;
  return windowType === "fixed"
    ? `${limit} / fixed ${formatDuration(Number(windowSeconds))}`
    : `${limit} / Plan lifecycle`;
}

export function budgetLimitPreview(policy: BudgetLimitDraft) {
  const limitValue = Number(policy.limitValue);
  const limit = Number.isFinite(limitValue)
    ? policy.metric === "amount" ? formatCurrency(limitValue) : `${limitValue.toLocaleString("en-US")} tokens`
    : "Set a limit";
  const windowSeconds = policy.windowType === "fixed" ? secondsFromDraft(policy.windowValue, policy.windowUnit) : null;
  const window = windowSeconds !== null && Number.isFinite(windowSeconds) ? formatDuration(windowSeconds) : "plan cumulative";
  return `${titleCase(policy.metric)} - ${limit} - ${window}`;
}

export function truncateText(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

export function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}

export function normalizeLimitScope(value: string): BudgetLimitScope {
  return value === "user" ? "user" : "subscription";
}

export function sameBudgetLimits(left: BudgetLimitDraft[], right: BudgetLimitDraft[]) {
  const leftResult = validateBudgetLimits(left);
  const rightResult = validateBudgetLimits(right);
  if (!leftResult.ok || !rightResult.ok) return false;
  const leftKeys = leftResult.payloads.map(budgetLimitKey).sort();
  const rightKeys = rightResult.payloads.map(budgetLimitKey).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index]);
}

function budgetLimitKey(limit: PlanBudgetLimitPayload) {
  return JSON.stringify([limit.limitScope, limit.metric, limit.limitValue, limit.windowType, limit.windowSeconds]);
}

export function budgetLimitDraftsFromTemplate(template: PlanTemplate): BudgetLimitDraft[] {
  return template.budgetLimits.map((limit, index) => {
    const window = durationDraftFromSeconds(limit.windowSeconds ?? 14_400);
    const windowUnit = window.unit === "years" ? "days" : window.unit;
    const windowValue = window.unit === "years" ? String(Number(window.value) * 365) : window.value;
    return { localId: `limit-${index}`, metric: limit.metric, limitValue: String(limit.limitValue), windowType: limit.windowType, windowValue, windowUnit, limitScope: limit.limitScope };
  });
}

export function omitRecordKey<T>(record: Record<string, T>, key: string) {
  const next = { ...record };
  delete next[key];
  return next;
}

export function sameStringSet(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

export function emptyPriceDraft(): PriceDraft {
  return { multiplier: "" };
}

export function priceDraftsFromTemplate(template: PlanTemplate): Record<string, PriceDraft> {
  return Object.fromEntries(template.accessPoints.map((accessPoint) => [accessPoint.id, emptyPriceDraft()]));
}

export function copyPriceDraftsFromTemplate(template: PlanTemplate): Record<string, PriceDraft> {
  return Object.fromEntries(template.accessPoints.map((accessPoint) => [accessPoint.id, { multiplier: copiedPriceMultiplier(accessPoint) ?? "" }]));
}

export function copiedPriceMultiplier(accessPoint: AccessPointSummary): string | null {
  const planPrice = accessPoint.effectivePrice?.planAccessPointPrice ?? null;
  const basePrice = accessPoint.effectivePrice?.basePrice ?? accessPoint.basePrice ?? null;
  if (!planPrice || !basePrice) return null;
  const ratios: number[] = [];
  for (const field of ["inputPer1M", "cachedInputPer1M", "cacheWritePer1M", "outputPer1M"] as const) {
    const base = basePrice[field];
    const override = planPrice[field];
    if (base === null || override === null) {
      if (base !== override) return null;
      continue;
    }
    if (base === 0) {
      if (!nearlyEqual(override, 0)) return null;
      continue;
    }
    ratios.push(override / base);
  }
  if (ratios.length === 0) return "1";
  const first = ratios[0]!;
  if (!ratios.every((ratio) => nearlyEqual(ratio, first))) return null;
  return String(Number(first.toPrecision(12)));
}

export function validateTemplatePriceDrafts(template: PlanTemplate | null, selectedAccessPointIds: string[], drafts: Record<string, PriceDraft>, accessPoints: AccessPointSummary[]): { ok: true; payloads: PlanAccessPointPriceDraftPayload[] } | { ok: false; message: string } {
  const payloads: PlanAccessPointPriceDraftPayload[] = [];
  const accessPointById = new Map(accessPoints.map((accessPoint) => [accessPoint.id, accessPoint]));
  for (const accessPointId of selectedAccessPointIds) {
    const draft = drafts[accessPointId] ?? emptyPriceDraft();
    if (priceDraftIsEmpty(draft)) continue;
    const multiplier = parsePriceMultiplierDraft(draft);
    if (multiplier === null) return { ok: false, message: `AccessPoint ${accessPointId}: multiplier must be a finite non-negative number.` };
    const accessPoint = template?.accessPoints.find((candidate) => candidate.id === accessPointId) ?? accessPointById.get(accessPointId);
    const basePrice = accessPoint ? priceMultiplierBase(accessPoint) : null;
    if (!basePrice) return { ok: false, message: `AccessPoint ${accessPointId}: a base or effective price is required before applying a multiplier.` };
    const parsed = multiplyPrice(basePrice, multiplier);
    const currentPlanPrice = accessPoint?.effectivePrice?.planAccessPointPrice ?? null;
    if (currentPlanPrice && pricesEqual(currentPlanPrice, parsed)) continue;
    const payload = { accessPointId, ...parsed };
    const profileError = validatePriceProfile(payload);
    if (profileError) return { ok: false, message: `AccessPoint ${accessPointId}: ${profileError}` };
    payloads.push(payload);
  }
  return { ok: true, payloads };
}

export function buildCopiedPlanPriceOverrides(sourceTemplate: PlanTemplate, selectedAccessPointIds: string[], drafts: Record<string, PriceDraft>, accessPoints: AccessPointSummary[]): { ok: true; payloads: PlanAccessPointPriceDraftPayload[] } | { ok: false; message: string } {
  const payloads: PlanAccessPointPriceDraftPayload[] = [];
  const sourceAccessPointById = new Map(sourceTemplate.accessPoints.map((accessPoint) => [accessPoint.id, accessPoint]));
  const accessPointById = new Map(accessPoints.map((accessPoint) => [accessPoint.id, accessPoint]));
  const addedAccessPointIds: string[] = [];

  for (const accessPointId of selectedAccessPointIds) {
    const sourceAccessPoint = sourceAccessPointById.get(accessPointId);
    if (!sourceAccessPoint) {
      addedAccessPointIds.push(accessPointId);
      continue;
    }

    const draft = drafts[accessPointId] ?? emptyPriceDraft();
    const initialDraft = copyPriceDraftFromAccessPoint(sourceAccessPoint);
    if (samePriceDraft(draft, initialDraft)) {
      const sourceOverride = sourceAccessPoint.effectivePrice?.planAccessPointPrice ?? null;
      if (!sourceOverride) continue;
      const payload = { accessPointId, ...copyPriceProfile(sourceOverride) };
      const profileError = validatePriceProfile(payload);
      if (profileError) return { ok: false, message: `AccessPoint ${accessPointId}: ${profileError}` };
      payloads.push(payload);
      continue;
    }

    if (priceDraftIsEmpty(draft)) continue;
    const multiplier = parsePriceMultiplierDraft(draft);
    if (multiplier === null) return { ok: false, message: `AccessPoint ${accessPointId}: multiplier must be a finite non-negative number.` };
    const basePrice = sourceAccessPoint.effectivePrice?.basePrice ?? sourceAccessPoint.basePrice ?? accessPointById.get(accessPointId)?.basePrice ?? null;
    if (!basePrice) return { ok: false, message: `AccessPoint ${accessPointId}: a base or effective price is required before applying a multiplier.` };
    const payload = { accessPointId, ...multiplyPrice(basePrice, multiplier) };
    const profileError = validatePriceProfile(payload);
    if (profileError) return { ok: false, message: `AccessPoint ${accessPointId}: ${profileError}` };
    payloads.push(payload);
  }

  const addedValidation = validateTemplatePriceDrafts(null, addedAccessPointIds, drafts, accessPoints);
  if (!addedValidation.ok) return addedValidation;
  return { ok: true, payloads: [...payloads, ...addedValidation.payloads] };
}

export function buildEditedPlanVersionPriceOverrides(sourceTemplate: PlanTemplate, selectedAccessPointIds: string[], drafts: Record<string, PriceDraft>, accessPoints: AccessPointSummary[]): { ok: true; payloads: PlanAccessPointPriceDraftPayload[] } | { ok: false; message: string } {
  const payloads: PlanAccessPointPriceDraftPayload[] = [];
  const sourceAccessPointById = new Map(sourceTemplate.accessPoints.map((accessPoint) => [accessPoint.id, accessPoint]));
  const addedAccessPointIds: string[] = [];

  for (const accessPointId of selectedAccessPointIds) {
    const sourceAccessPoint = sourceAccessPointById.get(accessPointId);
    if (!sourceAccessPoint) {
      addedAccessPointIds.push(accessPointId);
      continue;
    }

    const draft = drafts[accessPointId] ?? emptyPriceDraft();
    if (priceDraftIsEmpty(draft)) {
      const sourceOverride = sourceAccessPoint.effectivePrice?.planAccessPointPrice ?? null;
      if (!sourceOverride) continue;
      const payload = { accessPointId, ...copyPriceProfile(sourceOverride) };
      const profileError = validatePriceProfile(payload);
      if (profileError) return { ok: false, message: `AccessPoint ${accessPointId}: ${profileError}` };
      payloads.push(payload);
      continue;
    }

    const multiplier = parsePriceMultiplierDraft(draft);
    if (multiplier === null) return { ok: false, message: `AccessPoint ${accessPointId}: multiplier must be a finite non-negative number.` };
    const effectivePrice = priceMultiplierBase(sourceAccessPoint);
    if (!effectivePrice) return { ok: false, message: `AccessPoint ${accessPointId}: a current effective price is required before applying a multiplier.` };
    const payload = { accessPointId, ...multiplyPrice(effectivePrice, multiplier) };
    const profileError = validatePriceProfile(payload);
    if (profileError) return { ok: false, message: `AccessPoint ${accessPointId}: ${profileError}` };
    payloads.push(payload);
  }

  const addedValidation = validateTemplatePriceDrafts(null, addedAccessPointIds, drafts, accessPoints);
  if (!addedValidation.ok) return addedValidation;
  return { ok: true, payloads: [...payloads, ...addedValidation.payloads] };
}

export function buildEditedPlanVersionCreateInput(sourceTemplate: PlanTemplate, draft: EditedPlanVersionDraft, accessPointPriceOverrides: PlanAccessPointPriceDraftPayload[]) {
  const validatedLimits = validateBudgetLimits(draft.budgetLimits);
  if (!validatedLimits.ok) throw new Error(validatedLimits.message);
  return {
    ownerId: sourceTemplate.ownerId,
    scopeRef: sourceTemplate.scopeRef,
    name: sourceTemplate.name,
    description: draft.description.trim(),
    adminNote: draft.adminNote.trim(),
    billingMode: sourceTemplate.billingMode,
    purchaseAmount: sourceTemplate.purchaseAmount,
    durationSeconds: sourceTemplate.durationSeconds,
    catalogStatus: "unlisted" as const,
    budgetLimits: validatedLimits.payloads,
    accessPointIds: uniqueStrings(draft.accessPointIds),
    accessPointPriceOverrides
  };
}

export const PLAN_VERSION_CONFIRM_TITLE = "Create a new version?";

export function shouldOfferPlanVersionCreation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "sold_plan_terms_immutable");
}

export function planCreateDialogPresentation(sourceTemplate: Pick<PlanTemplate, "name" | "version"> | null) {
  if (sourceTemplate) {
    return {
      title: "Create from copy",
      description: `Copy ${sourceTemplate.name} v${sourceTemplate.version} to create a similar Plan`,
      submitLabel: "Create copy",
      nameReadOnly: false
    } as const;
  }
  return {
    title: "Create Plan",
    description: "Create a Plan from a blank configuration",
    submitLabel: "Create Plan",
    nameReadOnly: false
  } as const;
}

function samePriceDraft(left: PriceDraft, right: PriceDraft): boolean {
  const leftValue = left.multiplier.trim();
  const rightValue = right.multiplier.trim();
  if (leftValue === rightValue) return true;
  if (!leftValue || !rightValue) return false;
  const leftNumber = Number(leftValue);
  const rightNumber = Number(rightValue);
  return Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && nearlyEqual(leftNumber, rightNumber);
}

export function hasTemplatePriceDraftChanges(template: PlanTemplate, selectedAccessPointIds: string[], drafts: Record<string, PriceDraft>) {
  const validation = validateTemplatePriceDrafts(template, selectedAccessPointIds, drafts, template.accessPoints);
  return validation.ok ? validation.payloads.length > 0 : true;
}

export function priceDraftIsEmpty(draft: PriceDraft) {
  return !draft.multiplier.trim();
}

export function parsePriceMultiplierDraft(draft: PriceDraft): number | null {
  const multiplier = Number(draft.multiplier);
  return Number.isFinite(multiplier) && multiplier >= 0 ? multiplier : null;
}

export function priceMultiplierBase(accessPoint: AccessPointSummary): PriceSummary | null {
  return accessPoint.effectivePrice?.price ?? accessPoint.basePrice ?? null;
}

export function multiplyPrice(price: PriceSummary, multiplier: number): Omit<PlanAccessPointPriceDraftPayload, "accessPointId"> {
  return {
    inputPer1M: price.inputPer1M * multiplier,
    cachedInputPer1M: price.cachedInputPer1M * multiplier,
    cacheWritePer1M: price.cacheWritePer1M === null ? null : price.cacheWritePer1M * multiplier,
    outputPer1M: price.outputPer1M * multiplier,
    tiers: enabledPriceTiers(price).map((tier) => ({
      ...copyPriceTier(tier),
      inputPer1M: tier.inputPer1M * multiplier,
      cachedInputPer1M: tier.cachedInputPer1M * multiplier,
      cacheWritePer1M: tier.cacheWritePer1M === null ? null : tier.cacheWritePer1M * multiplier,
      outputPer1M: tier.outputPer1M * multiplier
    }))
  };
}

function copyPriceDraftFromAccessPoint(accessPoint: AccessPointSummary): PriceDraft {
  return { multiplier: copiedPriceMultiplier(accessPoint) ?? "" };
}

function copyPriceProfile(price: PriceSummary): Omit<PlanAccessPointPriceDraftPayload, "accessPointId"> {
  return {
    inputPer1M: price.inputPer1M,
    cachedInputPer1M: price.cachedInputPer1M,
    cacheWritePer1M: price.cacheWritePer1M,
    outputPer1M: price.outputPer1M,
    tiers: enabledPriceTiers(price).map(copyPriceTier)
  };
}

function enabledPriceTiers(price: PriceSummary): PriceTierSummary[] {
  return price.tiers?.filter((tier) => tier.status === "enabled") ?? [];
}

function copyPriceTier(tier: PriceTierSummary): PlanAccessPointPriceTierPayload {
  return {
    ...(tier.serviceTier ? { serviceTier: tier.serviceTier } : {}),
    tierKey: tier.tierKey,
    minInputTokens: tier.minInputTokens,
    maxInputTokens: tier.maxInputTokens,
    inputPer1M: tier.inputPer1M,
    cachedInputPer1M: tier.cachedInputPer1M,
    cacheWritePer1M: tier.cacheWritePer1M,
    outputPer1M: tier.outputPer1M
  };
}

function validatePriceProfile(profile: Omit<PlanAccessPointPriceDraftPayload, "accessPointId">): string | null {
  for (const [field, value] of Object.entries({ inputPer1M: profile.inputPer1M, cachedInputPer1M: profile.cachedInputPer1M, outputPer1M: profile.outputPer1M })) {
    if (!Number.isFinite(value) || value < 0) return `${field} must be a finite non-negative number.`;
  }
  if (profile.cacheWritePer1M !== null && (!Number.isFinite(profile.cacheWritePer1M) || profile.cacheWritePer1M < 0)) return "cacheWritePer1M must be null or a finite non-negative number.";
  const seenTierKeys = new Set<string>();
  const tiersByService = new Map<string, PlanAccessPointPriceTierPayload[]>();
  for (const tier of profile.tiers) {
    const serviceTier = (tier.serviceTier ?? "standard").trim().toLowerCase().replace(/-/g, "_");
    if (!["standard", "batch", "flex", "priority"].includes(serviceTier)) return `tier ${tier.tierKey} has an invalid service tier.`;
    const uniqueKey = `${serviceTier}:${tier.tierKey}`;
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(tier.tierKey)) return `tier ${tier.tierKey || "(missing)"} must use a stable snake_case key.`;
    if (seenTierKeys.has(uniqueKey)) return `tier ${uniqueKey} is duplicated.`;
    seenTierKeys.add(uniqueKey);
    if (!Number.isInteger(tier.minInputTokens) || tier.minInputTokens < 0 || (tier.maxInputTokens !== null && (!Number.isInteger(tier.maxInputTokens) || tier.maxInputTokens < tier.minInputTokens))) return `tier ${tier.tierKey} has an invalid token range.`;
    for (const [field, value] of Object.entries({ inputPer1M: tier.inputPer1M, cachedInputPer1M: tier.cachedInputPer1M, outputPer1M: tier.outputPer1M })) {
      if (!Number.isFinite(value) || value < 0) return `tier ${tier.tierKey} ${field} must be a finite non-negative number.`;
    }
    if (tier.cacheWritePer1M !== null && (!Number.isFinite(tier.cacheWritePer1M) || tier.cacheWritePer1M < 0)) return `tier ${tier.tierKey} cacheWritePer1M must be null or a finite non-negative number.`;
    tiersByService.set(serviceTier, [...(tiersByService.get(serviceTier) ?? []), tier]);
  }
  for (const [serviceTier, tiers] of tiersByService) {
    const ordered = [...tiers].sort((left, right) => left.minInputTokens - right.minInputTokens || left.tierKey.localeCompare(right.tierKey));
    let expectedMin = serviceTier === "standard" && ordered[0]!.minInputTokens > 0 ? ordered[0]!.minInputTokens : 0;
    for (const [index, tier] of ordered.entries()) {
      if (tier.minInputTokens !== expectedMin) return `${serviceTier} tiers overlap or leave a gap near ${tier.tierKey}.`;
      if (tier.maxInputTokens === null) {
        if (index !== ordered.length - 1) return `unbounded tier ${tier.tierKey} must be last for ${serviceTier}.`;
        break;
      }
      expectedMin = tier.maxInputTokens + 1;
    }
    if (serviceTier !== "priority" && ordered.at(-1)?.maxInputTokens !== null) return `${serviceTier} tiers must cover the terminal unbounded range.`;
  }
  return null;
}

export function pricesEqual(left: PriceSummary, right: { inputPer1M: number; cachedInputPer1M: number; cacheWritePer1M: number | null; outputPer1M: number }) {
  return nearlyEqual(left.inputPer1M, right.inputPer1M) && nearlyEqual(left.cachedInputPer1M, right.cachedInputPer1M) && nullableNearlyEqual(left.cacheWritePer1M, right.cacheWritePer1M) && nearlyEqual(left.outputPer1M, right.outputPer1M);
}

function nullableNearlyEqual(left: number | null, right: number | null) {
  return left === null || right === null ? left === right : nearlyEqual(left, right);
}

export function nearlyEqual(left: number, right: number) {
  return Math.abs(left - right) < 1e-12;
}

export function priceMultiplierHint(accessPoint: AccessPointSummary) {
  const originalPrice = priceMultiplierBase(accessPoint);
  if (!originalPrice) return { placeholder: "Multiplier", title: "No base or effective price is configured." };
  const value = formatBasePrice(originalPrice);
  return {
    placeholder: "e.g. 1.2",
    title: `Applies to current prices: ${value}. Example: 1.2 multiplies all by 1.2; 0.05 makes prices 1/20 of current.`
  };
}

export function effectivePriceSource(accessPoint: AccessPointSummary): { label: string; tone: Tone } {
  if (accessPoint.effectivePrice?.source === "plan_access_point") return { label: "Plan override", tone: "good" };
  if (accessPoint.effectivePrice) return { label: "AP base", tone: "neutral" };
  return { label: "Missing", tone: "neutral" };
}

export function basePriceSource(accessPoint: AccessPointSummary): { label: string; tone: Tone } {
  return accessPoint.basePrice ? { label: "AP base", tone: "neutral" } : { label: "Missing", tone: "neutral" };
}

export function secondsFromDraft(value: string, unit: DurationUnit | WindowUnit) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return Number.NaN;
  const multiplier = unit === "years" ? 31536000 : unit === "days" ? 86400 : unit === "hours" ? 3600 : 1;
  return Math.round(amount * multiplier);
}

export function durationDraftFromSeconds(seconds: number): { value: string; unit: DurationUnit } {
  if (seconds % 31536000 === 0) return { value: String(seconds / 31536000), unit: "years" };
  if (seconds % 86400 === 0) return { value: String(seconds / 86400), unit: "days" };
  if (seconds % 3600 === 0) return { value: String(seconds / 3600), unit: "hours" };
  return { value: String(seconds), unit: "seconds" };
}

export function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: value >= 100 ? 0 : 2 }).format(value);
}

export function formatEffectivePrice(effectivePrice: EffectivePriceSummary | null) {
  if (!effectivePrice) return "Not configured";
  const price = effectivePrice.price;
  return `${formatPriceSummary(price)}${priceTierSuffix(price)}`;
}

export function formatBasePrice(price: PriceSummary | null) {
  if (!price) return "Not configured";
  return `${formatPriceSummary(price)}${priceTierSuffix(price)}`;
}

export function formatPriceSummary(price: PriceSummary) {
  return `input ${formatPricePerMillion(price.inputPer1M)} / cache read ${formatPricePerMillion(price.cachedInputPer1M)} / cache write ${price.cacheWritePer1M === null ? "Unavailable" : formatPricePerMillion(price.cacheWritePer1M)} / output ${formatPricePerMillion(price.outputPer1M)}`;
}

export function priceTierSuffix(price: PriceSummary) {
  const enabledTiers = price.tiers?.filter((tier) => tier.status === "enabled") ?? [];
  if (enabledTiers.length === 0) return " / flat";
  return ` / tiers ${enabledTiers.map((tier) => `${tier.serviceTier ?? "standard"}/${tier.tierKey}`).join(", ")}`;
}

export function formatPricePerMillion(value: number) {
  return `$${value.toLocaleString(undefined, { maximumFractionDigits: 6 })}`;
}

export function formatDuration(seconds: number) {
  if (seconds === 0) return "No limit";
  if (seconds % 31536000 === 0) return `${seconds / 31536000} years`;
  if (seconds % 86400 === 0) return `${seconds / 86400} days`;
  if (seconds % 3600 === 0) return `${seconds / 3600} hours`;
  return `${seconds}s`;
}

export function isNoLimitPayGoTemplate(template: Pick<PlanTemplate, "billingMode" | "durationSeconds">) {
  return template.billingMode === "paygo" && template.durationSeconds === 0;
}

export function formatPlanDuration(template: Pick<PlanTemplate, "billingMode" | "durationSeconds">) {
  return isNoLimitPayGoTemplate(template) ? "No duration limit" : formatDuration(template.durationSeconds);
}

export function planCardReplacementTargets<T extends Pick<PlanTemplate, "id" | "ownerId" | "scopeRef" | "name" | "version" | "billingMode" | "status">>(source: T, templates: T[]): T[] {
  return templates
    .filter((candidate) => candidate.id !== source.id
      && candidate.status === "enabled"
      && candidate.billingMode === "prepaid"
      && candidate.name === source.name
      && candidate.version > source.version
      && candidate.ownerId === source.ownerId
      && candidate.scopeRef === source.scopeRef)
    .sort((left, right) => left.version - right.version || left.id.localeCompare(right.id));
}

export function formatDateTime(value: string) {
  return formatUtcDateTime(value);
}

export function titleCase(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

export function messageFromError(error: unknown) {
  return error instanceof Error ? error.message : "Unexpected error";
}
