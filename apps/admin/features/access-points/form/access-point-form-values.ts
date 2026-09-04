import type {
  AccessPointSummary,
  ProviderModelSummary,
  ProviderSummary,
} from "../types";

export type TargetSelection =
  | { kind: "provider"; providerId: string }
  | { kind: "access-point"; accessPointId: string };

export interface AccessPointFormValues {
  targetValue: string;
  fallbackTargetValue: string;
  maxAttempts: string;
  retryOn: string;
  requestOverridesJson: string;
  name: string;
  description: string;
  exposedModel: string;
  targetModel: string;
  scopeRef: string;
  priority: string;
  weight: string;
  fallbackOrder: string;
  saleInputPer1M: string;
  saleCachedInputPer1M: string;
  saleCacheWritePer1M: string;
  saleOutputPer1M: string;
  status: string;
}

export function providerTargetValue(id: string) {
  return `provider:${id}`;
}
export function accessPointTargetValue(id: string) {
  return `ap:${id}`;
}

export function parseTargetValue(value: string): TargetSelection | null {
  const normalized = value.trim();
  if (normalized.startsWith("provider:")) {
    const providerId = normalized.slice("provider:".length).trim();
    return providerId ? { kind: "provider", providerId } : null;
  }
  if (normalized.startsWith("ap:")) {
    const accessPointId = normalized.slice("ap:".length).trim();
    return accessPointId ? { kind: "access-point", accessPointId } : null;
  }
  return null;
}

export function accessPointFormDefaults(
  row: AccessPointSummary | undefined,
  defaultScope: string,
  firstProviderId: string,
): AccessPointFormValues {
  const targets = row?.routing?.targets
    .filter((target) => target.status === "enabled")
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)) ?? [];
  const primaryTarget = targets[0];
  const fallbackTarget = targets[1];
  return {
    targetValue: routingTargetValue(primaryTarget) ?? (
      row?.targetType === "access-point" && row.targetId
        ? accessPointTargetValue(row.targetId)
        : row?.targetProviderId
          ? providerTargetValue(row.targetProviderId)
          : firstProviderId
            ? providerTargetValue(firstProviderId)
            : ""
    ),
    fallbackTargetValue: routingTargetValue(fallbackTarget) ?? "",
    maxAttempts: String(row?.routing?.selector.config.maxAttempts ?? 2),
    retryOn: (row?.routing?.selector.config.retryOn ?? ["connect_error", "timeout", "rate_limited", "upstream_5xx"]).join(","),
    requestOverridesJson: JSON.stringify(row?.routing?.requestOverrides ?? {}, null, 2),
    name: row?.name ?? "",
    description: row?.description ?? "",
    exposedModel: row?.exposedModel ?? row?.targetProviderModelName ?? "",
    targetModel: row?.targetModel ?? "",
    scopeRef: row?.scopeRef ?? defaultScope,
    priority: String(row?.priority ?? 100),
    weight: String(row?.weight ?? 1),
    fallbackOrder: String(row?.fallbackOrder ?? 100),
    saleInputPer1M: "",
    saleCachedInputPer1M: "",
    saleCacheWritePer1M: "",
    saleOutputPer1M: "",
    status: row?.status ?? "disabled",
  };
}

export function inferProviderModelName(
  provider: ProviderSummary | undefined,
  models: ProviderModelSummary[],
): string {
  if (!provider) return "";
  const synced =
    models.find(
      (model) => model.providerId === provider.id && model.status === "enabled",
    ) ?? models.find((model) => model.providerId === provider.id);
  if (synced) return synced.providerModelName;
  if (provider.modelsResolver.startsWith("literal:list:"))
    return (
      provider.modelsResolver
        .slice("literal:list:".length)
        .split(",")[0]
        ?.trim() ?? ""
    );
  return "";
}

export function targetChangeDefaults(
  value: string,
  exposedModel: string,
  accessPoints: AccessPointSummary[],
  providers: ProviderSummary[],
  models: ProviderModelSummary[],
) {
  const target = parseTargetValue(value);
  if (!target) return { exposedModel: "", targetModel: "" };
  if (target.kind === "access-point") {
    const model =
      accessPoints.find((row) => row.id === target.accessPointId)
        ?.exposedModel ?? "";
    return { exposedModel: exposedModel.trim() || model, targetModel: model };
  }
  return {
    exposedModel,
    targetModel: inferProviderModelName(
      providers.find((provider) => provider.id === target.providerId),
      models,
    ),
  };
}

export function validateProviderCatalog(
  values: AccessPointFormValues,
  models: ProviderModelSummary[],
  resolvedModelNames: string[] = [],
): string | undefined {
  const target = parseTargetValue(values.targetValue);
  if (target?.kind !== "provider") return undefined;
  const modelName = values.targetModel.trim() || values.exposedModel.trim();
  return resolvedModelNames.includes(modelName) || models.some(
    (model) =>
      model.providerId === target.providerId &&
      model.providerModelName === modelName &&
      model.status === "enabled",
  )
    ? undefined
    : `Provider Model "${modelName}" is not enabled in Provider "${target.providerId}" model catalog.`;
}

export function parseNonNegativeNumber(value: string): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function accessPointDescriptionLength(value: string): number {
  return [...value].length;
}

export function validateAccessPointDescription(value: string): string | undefined {
  return accessPointDescriptionLength(value) <= 500
    ? undefined
    : "Description must be 500 Unicode characters or fewer.";
}

export function toAccessPointInput(
  values: AccessPointFormValues,
  row?: AccessPointSummary,
) {
  const target = parseTargetValue(values.targetValue);
  const fallbackTarget = values.fallbackTargetValue.trim() ? parseTargetValue(values.fallbackTargetValue) : null;
  const selectedTargetModel = values.targetModel.trim();
  const exposedModel = values.exposedModel.trim() || selectedTargetModel;
  const name = values.name.trim() || exposedModel;
  const scopeRef = values.scopeRef.trim();
  if (!target) return { ok: false as const, message: "Target is required." };
  if (values.fallbackTargetValue.trim() && !fallbackTarget) return { ok: false as const, message: "Fallback target is invalid." };
  if (fallbackTarget && values.fallbackTargetValue === values.targetValue) return { ok: false as const, message: "Fallback target must differ from the primary target." };
  if (!exposedModel || !scopeRef)
    return {
      ok: false as const,
      message: "Exposed Model or Target Model, and Scope are required.",
    };
  const numbers = [values.priority, values.weight, values.fallbackOrder].map(
    parseNonNegativeNumber,
  );
  if (numbers.some((value) => value === null))
    return {
      ok: false as const,
      message:
        "Priority, weight and fallback order must be non-negative numbers.",
    };
  const targetModel = selectedTargetModel || exposedModel;
  const maxAttempts = Number(values.maxAttempts);
  const retryOn = values.retryOn.split(",").map((value) => value.trim()).filter(Boolean);
  const priorTargets = row?.routing?.targets ?? [];
  const editablePriorTargets = priorTargets
    .filter((candidate) => candidate.status === "enabled")
    .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id))
    .slice(0, 2);
  const [priorPrimary, priorFallback] = editablePriorTargets;
  const retainedTargets = priorTargets.filter((candidate) => candidate !== priorPrimary && candidate !== priorFallback);
  const usedPositions = new Set(retainedTargets.map((candidate) => candidate.position));
  const primaryPosition = priorPrimary?.position ?? nextRoutingPosition(usedPositions);
  usedPositions.add(primaryPosition);
  const fallbackPosition = fallbackTarget
    ? priorFallback?.position ?? nextRoutingPosition(usedPositions)
    : null;
  if (fallbackPosition !== null) usedPositions.add(fallbackPosition);

  const routingTargets = [
    editableRoutingTarget(target, targetModel, primaryPosition, priorPrimary),
    ...(fallbackTarget && fallbackPosition !== null
      ? [editableRoutingTarget(fallbackTarget, targetModel, fallbackPosition, priorFallback)]
      : []),
    ...retainedTargets.map((candidate) => ({
      id: candidate.id,
      type: candidate.targetType,
      targetAccessPointId: candidate.targetAccessPointId,
      targetProviderId: candidate.targetProviderId,
      targetProviderModelName: candidate.targetProviderModelName,
      position: candidate.position,
      status: candidate.status,
    })),
  ].sort((left, right) => left.position - right.position || String(left.id ?? "").localeCompare(String(right.id ?? "")));
  const enabledTargetCount = routingTargets.filter((candidate) => candidate.status === "enabled").length;
  const selectorId = enabledTargetCount > 1 ? "ordered-fallback" : "direct";
  if (selectorId === "ordered-fallback" && (
    enabledTargetCount > 4
    || !Number.isSafeInteger(maxAttempts)
    || maxAttempts < 2
    || maxAttempts > enabledTargetCount
    || retryOn.length === 0
  )) {
    return { ok: false as const, message: "Ordered fallback requires two to four enabled targets, max attempts within that target count, and at least one retry class." };
  }
  let requestOverrides: Record<string, unknown>;
  try {
    const parsed = JSON.parse(values.requestOverridesJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not_object");
    requestOverrides = parsed as Record<string, unknown>;
  } catch {
    return { ok: false as const, message: "Request overrides must be a valid JSON object." };
  }
  const prices = [
    values.saleInputPer1M,
    values.saleCachedInputPer1M,
    values.saleCacheWritePer1M,
    values.saleOutputPer1M,
  ];
  const priceNumber = (value: string, fallback: number) =>
    value.trim() ? Number(value) : fallback;
  const cacheWritePrice = prices[2]!.trim().toLowerCase() === "unavailable"
    ? null
    : priceNumber(prices[2]!, priceNumber(prices[0]!, 0));
  const salePrice = prices.every((value) => !value.trim())
    ? null
    : {
        inputPer1M: priceNumber(prices[0]!, 0),
        cachedInputPer1M: priceNumber(prices[1]!, 0),
        cacheWritePer1M: cacheWritePrice,
        outputPer1M: priceNumber(prices[3]!, 0),
      };
  return {
    ok: true as const,
    value: {
      ...(row ? { id: row.id } : {}),
      scopeRef,
      name,
      description: values.description,
      apiFamily: row?.apiFamily ?? "openai-compatible",
      exposedModel,
      targetModel,
      routing: {
        selector: {
          id: selectorId,
          behaviorVersion: 1,
          config: selectorId === "ordered-fallback" ? { maxAttempts, retryOn } : {},
        },
        requestOverrides,
        targets: routingTargets,
        ...(row?.routing ? { routingRevision: row.routing.routingRevision } : {}),
      },
      salePrice,
      priority: numbers[0]!,
      weight: numbers[1]!,
      fallbackOrder: numbers[2]!,
      status: row ? values.status : "disabled",
    },
  };
}

function routingTargetValue(
  target: NonNullable<AccessPointSummary["routing"]>["targets"][number] | undefined,
): string | null {
  if (!target) return null;
  if (target.targetType === "access-point" && target.targetAccessPointId) {
    return accessPointTargetValue(target.targetAccessPointId);
  }
  return target.targetProviderId ? providerTargetValue(target.targetProviderId) : null;
}

function nextRoutingPosition(used: ReadonlySet<number>): number {
  let position = 0;
  while (used.has(position)) position += 1;
  return position;
}

function editableRoutingTarget(
  selection: TargetSelection,
  targetModel: string,
  position: number,
  previous: NonNullable<AccessPointSummary["routing"]>["targets"][number] | undefined,
) {
  const preservesIdentity = previous?.position === position && (
    selection.kind === "provider"
      ? previous.targetType === "provider-model"
        && previous.targetProviderId === selection.providerId
        && previous.targetProviderModelName === targetModel
      : previous.targetType === "access-point"
        && previous.targetAccessPointId === selection.accessPointId
  );
  return {
    ...(preservesIdentity ? { id: previous.id } : {}),
    type: selection.kind === "provider" ? "provider-model" as const : "access-point" as const,
    targetAccessPointId: selection.kind === "access-point" ? selection.accessPointId : null,
    targetProviderId: selection.kind === "provider" ? selection.providerId : null,
    targetProviderModelName: selection.kind === "provider" ? targetModel : null,
    position,
    status: "enabled" as const,
  };
}
