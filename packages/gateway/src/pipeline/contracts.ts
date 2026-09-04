export const PIPELINE_PHASES = Object.freeze([
  "request.ingress",
  "request.decode",
  "request.normalize",
  "request.estimate",
  "policy.pre-resolution",
  "access.candidates",
  "access.select",
  "policy.post-resolution",
  "pricing.quote",
  "provider.request",
  "provider.invoke",
  "response.decode",
  "response.transform",
  "stream.transform",
  "usage.measure",
  "billing.calculate",
  "response.egress",
  "observability",
] as const);

export type PipelinePhase = (typeof PIPELINE_PHASES)[number];
export type PipelineHookKind = "transform" | "guard" | "contribute" | "observe";
export type PipelineOutcome = "applied" | "noop" | "denied" | "failed" | "fallback";
export type PluginAvailability = "required" | "optional";
export type ContextVisibility = "private" | "shared";
export type ContextMode = "artifact" | "owner-cache";

export type CapabilityToken = string & { readonly __capabilityToken: unique symbol };
export type PluginPermission = string & { readonly __pluginPermission: unique symbol };

export function capabilityToken(id: string): CapabilityToken {
  return id as CapabilityToken;
}

export function pluginPermission(id: string): PluginPermission {
  return id as PluginPermission;
}

export function definePipelinePlugin<TConfig>(plugin: PipelinePlugin<TConfig>): PipelinePlugin<TConfig> {
  return plugin;
}

export interface PipelineStrictConfigSchema<TConfig> {
  parse(input: unknown): TConfig;
}

export type PipelinePluginConfigField = Readonly<{
  type: string;
  key: string;
  label: string;
  description: string;
  required: boolean;
  options?: readonly Readonly<{ label: string; value: string }>[];
}>;

export interface PipelineContextKey<T> {
  readonly id: `${string}:${string}`;
  readonly ownerPluginId: string;
  readonly visibility: ContextVisibility;
  readonly mode: ContextMode;
  /** Type-only marker. */
  readonly __value?: T;
}

export function definePipelineContextKey<T>(definition: Omit<PipelineContextKey<T>, "__value">): PipelineContextKey<T> {
  return Object.freeze({ ...definition });
}

export interface PipelineArtifacts {
  readonly originalRequest: unknown;
  readonly effectiveSourceRequest?: unknown;
  readonly canonicalRequest?: unknown;
  readonly subscriptionSelection?: unknown;
  readonly accessResolution?: unknown;
  readonly priceQuote?: unknown;
  readonly budgetDecision?: unknown;
  readonly providerRequest?: unknown;
  readonly canonicalResponse?: unknown;
  readonly clientResponse?: unknown;
  readonly usage?: unknown;
  readonly billingDraft?: unknown;
}

export type PipelineArtifactName = keyof PipelineArtifacts;

export const PIPELINE_ARTIFACT_NAMES = Object.freeze([
  "originalRequest",
  "effectiveSourceRequest",
  "canonicalRequest",
  "subscriptionSelection",
  "accessResolution",
  "priceQuote",
  "budgetDecision",
  "providerRequest",
  "canonicalResponse",
  "clientResponse",
  "usage",
  "billingDraft",
] as const satisfies readonly PipelineArtifactName[]);

export interface PipelineArtifactReader {
  get<TKey extends PipelineArtifactName>(key: TKey): PipelineArtifacts[TKey] | undefined;
  has(key: PipelineArtifactName): boolean;
}

export interface PipelineContextData {
  get<T>(key: PipelineContextKey<T>): Readonly<T> | undefined;
  set<T>(key: PipelineContextKey<T>, value: T): void;
  has<T>(key: PipelineContextKey<T>): boolean;
}

export type PipelineHookResult = Readonly<{
  outcome: Exclude<PipelineOutcome, "failed">;
  artifacts?: Readonly<Partial<PipelineArtifacts>>;
}>;

export interface PipelineHookInvocation<TConfig> {
  readonly pluginId: string;
  readonly phase: PipelinePhase;
  readonly config: TConfig;
  readonly artifacts: PipelineArtifactReader;
  readonly context: PipelineContextData;
  readonly ports: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
}

export interface PipelineHook<TConfig = unknown> {
  readonly id: string;
  readonly phase: PipelinePhase;
  readonly kind: PipelineHookKind;
  readonly requires: readonly CapabilityToken[];
  readonly provides: readonly CapabilityToken[];
  readonly readsArtifacts: readonly PipelineArtifactName[];
  readonly writesArtifacts: readonly PipelineArtifactName[];
  readonly requiresContext?: readonly PipelineContextKey<unknown>[];
  readonly providesContext?: readonly PipelineContextKey<unknown>[];
  readonly before?: readonly string[];
  readonly after?: readonly string[];
  readonly bestEffort?: boolean;
  readonly timeoutMs?: number;
  isApplicable?(invocation: PipelineHookInvocation<TConfig>): boolean;
  run(invocation: PipelineHookInvocation<TConfig>): PipelineHookResult | Promise<PipelineHookResult>;
}

export interface PluginManifest {
  readonly id: string;
  readonly desc: string;
  readonly apiVersion: number;
  readonly behaviorVersion: number;
  readonly configVersion: number;
  readonly availability: PluginAvailability;
  readonly userConfigurable: boolean;
  readonly userToggleable: boolean;
  readonly permissions: readonly PluginPermission[];
  readonly requires: readonly CapabilityToken[];
  readonly provides: readonly CapabilityToken[];
}

export interface PipelinePlugin<TConfig = unknown> {
  readonly manifest: PluginManifest;
  readonly defaultConfig: TConfig;
  readonly configSchema: PipelineStrictConfigSchema<TConfig>;
  readonly configUi: readonly PipelinePluginConfigField[];
  readonly contextKeys?: readonly PipelineContextKey<unknown>[];
  readonly hooks: readonly PipelineHook<TConfig>[];
  isApplicable?(facts: Readonly<Record<string, unknown>>): boolean;
}

export type IngressAdapterOrder = Readonly<{
  before?: readonly string[];
  after?: readonly string[];
}>;

export type PipelinePluginSetting = Readonly<{
  pluginId: string;
  enabled: boolean;
  config?: unknown;
  instanceRevision: string;
}>;

export type PipelineSettingsSnapshot = Readonly<{
  revision: string;
  settings: readonly PipelinePluginSetting[];
}>;

export type PipelineApplicabilitySnapshot = Readonly<{
  cacheKey: string;
  facts: Readonly<Record<string, unknown>>;
}>;

export type PipelineInvocationFact = Readonly<{
  pluginId: string;
  behaviorVersion: number;
  hook: PipelinePhase;
  instanceRevision: string;
  outcome: PipelineOutcome;
}>;

export type PipelineInvocationSnapshot = Readonly<{
  schemaVersion: 1;
  planRevision: string;
  invocations: readonly PipelineInvocationFact[];
}>;

export type CompiledPipelineHook = Readonly<{
  ref: string;
  pluginId: string;
  behaviorVersion: number;
  phase: PipelinePhase;
  kind: PipelineHookKind;
  bestEffort: boolean;
  timeoutMs?: number;
  instanceRevision: string;
  config: unknown;
  ports: Readonly<Record<string, unknown>>;
  readableArtifactNames: ReadonlySet<PipelineArtifactName>;
  writableArtifactNames: ReadonlySet<PipelineArtifactName>;
  readableContextKeyIds: ReadonlySet<string>;
  requiredContextKeyIds: ReadonlySet<string>;
  writableContextKeyIds: ReadonlySet<string>;
  isApplicable?: PipelineHook<unknown>["isApplicable"];
  run: PipelineHook<unknown>["run"];
}>;

export type ExecutionPlan = Readonly<{
  kernelApiVersion: number;
  planRevision: string;
  settingsRevision: string;
  applicabilityCacheKey: string;
  hooksByPhase: Readonly<Record<PipelinePhase, readonly CompiledPipelineHook[]>>;
  requestHooks: readonly CompiledPipelineHook[];
  responseHooks: readonly CompiledPipelineHook[];
  streamHooks: readonly CompiledPipelineHook[];
  contextKeys: ReadonlyMap<string, PipelineContextKey<unknown>>;
}>;

export const PIPELINE_REQUEST_PHASES = Object.freeze(
  PIPELINE_PHASES.filter((phase) =>
    phase.startsWith("request.") || phase.startsWith("policy.") || phase.startsWith("access.") ||
    phase === "pricing.quote" || phase.startsWith("provider."),
  ),
);

export const PIPELINE_RESPONSE_PHASES = Object.freeze(
  PIPELINE_PHASES.filter((phase) =>
    phase.startsWith("response.") || phase === "usage.measure" || phase === "billing.calculate" || phase === "observability",
  ),
);
