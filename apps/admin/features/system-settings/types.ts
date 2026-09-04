export type IngressPluginOption = {
  label: string;
  value: string;
};

export type IngressPluginConfigField = {
  type: "multi-select";
  key: string;
  label: string;
  description: string;
  required: boolean;
  options: readonly IngressPluginOption[];
};

export type IngressPluginSettingView = {
  id: string;
  desc: string;
  version: number;
  scopeRef: "global:";
  enabled: boolean;
  config: Record<string, unknown>;
  configUi: readonly IngressPluginConfigField[];
  updatedAt: string | null;
  updatedBy: string | null;
};

export type PipelinePluginSettingView = {
  id: string;
  desc: string;
  apiVersion: number;
  behaviorVersion: number;
  configVersion: number;
  availability: "required" | "optional";
  userConfigurable: boolean;
  userToggleable: boolean;
  phases: readonly string[];
  scopeRef: "global:";
  enabled: boolean;
  config: Record<string, unknown>;
  configUi: readonly IngressPluginConfigField[];
  settingRevision: number | null;
  updatedAt: string | null;
  updatedBy: string | null;
};
