import { readConsoleApiResponse } from "@frely/console-ui/api-error";
import type { PipelinePluginSettingView } from "../types";

export async function updatePipelinePluginSetting(input: {
  pluginId: string;
  enabled: boolean;
  config: Record<string, unknown>;
}): Promise<PipelinePluginSettingView> {
  const response = await fetch(`/api/owner/pipeline-plugins/${encodeURIComponent(input.pluginId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scopeRef: "global:", enabled: input.enabled, config: input.config }),
  });
  return readConsoleApiResponse<PipelinePluginSettingView>(response, "Save pipeline plugin setting failed");
}
