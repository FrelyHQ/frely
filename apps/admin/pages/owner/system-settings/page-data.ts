import type { PipelinePluginSettingView } from "../../../features/system-settings/types";
import type { PublicHostsPanel } from "../../../features/public-hosts/components/public-hosts-panel";
import type { WebRegistrationCard } from "../../../features/web-registration/components/web-registration-card";
import type { JsonObject } from "../page-data";

export type PipelinePluginSettingDto = Omit<PipelinePluginSettingView, "config"> & {
  config: JsonObject;
};

export interface SystemSettingsConfigInput {
  app: { environment: string; publicBaseUrl: string };
  logging: { level: string };
}

export function publicSystemSettingsConfig(config: SystemSettingsConfigInput, releaseVersion: string) {
  return {
    environment: config.app.environment,
    releaseVersion,
    publicBaseUrl: config.app.publicBaseUrl,
    loggingLevel: config.logging.level,
    inviteRegistrationBaseUrl: config.app.publicBaseUrl,
  };
}

export function publicRequestCaptureSetting(setting: { enabled: boolean }) {
  return { enabled: setting.enabled };
}

export type SystemSettingsPageData = {
  config: ReturnType<typeof publicSystemSettingsConfig>;
  requestCapture: { enabled: boolean };
  pipelinePlugins: PipelinePluginSettingDto[];
  versions: Array<{
    service: string;
    version: string;
    availability: string;
    detail: string;
  }>;
  publicHostPolicy: { canonicalHostname: string; canonicalOrigin: string };
  registrationSetting: Parameters<typeof WebRegistrationCard>[0]["initial"];
  publicHosts: Parameters<typeof PublicHostsPanel>[0]["aliases"];
} | null;
