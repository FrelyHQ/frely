import {
  capabilityToken,
  type IngressAdapterOrder,
  type PipelineHookInvocation,
  type PipelinePlugin,
  type PipelinePluginConfigField,
  type PipelineStrictConfigSchema,
} from "./contracts.js";

export type CompatibleIngressRequest = Readonly<{
  kind: string;
  payload: Readonly<Record<string, unknown>>;
}>;

export interface CompatibleIngressPlugin<TConfig = unknown> {
  readonly id: string;
  readonly desc: string;
  readonly version: number;
  readonly defaultConfig: TConfig;
  readonly configSchema: PipelineStrictConfigSchema<TConfig>;
  readonly configUi: readonly PipelinePluginConfigField[];
  isApplicable(
    context: Readonly<{ kind: string }>,
    payload: Readonly<Record<string, unknown>>,
    config: TConfig,
  ): boolean;
  transformIngressRequest(
    context: Readonly<{ kind: string }>,
    payload: Readonly<Record<string, unknown>>,
    config: TConfig,
  ): Readonly<{ payload: Record<string, unknown>; matched: boolean }>;
}

const EFFECTIVE_INGRESS_REQUEST = capabilityToken("ingress:effective-source-request");

function isCompatibleIngressRequest(value: unknown): value is CompatibleIngressRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<CompatibleIngressRequest>;
  return typeof request.kind === "string" && !!request.payload && typeof request.payload === "object" && !Array.isArray(request.payload);
}

/**
 * Maps one existing static IngressPlugin into request.ingress without importing
 * the legacy implementation. Composition remains explicit and is deliberately
 * left to the Gateway composition root.
 */
export function adaptIngressPlugin<TConfig>(
  plugin: CompatibleIngressPlugin<TConfig>,
  order: IngressAdapterOrder = {},
): PipelinePlugin<TConfig> {
  return Object.freeze({
    manifest: Object.freeze({
      id: plugin.id,
      desc: plugin.desc,
      apiVersion: 1,
      behaviorVersion: plugin.version,
      configVersion: 1,
      availability: "optional" as const,
      userConfigurable: true,
      userToggleable: true,
      permissions: Object.freeze([]),
      requires: Object.freeze([]),
      provides: Object.freeze([EFFECTIVE_INGRESS_REQUEST]),
    }),
    defaultConfig: plugin.defaultConfig,
    configSchema: plugin.configSchema,
    configUi: plugin.configUi,
    hooks: Object.freeze([{
      id: "transform-ingress-request",
      phase: "request.ingress" as const,
      kind: "transform" as const,
      requires: Object.freeze([]),
      provides: Object.freeze([EFFECTIVE_INGRESS_REQUEST]),
      readsArtifacts: Object.freeze(["originalRequest", "effectiveSourceRequest"] as const),
      writesArtifacts: Object.freeze(["effectiveSourceRequest"] as const),
      ...(order.before === undefined ? {} : { before: Object.freeze([...order.before]) }),
      ...(order.after === undefined ? {} : { after: Object.freeze([...order.after]) }),
      isApplicable(invocation: PipelineHookInvocation<TConfig>) {
        const source = invocation.artifacts.get("effectiveSourceRequest") ?? invocation.artifacts.get("originalRequest");
        if (!isCompatibleIngressRequest(source)) return false;
        return plugin.isApplicable({ kind: source.kind }, source.payload, invocation.config);
      },
      run(invocation: PipelineHookInvocation<TConfig>) {
        const source = invocation.artifacts.get("effectiveSourceRequest") ?? invocation.artifacts.get("originalRequest");
        if (!isCompatibleIngressRequest(source)) throw new Error("Ingress adapter requires a { kind, payload } request artifact");
        const result = plugin.transformIngressRequest({ kind: source.kind }, source.payload, invocation.config);
        return Object.freeze({
          outcome: result.matched ? "applied" as const : "noop" as const,
          artifacts: Object.freeze({
            effectiveSourceRequest: Object.freeze({ kind: source.kind, payload: result.payload }),
          }),
        });
      },
    }]),
  });
}
