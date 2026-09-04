export type IngressRequestKind = "chat.completions" | "responses" | "messages" | "embeddings" | "models";

export type PluginConfigOption = Readonly<{
  label: string;
  value: string;
}>;

export type PluginConfigField = Readonly<{
  type: "multi-select";
  key: string;
  label: string;
  description: string;
  required: boolean;
  options: readonly PluginConfigOption[];
}>;

export interface StrictConfigSchema<TConfig> {
  parse(input: unknown): TConfig;
}

export type IngressPluginContext = Readonly<{
  kind: IngressRequestKind;
}>;

export type IngressPluginResult = Readonly<{
  payload: Record<string, unknown>;
  matched: boolean;
}>;

export interface IngressPlugin<TConfig = unknown> {
  readonly id: string;
  readonly desc: string;
  readonly version: number;
  readonly defaultConfig: TConfig;
  readonly configSchema: StrictConfigSchema<TConfig>;
  readonly configUi: readonly PluginConfigField[];
  isApplicable(
    context: IngressPluginContext,
    payload: Readonly<Record<string, unknown>>,
    config: TConfig,
  ): boolean;
  transformIngressRequest(
    context: IngressPluginContext,
    payload: Readonly<Record<string, unknown>>,
    config: TConfig,
  ): IngressPluginResult;
}

export type ResolvedIngressPluginSetting = Readonly<{
  id: string;
  enabled: boolean;
  config: unknown;
}>;

export type InvokedIngressPlugin = Readonly<{
  id: string;
  version: number;
  success: boolean | null;
}>;

export type IngressPluginExecution = Readonly<{
  payload: Record<string, unknown>;
  invokedPlugins: readonly InvokedIngressPlugin[];
}>;
