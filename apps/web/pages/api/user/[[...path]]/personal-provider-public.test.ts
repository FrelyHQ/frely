import { describe, expect, test } from "vitest";
import {
  publicPersonalOAuthStatus,
  publicPersonalProvider,
  publicPersonalProviderModel,
  publicPersonalProviderSlot,
} from "./personal-provider-public.js";

describe("personal Provider public projections", () => {
  test("OAuth status excludes credential, credential refs, previews, auth-file identity, and unknown CPA fields", () => {
    const value = publicPersonalOAuthStatus({
      status: "ready",
      credential: { credentialRef: "secret-ref", token: "secret" },
      credentialRef: "secret-ref",
      authFile: { id: "internal-auth-file" },
      internalUrl: "http://internal.example",
      unknown: "internal",
      binding: {
        revision: 7,
        syncStatus: "ready",
        credentialRefsJson: "[\"secret-ref\"]",
        credentialPreview: "secret-preview",
        errorCode: "internal",
      },
    });

    expect(value).toEqual({ status: "ready", binding: { revision: 7, syncStatus: "ready" } });
    expect(JSON.stringify(value)).not.toMatch(/credential|authFile|internal|secret/u);
  });

  test("Provider, model, and slot summaries include only allowlisted public fields", () => {
    const internalProvider = {
      id: "prv_1", name: "Personal", kind: "codex", status: "disabled", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      configJson: "{\"secret\":true}", credentialResolver: "oauth:secret", baseUrlResolver: "literal:http://internal", modelsResolver: "internal", cpaInstanceId: "cpa_default",
    };
    const internalModel = {
      id: "model_1", providerId: "prv_1", providerModelName: "gpt", displayName: "GPT", status: "disabled", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      credentialRef: "secret-ref",
    };
    const provider = publicPersonalProvider(internalProvider);
    const model = publicPersonalProviderModel(internalModel);
    const slot = publicPersonalProviderSlot({
      id: "slot_1", userId: "user_1", scopeRef: "user:user_1", managedPlanId: "plan_internal", providerId: "prv_1",
      createdByAuthorityPurchaseId: "purchase_internal", retentionExpiredAt: null, cleanupStatus: "not_due", cleanupErrorCode: null,
      cleanupUpdatedAt: null, createdAt: "2026-01-01T00:00:00.000Z", latestEffectiveEnd: "2027-01-01T00:00:00.000Z",
      renewalCutoff: "2027-06-30T00:00:00.000Z", lifecycle: "active", usedAccessPoints: 1, maxAccessPoints: 100,
    });

    expect(Object.keys(provider)).toEqual(["id", "name", "kind", "status", "createdAt", "updatedAt"]);
    expect(Object.keys(model)).toEqual(["id", "providerId", "providerModelName", "displayName", "status", "createdAt", "updatedAt"]);
    expect(slot).not.toHaveProperty("managedPlanId");
    expect(slot).not.toHaveProperty("userId");
    expect(slot).not.toHaveProperty("createdByAuthorityPurchaseId");
  });
});
