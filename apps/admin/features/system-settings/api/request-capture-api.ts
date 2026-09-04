import { readConsoleApiResponse } from "@frely/console-ui/api-error";

export interface RequestCaptureSetting {
  enabled: boolean;
}

export async function updateRequestCaptureSetting(enabled: boolean) {
  const response = await fetch("/api/owner/request-capture", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled })
  });
  return readConsoleApiResponse<RequestCaptureSetting>(response, "Save request capture setting failed");
}
