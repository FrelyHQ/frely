import { adminPageServices } from "../../../lib/server";
import { pipelinePluginSettingViewsAsync } from "../../../features/system-settings/lib/pipeline-plugin-settings";
import { runtimeVersions } from "../../../lib/runtime-versions";
import { createPublicHostPolicy } from "@frely/ui-application/server";
import type { UiQueryPort } from "@frely/ui-application/contracts";
import type { WebRegistrationSettingView } from "../../../features/web-registration";
import { normalizeTablePageSize } from "@frely/console-ui/pagination";
import { toJsonObject } from "../page-data";
import {
  publicRequestCaptureSetting,
  publicSystemSettingsConfig,
  type PipelinePluginSettingDto,
} from "./page-data";

export interface AdminPageRequest {
  params: Record<string, string>;
  search: Record<string, string | string[] | undefined>;
}

export async function loadPage(request: AdminPageRequest) {
  const searchParams = Promise.resolve(request.search);
  const admin = await adminPageServices();
  if (!admin) return null;
  const { config } = admin;
  const rawRequestCapture = await admin.application.queries.getRequestCaptureSetting();
  const requestCapture = publicRequestCaptureSetting(rawRequestCapture);
  const pipelinePlugins = (await pipelinePluginSettingViewsAsync(admin.application.queries, admin.asyncTenancy.identity))
    .map((plugin) => ({ ...plugin, config: toJsonObject(plugin.config) })) satisfies PipelinePluginSettingDto[];
  const versions = await runtimeVersions();
  const resolvedPublicHostPolicy = createPublicHostPolicy(config.app.publicBaseUrl, config.app.reservedHostnames);
  const publicHostPolicy = {
    canonicalHostname: resolvedPublicHostPolicy.canonicalHostname,
    canonicalOrigin: resolvedPublicHostPolicy.canonicalOrigin,
  };
  const registrationSetting = await webRegistrationSettingViewAsync(admin.application.queries);
  const params = await searchParams;
  const publicHosts = await admin.application.queries.pagePublicHosts(positivePage(params?.publicHostsPage), normalizeTablePageSize(params?.publicHostsPageSize));
  return {
    config: publicSystemSettingsConfig(config, process.env.FRIDAY_RELAY_RELEASE ?? "dev"),
    requestCapture,
    pipelinePlugins,
    versions,
    publicHostPolicy,
    registrationSetting,
    publicHosts,
  };
}

export type AdminPageData = Awaited<ReturnType<typeof loadPage>>;

async function webRegistrationSettingViewAsync(repo: Pick<UiQueryPort, "getWebRegistrationSetting" | "getTeam" | "getTeamInviteLink" | "isTeamAvailable">): Promise<WebRegistrationSettingView> {
  const setting = await repo.getWebRegistrationSetting();
  if (!setting) return { enabled: false, configured: false, team: null, updatedAt: null };
  const team = setting.defaultTeamId ? await repo.getTeam(setting.defaultTeamId) : undefined;
  const invite = setting.registrationInviteLinkId ? await repo.getTeamInviteLink(setting.registrationInviteLinkId) : undefined;
  const configured = Boolean(setting.defaultTeamId && setting.registrationInviteLinkId);
  const enabled = Boolean(configured && team && await repo.isTeamAvailable(team.id) && invite?.status === "enabled" && invite.teamId === team.id && invite.usedCount !== null && (invite.maxUses === null || invite.usedCount < invite.maxUses));
  return { enabled, configured, team: team ? { id: team.id, name: team.name } : null, updatedAt: setting.updatedAt };
}


function positivePage(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw && /^\d+$/.test(raw) ? Math.max(1, Math.min(10_000, Number(raw))) : 1;
}
