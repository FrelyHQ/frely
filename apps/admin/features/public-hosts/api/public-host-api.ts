import { readConsoleApiResponse } from "@frely/console-ui/api-error";
import type { InstancePublicHost } from "@frely/ui-application/contracts";

export async function createPublicHost(hostname: string): Promise<InstancePublicHost> {
  const response = await fetch("/api/owner/public-hosts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hostname })
  });
  return readConsoleApiResponse<InstancePublicHost>(response, "Create Public Host failed");
}

export async function setPublicHostEnabled(input: { id: string; enabled: boolean }): Promise<InstancePublicHost> {
  const response = await fetch(`/api/owner/public-hosts/${encodeURIComponent(input.id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: input.enabled })
  });
  return readConsoleApiResponse<InstancePublicHost>(response, `${input.enabled ? "Enable" : "Disable"} Public Host failed`);
}

export async function deletePublicHost(id: string): Promise<void> {
  const response = await fetch(`/api/owner/public-hosts/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (response.ok) return;
  await readConsoleApiResponse(response, "Delete Public Host failed");
}
