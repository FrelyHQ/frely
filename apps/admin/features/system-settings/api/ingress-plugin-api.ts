import { readConsoleApiResponse } from "@frely/console-ui/api-error";
import type { IngressPluginSettingView } from "../types";

export async function updateIngressPluginSetting(input: {
  pluginId: string;
  enabled: boolean;
  config: Record<string, unknown>;
}) {
  const response = await fetch(`/api/owner/ingress-plugins/${encodeURIComponent(input.pluginId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scopeRef: "global:", enabled: input.enabled, config: input.config })
  });
  return readConsoleApiResponse<IngressPluginSettingView>(response, "Save ingress plugin setting failed");
}

