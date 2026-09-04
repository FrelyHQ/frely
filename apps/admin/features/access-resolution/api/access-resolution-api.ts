import { readConsoleApiResponse } from "@frely/console-ui/api-error";
import type { PreviewInput, ResolutionTrace } from "../types";

export async function fetchAccessResolutionInputs(_signal?: AbortSignal) {
  return {};
}

export async function executeAccessResolutionPreview(input: PreviewInput) {
  const response = await fetch("/api/owner/access-resolution/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  });
  return readConsoleApiResponse<ResolutionTrace>(response, "Preview failed");
}
