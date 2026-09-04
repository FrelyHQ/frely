export const ACCESS_POINT_SELECTOR_IDS = ["direct", "ordered-fallback"] as const;
export type AccessPointSelectorId = (typeof ACCESS_POINT_SELECTOR_IDS)[number];
export type ProviderFailureClass =
  | "connect_error"
  | "timeout"
  | "rate_limited"
  | "upstream_5xx"
  | "non_retryable";

export const PROVIDER_CREDENTIAL_FAILURE_REASONS = [
  "auth_unauthorized",
  "auth_unavailable",
  "auth_not_found",
  "model_cooldown",
] as const;
export type ProviderCredentialFailureReason = typeof PROVIDER_CREDENTIAL_FAILURE_REASONS[number];

export function isProviderCredentialFailureReason(value: unknown): value is ProviderCredentialFailureReason {
  return typeof value === "string" && (PROVIDER_CREDENTIAL_FAILURE_REASONS as readonly string[]).includes(value);
}

export const RETRYABLE_PROVIDER_FAILURE_CLASSES = [
  "connect_error",
  "timeout",
  "rate_limited",
  "upstream_5xx",
] as const satisfies readonly ProviderFailureClass[];

export interface SelectorCandidate {
  readonly candidateId: string;
  readonly targetEdgeId: string;
  readonly position: number;
  readonly available: boolean;
}

export interface SelectorAttemptResult {
  readonly candidateId: string;
  readonly targetEdgeId: string;
  readonly attemptIndex: number;
  readonly outcome: "succeeded" | "failed" | "aborted";
  readonly failureClass: ProviderFailureClass | null;
  readonly outputCommitted: boolean;
  readonly durationMs: number;
}

export interface DirectSelectorConfig {}

export interface OrderedFallbackSelectorConfig {
  readonly maxAttempts: number;
  readonly retryOn: readonly Exclude<ProviderFailureClass, "non_retryable">[];
}

export type AccessPointSelectorConfig = DirectSelectorConfig | OrderedFallbackSelectorConfig;

export interface AccessPointSelector<TConfig extends AccessPointSelectorConfig> {
  readonly id: AccessPointSelectorId;
  readonly behaviorVersion: 1;
  normalizeConfig(input: unknown, enabledTargetCount: number): Readonly<TConfig>;
  decide(
    candidates: readonly Readonly<SelectorCandidate>[],
    attempts: readonly Readonly<SelectorAttemptResult>[],
    config: Readonly<TConfig>,
  ): string | null;
}

const directSelector: AccessPointSelector<DirectSelectorConfig> = Object.freeze({
  id: "direct",
  behaviorVersion: 1,
  normalizeConfig(input: unknown, enabledTargetCount: number) {
    assertStrictRecord(input, []);
    if (enabledTargetCount !== 1) throw new Error("direct_selector_requires_one_enabled_target");
    return Object.freeze({});
  },
  decide(
    candidates: readonly Readonly<SelectorCandidate>[],
    attempts: readonly Readonly<SelectorAttemptResult>[],
  ) {
    const available = candidates.filter((candidate) => candidate.available);
    if (available.length !== 1) return null;
    return attempts.some((attempt) => attempt.candidateId === available[0]!.candidateId)
      ? null
      : available[0]!.candidateId;
  },
});

const orderedFallbackSelector: AccessPointSelector<OrderedFallbackSelectorConfig> = Object.freeze({
  id: "ordered-fallback",
  behaviorVersion: 1,
  normalizeConfig(input: unknown, enabledTargetCount: number) {
    if (enabledTargetCount < 2 || enabledTargetCount > 4) {
      throw new Error("ordered_fallback_requires_two_to_four_enabled_targets");
    }
    const record = assertStrictRecord(input, ["maxAttempts", "retryOn"]);
    const maxAttempts = record.maxAttempts === undefined
      ? Math.min(2, enabledTargetCount)
      : record.maxAttempts;
    if (!Number.isSafeInteger(maxAttempts) || (maxAttempts as number) < 2 || (maxAttempts as number) > enabledTargetCount) {
      throw new Error("ordered_fallback_max_attempts_invalid");
    }
    const retryOn = record.retryOn === undefined
      ? [...RETRYABLE_PROVIDER_FAILURE_CLASSES]
      : record.retryOn;
    if (!Array.isArray(retryOn) || retryOn.length === 0) {
      throw new Error("ordered_fallback_retry_on_invalid");
    }
    const normalizedRetryOn = Array.from(new Set(retryOn));
    if (
      normalizedRetryOn.length !== retryOn.length
      || normalizedRetryOn.some((value) => !RETRYABLE_PROVIDER_FAILURE_CLASSES.includes(value as never))
    ) {
      throw new Error("ordered_fallback_retry_on_invalid");
    }
    return Object.freeze({
      maxAttempts: maxAttempts as number,
      retryOn: Object.freeze(normalizedRetryOn as OrderedFallbackSelectorConfig["retryOn"]),
    });
  },
  decide(
    candidates: readonly Readonly<SelectorCandidate>[],
    attempts: readonly Readonly<SelectorAttemptResult>[],
    config: Readonly<OrderedFallbackSelectorConfig>,
  ) {
    if (attempts.length >= config.maxAttempts) return null;
    const previous = attempts.at(-1);
    if (previous && (
      previous.outcome !== "failed"
      || previous.outputCommitted
      || previous.failureClass === null
      || !config.retryOn.includes(previous.failureClass as Exclude<ProviderFailureClass, "non_retryable">)
    )) return null;
    const attempted = new Set(attempts.map((attempt) => attempt.candidateId));
    return [...candidates]
      .filter((candidate) => candidate.available && !attempted.has(candidate.candidateId))
      .sort((left, right) => left.position - right.position || left.targetEdgeId.localeCompare(right.targetEdgeId))[0]
      ?.candidateId ?? null;
  },
});

const registry = Object.freeze({
  direct: directSelector,
  "ordered-fallback": orderedFallbackSelector,
});

export const ACCESS_POINT_SELECTOR_CATALOG = Object.freeze([
  Object.freeze({
    id: "direct" as const,
    behaviorVersion: 1 as const,
    description: "Always select the single enabled target.",
    configSchema: Object.freeze({
      type: "object",
      additionalProperties: false,
      properties: Object.freeze({}),
    }),
    ui: Object.freeze({ minTargets: 1, maxTargets: 1, hidesSelectorChoice: true }),
  }),
  Object.freeze({
    id: "ordered-fallback" as const,
    behaviorVersion: 1 as const,
    description: "Try enabled targets in position order before client output is committed.",
    configSchema: Object.freeze({
      type: "object",
      additionalProperties: false,
      properties: Object.freeze({
        maxAttempts: Object.freeze({ type: "integer", minimum: 2, maximum: 4 }),
        retryOn: Object.freeze({
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: Object.freeze({ type: "string", enum: RETRYABLE_PROVIDER_FAILURE_CLASSES }),
        }),
      }),
    }),
    ui: Object.freeze({ minTargets: 2, maxTargets: 4, hidesSelectorChoice: false }),
  }),
]);

export function getAccessPointSelector(
  id: string,
  behaviorVersion: number,
): AccessPointSelector<AccessPointSelectorConfig> {
  if (behaviorVersion !== 1 || !ACCESS_POINT_SELECTOR_IDS.includes(id as AccessPointSelectorId)) {
    throw new Error("access_point_selector_unknown");
  }
  return registry[id as AccessPointSelectorId] as AccessPointSelector<AccessPointSelectorConfig>;
}

export function normalizeAccessPointSelectorConfig(
  id: string,
  behaviorVersion: number,
  input: unknown,
  enabledTargetCount: number,
): Readonly<AccessPointSelectorConfig> {
  return getAccessPointSelector(id, behaviorVersion).normalizeConfig(input, enabledTargetCount);
}

function assertStrictRecord(input: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("access_point_selector_config_invalid");
  }
  const record = input as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowedKeys.includes(key))) {
    throw new Error("access_point_selector_config_unknown_field");
  }
  return record;
}
