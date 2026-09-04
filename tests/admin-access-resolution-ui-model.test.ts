import { describe, expect, it } from "vitest";
import { previewFormDefaults, toPreviewInput, validatePreviewField } from "../apps/admin/features/access-resolution/form/access-resolution-form-values";
import { accessResolutionQueryKeys } from "../apps/admin/features/access-resolution/query/access-resolution-query-keys";

describe("Admin Access Resolution Preview UI model", () => {
  it("creates stable defaults and trims only the requested model DTO field", () => {
    expect(previewFormDefaults("key-1", "ap-1")).toEqual({ apiKeyId: "key-1", accessPointId: "ap-1", reqModel: "gpt-4o-mini" });
    expect(toPreviewInput({ apiKeyId: "key-1", accessPointId: "ap-1", reqModel: "  model-a  " })).toEqual({ apiKeyId: "key-1", accessPointId: "ap-1", reqModel: "model-a" });
  });

  it("validates blank fields without duplicating server resolution rules", () => {
    expect(validatePreviewField(" ", "requestedModel")).toBe("requestedModel is required");
    expect(validatePreviewField("model-a", "requestedModel")).toBeUndefined();
  });

  it("keeps API key, model, body, and credential values out of the query key", () => {
    expect(accessResolutionQueryKeys.inputs()).toEqual(["owner", "access-resolution", "inputs"]);
    const serialized = JSON.stringify(accessResolutionQueryKeys.inputs());
    expect(serialized).not.toContain("apiKeyId");
    expect(serialized).not.toContain("reqModel");
    expect(serialized).not.toContain("credential");
  });
});
