import type { PreviewInput } from "../types";

export function previewFormDefaults(apiKeyId = "", accessPointId = ""): PreviewInput {
  return { apiKeyId, accessPointId, reqModel: "gpt-4o-mini" };
}

export function validatePreviewField(value: string, label: string) {
  return value.trim() ? undefined : `${label} is required`;
}

export function toPreviewInput(values: PreviewInput): PreviewInput {
  return { apiKeyId: values.apiKeyId, accessPointId: values.accessPointId, reqModel: values.reqModel.trim() };
}
