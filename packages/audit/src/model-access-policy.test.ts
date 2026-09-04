import { describe, expect, it } from "vitest";
import {
  AUDIT_ACTIONS,
  AUDIT_ACTION_POLICY,
  COMPATIBILITY_AUDIT_ACTIONS,
  assertAuditApplicationWrite,
  assertAuditCompatibilityWrite,
  assertAuditEventDraft,
} from "./model-access-policy.js";

const reconciliationSuccess = {
  actor: { actorType: "user", actorId: "user_verification" },
  source: "owner",
  requestId: "req_audit_verification",
  action: "provider_invocation.reconcile_final",
  resourceType: "provider_invocation",
  resourceId: "attempt_verification",
  result: "success",
  metadata: {
    routePattern: "/api/owner/provider-invocations/:id/reconcile-final",
    evidenceKind: "provider_billing_record",
    evidenceRef: "billing/verification/attempt_verification",
    usageSource: "provider",
    billingEventId: "billing_verification",
    actualChargeUnits: "0",
    postingCreated: false,
  },
} as const;

const compatibilityEvent = {
  actor: { actorType: "user", actorId: "user_verification" },
  source: "owner",
  requestId: "req_compatibility_verification",
  action: "api_test.run",
  resource: { resourceType: "api_test", resourceId: "api_test_verification" },
  result: "success",
  metadata: { protocol: "responses", count: 1, enabled: true, ids: ["one", "two"] },
} as const;

function expectCode(callback: () => void, code: string): void {
  expect(callback).toThrowError(code);
}

describe("Audit closed policy", () => {
  it("keeps active and compatibility action vocabularies finite and disjoint", () => {
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
    expect(new Set(COMPATIBILITY_AUDIT_ACTIONS).size).toBe(COMPATIBILITY_AUDIT_ACTIONS.length);
    expect(AUDIT_ACTIONS.every((action) => action in AUDIT_ACTION_POLICY)).toBe(true);
    expect(AUDIT_ACTIONS.some((action) => (COMPATIBILITY_AUDIT_ACTIONS as readonly string[]).includes(action))).toBe(false);
  });

  it("accepts only the declared action result source resource and metadata shape", () => {
    expect(() => assertAuditEventDraft(reconciliationSuccess)).not.toThrow();
    expectCode(() => assertAuditEventDraft({ ...reconciliationSuccess, action: "provider_invocation.patch" }), "audit_action_invalid");
    expectCode(() => assertAuditEventDraft({ ...reconciliationSuccess, source: "internal" }), "audit_source_invalid");
    expectCode(() => assertAuditEventDraft({ ...reconciliationSuccess, result: "denied" }), "audit_result_invalid");
    expectCode(() => assertAuditEventDraft({ ...reconciliationSuccess, resourceType: "billing_event" }), "audit_resource_type_invalid");
    expectCode(() => assertAuditEventDraft({
      ...reconciliationSuccess,
      metadata: { ...reconciliationSuccess.metadata, unexpected: true },
    }), "audit_metadata_invalid");
  });

  it("rejects secret-shaped evidence and mismatched usage source before append", () => {
    expectCode(() => assertAuditEventDraft({
      ...reconciliationSuccess,
      metadata: { ...reconciliationSuccess.metadata, evidenceRef: "sk-proj-0123456789abcdef" },
    }), "audit_evidence_ref_invalid");
    expectCode(() => assertAuditEventDraft({
      ...reconciliationSuccess,
      metadata: { ...reconciliationSuccess.metadata, usageSource: "response" },
    }), "audit_usage_source_invalid");
  });

  it("routes active application writes through exact policy and excludes them from compatibility", () => {
    const applicationEvent = {
      actor: reconciliationSuccess.actor,
      source: reconciliationSuccess.source,
      requestId: reconciliationSuccess.requestId,
      action: reconciliationSuccess.action,
      resource: { resourceType: reconciliationSuccess.resourceType, resourceId: reconciliationSuccess.resourceId },
      result: reconciliationSuccess.result,
      metadata: reconciliationSuccess.metadata,
    };
    expect(() => assertAuditApplicationWrite(applicationEvent)).not.toThrow();
    expectCode(() => assertAuditApplicationWrite({
      ...applicationEvent,
      metadata: { ...applicationEvent.metadata, unexpected: true },
    }), "audit_metadata_invalid");
    expectCode(() => assertAuditCompatibilityWrite(applicationEvent), "audit_action_invalid");
  });

  it("keeps Request Capture reads on the request_capture resource and allowlisted metadata", () => {
    const event = {
      actor: { actorType: "user", actorId: "user_verification" },
      source: "web",
      requestId: "req_capture_audit_verification",
      action: "request_capture.read",
      resource: { resourceType: "request_capture", resourceId: "req_capture" },
      result: "denied",
      metadata: {
        routePattern: "/api/user/request-logs/:requestId/capture",
        requestId: "req_capture",
        format: "json",
        requestCaptureView: "original",
        effectiveCaptureStatus: "unavailable",
        effectiveRepresentation: null,
        errorCode: "request_log_not_found",
      },
    } as const;
    expect(() => assertAuditApplicationWrite(event)).not.toThrow();
    expectCode(() => assertAuditApplicationWrite({
      ...event,
      resource: { resourceType: "request_log", resourceId: "req_capture" },
    }), "audit_resource_type_invalid");
    expectCode(() => assertAuditApplicationWrite({
      ...event,
      metadata: { ...event.metadata, captureRequestPresent: false },
    }), "audit_metadata_invalid");
  });

  it("accepts a secret-free personal AP capacity rejection audit", () => {
    expect(() => assertAuditApplicationWrite({
      actor: { actorType: "user", actorId: "user_verification" },
      source: "web",
      requestId: "req_personal_ap_capacity",
      action: "access_point.create",
      resource: { resourceType: "access_point", resourceId: "pending" },
      result: "failure",
      metadata: { scopeRef: "user:user_verification", errorCode: "personal_access_point_limit_reached" },
    })).not.toThrow();
  });

  it("admits a secret-free Plan subscription revision failure audit", () => {
    expect(() => assertAuditApplicationWrite({
      actor: { actorType: "user", actorId: "owner_verification" },
      source: "owner",
      requestId: "req_plan_subscription_failure",
      action: "plan_subscription.update",
      resource: { resourceType: "plan_subscription", resourceId: "plan_sub_verification" },
      result: "failure",
      metadata: { errorCode: "P2022" },
    })).not.toThrow();
  });

  it("validates active price and authority-backed Team creation metadata", () => {
    expect(() => assertAuditApplicationWrite({
      actor: { actorType: "user", actorId: "owner_verification" },
      source: "owner",
      action: "access_point_price.create",
      resource: { resourceType: "access_point_price", resourceId: "price_verification" },
      result: "success",
      metadata: { accessPointId: "ap_verification", priceSource: "explicit", tierCount: 0 },
    })).not.toThrow();
    expect(() => assertAuditApplicationWrite({
      actor: { actorType: "user", actorId: "user_verification" },
      source: "web",
      action: "team.create",
      resource: { resourceType: "team", resourceId: "team_verification" },
      result: "success",
      metadata: { ownerId: "user_verification", authorityUseId: "use_verification", grantQuotaId: "quota_verification" },
    })).not.toThrow();
  });

  it("accepts allowlisted password failure and Team deletion denial outcomes", () => {
    expect(() => assertAuditApplicationWrite({
      actor: { actorType: "user", actorId: "user_verification" },
      source: "web",
      action: "auth.password_change",
      resource: { resourceType: "user", resourceId: "user_verification" },
      result: "failure",
      metadata: { failureCategory: "invalid_password" },
    })).not.toThrow();
    expect(() => assertAuditApplicationWrite({
      actor: { actorType: "user", actorId: "user_verification" },
      source: "owner",
      action: "auth.password_change",
      resource: { resourceType: "user", resourceId: "user_verification" },
      result: "denied",
      metadata: { bucketCategory: "client_ip" },
    })).not.toThrow();
    expect(() => assertAuditApplicationWrite({
      actor: { actorType: "user", actorId: "user_verification" },
      source: "owner",
      action: "team.delete.request",
      resource: { resourceType: "team", resourceId: "team_verification" },
      result: "denied",
      metadata: {
        teamId: "team_verification",
        name: "Verification Team",
        status: "enabled",
        blockers: [],
        errorCode: "forbidden",
      },
    })).not.toThrow();
  });

  it("limits compatibility writes to safe scalar or bounded-array metadata", () => {
    expect(() => assertAuditApplicationWrite(compatibilityEvent)).not.toThrow();
    expect(() => assertAuditCompatibilityWrite(compatibilityEvent)).not.toThrow();
    expectCode(() => assertAuditCompatibilityWrite({ ...compatibilityEvent, action: "arbitrary.audit.write" }), "audit_action_invalid");
    expectCode(() => assertAuditCompatibilityWrite({
      ...compatibilityEvent,
      metadata: { nested: { value: "not allowed" } },
    }), "audit_metadata_value_invalid");
    expectCode(() => assertAuditCompatibilityWrite({
      ...compatibilityEvent,
      metadata: { authorizationHeader: "redacted" },
    }), "audit_metadata_sensitive_key");
    expectCode(() => assertAuditCompatibilityWrite({
      ...compatibilityEvent,
      metadata: { requestBody: "redacted" },
    }), "audit_metadata_sensitive_key");
    expectCode(() => assertAuditCompatibilityWrite({
      ...compatibilityEvent,
      metadata: { captureHash: "redacted" },
    }), "audit_metadata_sensitive_key");
  });
});
