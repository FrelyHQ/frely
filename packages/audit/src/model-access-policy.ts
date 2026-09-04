import { isSafeExternalEvidenceRef } from "@frely/core";

export const MODEL_ACCESS_AUDIT_ACTIONS = [
  "access_point.create",
  "access_point.update",
  "access_point.remove",
  "provider.create",
  "provider.update",
  "provider.delete",
  "provider_model.upsert",
  "provider_model.sync",
] as const;

export const BILLING_AUDIT_ACTIONS = [
  "access_point_price.create",
  "personal_access_point_zero_price.ensure",
  "personal_provider_model_zero_cost.ensure",
] as const;
export const PROVIDER_INVOCATION_AUDIT_ACTIONS = ["provider_invocation.reconcile_final"] as const;
export const SENSITIVE_READ_AUDIT_ACTIONS = [
  "audit_log.read", "request_log.read", "usage_log.read",
  "request_capture.read", "request_capture.download",
  "provider_credential.read_summary", "provider_summary.read", "access_resolution.preview", "external_price.lookup",
  "plan_budget_usage.read", "provider_invocation.reconciliation_read",
] as const;

// Closed compatibility vocabulary for action families that have not yet moved to
// AuditEventDraft. Compatibility writers may accept only these names and safe
// metadata values; new application append callers must use AuditEventDraft.
export const COMPATIBILITY_AUDIT_ACTIONS = [
  "access_order.move", "access_order.replace", "access_point_price.update",
  "admin_grant_batch.create", "api_test.curl_copy", "api_test.run",
  "budget_policy.create", "budget_policy.delete", "budget_policy.update",
  "card.activation_batch.create", "card.activation_batch.export", "card.activation_batch.revoke",
  "card.activation_code.redeem", "card.activation_code.revoke", "card.admin_grant", "card.purchase", "card.send", "card.use",
  "card_transfer.read", "chat.run", "credit_ledger_event.create",
  "credit_topup.approve", "credit_topup.cancel", "credit_topup.create", "credit_topup.payment_submit",
  "credit_topup.refund_note.record", "credit_topup.reject", "credit_topup.reverse", "credit_topup.stripe_checkout_complete",
  "credit_topup.stripe_checkout_create", "credit_topup_attachment.create", "credit_topup_attachment.read",
  "credit_product.create", "credit_product.disable", "credit_product_listing.create", "credit_product_listing.disable", "credit_product_listing.switch_channel",
  "credit_transfer.create", "credit_transfer_policy.update",
  "domain_binding.activate", "domain_binding.create", "domain_binding.disable", "domain_binding.disabled", "domain_binding.enable", "domain_binding.released", "domain_binding.slot_grant", "domain_binding.verify",
  "gateway.request.failed_policy", "governance_budget_policy.create", "governance_budget_policy.delete", "governance_budget_policy.update",
  "ingress_plugin_setting.update", "partner_team.create",
  "payment_channel.create", "payment_channel.disable", "payment_channel.enable",
  "payment_channel_instruction_attachment.create", "payment_channel_instruction_attachment.read",
  "pipeline_plugin_setting.update", "plan.cards.replace", "plan_access_point_price.create", "plan_access_point_price.update",
  "plan_payment_listing.create", "plan_payment_listing.disable",
  "plan_purchase.create", "plan_purchase.reverse", "plan_purchase.stripe_checkout_complete",
  "provider_binding.reconcile", "provider_binding.reconcile_batch", "provider_credential.clear", "provider_credential.import", "provider_credential.replace",
  "provider_model_cost.create", "provider_model_cost.update", "provider_oauth.callback", "provider_oauth.start", "provider_oauth.status",
  "public_host.create", "public_host.delete", "public_host.disable", "public_host.enable", "public_host.update",
  "request_capture.update", "resource_permission.update", "scope_budget_policy.delete", "scope_budget_policy.update",
  "scope_governance_budget_policy.create", "scope_governance_budget_policy.delete", "scope_governance_budget_policy.update",
  "service_order.approve", "service_order.cancel", "service_order.create", "service_order.fulfillment_blocked", "service_order.fulfillment_retry",
  "service_order.payment_submit", "service_order.reject", "service_product.create", "service_product.status_update",
  "service_product_listing.create", "service_product_listing.status_update",
  "team.access_point.create", "team.ap_price.append", "team.billing.read", "team.credit.read", "team.expense_safety_check.read",
  "team.invite_link.create", "team.member.read", "team.member.update", "team.owner.update", "team.provider.create", "team.read", "team.usage.read",
  "user.domain_binding.manage", "web_registration_setting.update",
] as const;
export const AUTHORITY_ENTITLEMENT_AUDIT_ACTIONS = [
  "authority_grant.bootstrap", "authority_grant.cancel", "authority_grant.consume", "platform_owner.handover",
  "authority_product.create", "authority_product.update", "authority_product.list", "authority_product.close",
  "authority_purchase.create", "authority_purchase.refund",
  "plan.create", "plan.update", "plan.delete",
  "plan_subscription.create", "plan_subscription.cancel", "plan_subscription.update", "plan_subscription.delete",
  "api_key.plan_source_restriction.replace",
  "team_provider_entitlement.grant", "team_provider_entitlement.cancel", "team_provider_entitlement.purchase",
  "personal_provider_slot.purchase", "personal_provider_slot.renew", "personal_provider_slot.retention_finalize",
  "partner_operating_entitlement.create", "partner_operating_entitlement.cancel",
] as const;
export const IDENTITY_TENANCY_AUDIT_ACTIONS = [
  "auth.login", "auth.logout", "auth.refresh", "auth.password_change", "oidc.authorization",
  "auth.passkey.register", "auth.passkey.list", "auth.passkey.rename", "auth.passkey.delete",
  "api_key.create", "api_key.copy", "api_key.revoke", "api_key.disable", "api_key.enable",
  "user.create", "user.update",
  "team.create", "team.update", "team.delete.request", "team.delete.cancel", "team.owner.transfer",
  "team_membership.fallback_join", "team_member.add", "team_member.remove", "team_member_roles.update",
  "team_invite_link.create", "team_invite_link.disable", "team_invite_link.accept", "team_invite_setting.update",
  "identity.email_upgrade.canonicalize", "identity.email_upgrade.freeze", "identity.email_upgrade.merge",
] as const;
export const AUDIT_ACTIONS = [
  ...MODEL_ACCESS_AUDIT_ACTIONS,
  ...BILLING_AUDIT_ACTIONS,
  ...PROVIDER_INVOCATION_AUDIT_ACTIONS,
  ...SENSITIVE_READ_AUDIT_ACTIONS,
  ...AUTHORITY_ENTITLEMENT_AUDIT_ACTIONS,
  ...IDENTITY_TENANCY_AUDIT_ACTIONS,
] as const;

export type AuditActorType = "user" | "api_key" | "system";
export type AuditSource = "owner" | "web" | "gateway" | "system";
export type AuditResult = "success" | "failure" | "denied";
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
export type CompatibilityAuditAction = (typeof COMPATIBILITY_AUDIT_ACTIONS)[number];
export type AuditActionName = AuditAction | CompatibilityAuditAction;
export type AuditMetadataValue = string | number | boolean | null | readonly AuditMetadataValue[];
export type ModelAccessAuditAction = (typeof MODEL_ACCESS_AUDIT_ACTIONS)[number];
export type ModelAccessAuditResourceType = "access_point" | "provider" | "provider_model";

export interface AuditActor {
  actorType: AuditActorType;
  actorId: string;
}

export interface AuditInput {
  actor: AuditActor;
  source: AuditSource;
  requestId?: string | null;
}

export type ModelAccessAuditInput = AuditInput;

/** Validated nested event accepted by the narrow Audit command compatibility facade. */
export interface AuditApplicationEvent {
  actor: AuditActor;
  source: AuditSource;
  requestId?: string | null | undefined;
  action: AuditActionName;
  resource: { resourceType: string; resourceId: string };
  result: AuditResult;
  metadata?: Readonly<Record<string, AuditMetadataValue>> | undefined;
  ipHash?: string | null | undefined;
  userAgentHash?: string | null | undefined;
}

interface ModelAccessAuditEventBase<
  Action extends AuditAction,
  ResourceType extends string,
  Result extends AuditResult,
  Metadata,
> extends AuditInput {
  action: Action;
  resourceType: ResourceType;
  resourceId: string;
  result: Result;
  metadata: Metadata;
}

type AccessPointCreateAuditEvent = ModelAccessAuditEventBase<
  "access_point.create",
  "access_point",
  "success" | "denied" | "failure",
  | { accessPointId: string; scopeRef: string }
  | { scopeRef: string; errorCode: string }
>;

type AccessPointUpdateAuditEvent = ModelAccessAuditEventBase<
  "access_point.update",
  "access_point",
  "success",
  {
    accessPointId: string;
    oldRoutingRevision: number;
    newRoutingRevision: number;
    routingChanged: boolean;
    descriptionChanged: boolean;
    targetEdgeCount: number;
  }
>;

type AccessPointRemoveAuditEvent = ModelAccessAuditEventBase<
  "access_point.remove",
  "access_point",
  "success",
  {
    accessPointId: string;
    routingRevision: number;
  }
>;

interface ProviderDefinitionAuditMetadata {
  providerId: string;
  ownerId: string;
  scopeRef: string;
  kind: string;
  status: "enabled" | "disabled";
  baseUrlResolverName: string;
  credentialResolverName: string;
  modelsResolverName: string;
}

type ProviderCreateAuditEvent = ModelAccessAuditEventBase<
  "provider.create",
  "provider",
  "success",
  ProviderDefinitionAuditMetadata
>;

type ProviderUpdateAuditEvent = ModelAccessAuditEventBase<
  "provider.update",
  "provider",
  "success",
  | (ProviderDefinitionAuditMetadata & { materialChanged: boolean })
  | {
      providerId: string;
      status: "enabled" | "disabled";
      statusChanged: boolean;
      reason?: string;
    }
>;

type ProviderDeleteAuditEvent = ModelAccessAuditEventBase<
  "provider.delete",
  "provider",
  "success",
  {
    providerId: string;
    deleted: true;
  }
>;

type ProviderModelUpsertAuditEvent = ModelAccessAuditEventBase<
  "provider_model.upsert",
  "provider_model",
  "success",
  {
    providerId: string;
    providerModelId: string;
    status: "enabled" | "disabled";
    changed: boolean;
  }
>;

type ProviderModelSyncAuditEvent = ModelAccessAuditEventBase<
  "provider_model.sync",
  "provider",
  "success",
  {
    providerId: string;
    observed: number;
    created: number;
  }
>;

export type ModelAccessAuditEventDraft =
  | AccessPointCreateAuditEvent
  | AccessPointUpdateAuditEvent
  | AccessPointRemoveAuditEvent
  | ProviderCreateAuditEvent
  | ProviderUpdateAuditEvent
  | ProviderDeleteAuditEvent
  | ProviderModelUpsertAuditEvent
  | ProviderModelSyncAuditEvent;

export type AuthorityEntitlementAuditAction = (typeof AUTHORITY_ENTITLEMENT_AUDIT_ACTIONS)[number];
export type AuthorityEntitlementAuditEventDraft = ModelAccessAuditEventBase<
  AuthorityEntitlementAuditAction,
  "authority_grant" | "authority_product" | "authority_purchase" | "authority_use" | "plan" | "plan_subscription" | "api_key" | "team_provider_entitlement" | "personal_provider_slot" | "partner_operating_entitlement",
  AuditResult,
  Readonly<Record<string, AuditMetadataValue>>
>;

export type IdentityTenancyAuditAction = (typeof IDENTITY_TENANCY_AUDIT_ACTIONS)[number];
export type IdentityTenancyAuditEventDraft = ModelAccessAuditEventBase<
  IdentityTenancyAuditAction,
  "user" | "api_key" | "passkey" | "oidc_client" | "team" | "team_membership" | "team_invite_link",
  AuditResult,
  Readonly<Record<string, AuditMetadataValue>>
>;

type AccessPointInitialPriceAuditEvent = ModelAccessAuditEventBase<
  "access_point_price.create",
  "access_point_price",
  "success",
  {
    accessPointId: string;
    priceSource: "explicit" | "target_copy";
    tierCount: number;
  }
>;

type ProviderInvocationReconciliationSuccessAuditEvent = ModelAccessAuditEventBase<
  "provider_invocation.reconcile_final",
  "provider_invocation",
  "success",
  {
    routePattern: "/api/owner/provider-invocations/:id/reconcile-final";
    evidenceKind: "provider_operation_query" | "provider_billing_record" | "provider_response";
    evidenceRef: string;
    usageSource: "provider" | "response";
    billingEventId: string;
    actualChargeUnits: string;
    postingCreated: boolean;
  }
>;

type ProviderInvocationReconciliationFailureAuditEvent = ModelAccessAuditEventBase<
  "provider_invocation.reconcile_final",
  "provider_invocation",
  "failure",
  {
    routePattern: "/api/owner/provider-invocations/:id/reconcile-final";
    evidenceKind: "provider_operation_query" | "provider_billing_record" | "provider_response";
    evidenceRef: string;
    usageSource: "provider" | "response";
    errorCode: string;
  }
>;

type PersonalAccessPointZeroPriceAuditEvent = ModelAccessAuditEventBase<
  "personal_access_point_zero_price.ensure",
  "access_point_price",
  "success",
  { accessPointId: string; planId: string; basePriceCreated: boolean; planOverrideCreated: boolean; zeroPrice: true }
>;

type PersonalProviderModelZeroCostAuditEvent = ModelAccessAuditEventBase<
  "personal_provider_model_zero_cost.ensure",
  "provider_model_cost",
  "success",
  { providerId: string; providerModelName: string; costCreated: boolean; zeroCost: true }
>;

export type BillingAuditEventDraft = AccessPointInitialPriceAuditEvent | PersonalAccessPointZeroPriceAuditEvent | PersonalProviderModelZeroCostAuditEvent;
export type ProviderInvocationAuditEventDraft =
  | ProviderInvocationReconciliationSuccessAuditEvent
  | ProviderInvocationReconciliationFailureAuditEvent;
export type SensitiveReadAuditAction = (typeof SENSITIVE_READ_AUDIT_ACTIONS)[number];
export type SensitiveReadAuditEventDraft = ModelAccessAuditEventBase<
  SensitiveReadAuditAction,
  "audit_log" | "request_log" | "usage_log" | "request_capture" | "provider" | "access_resolution" | "provider_model_cost" | "plan_subscription" | "provider_invocation",
  "success" | "failure" | "denied",
  Readonly<Record<string, AuditMetadataValue>>
>;
export type AuditEventDraft = ModelAccessAuditEventDraft | BillingAuditEventDraft | ProviderInvocationAuditEventDraft | SensitiveReadAuditEventDraft | AuthorityEntitlementAuditEventDraft | IdentityTenancyAuditEventDraft;

export const MODEL_ACCESS_AUDIT_ACTION_POLICY = {
  "access_point.create": { resourceType: "access_point", results: ["success", "denied", "failure"] },
  "access_point.update": { resourceType: "access_point", results: ["success"] },
  "access_point.remove": { resourceType: "access_point", results: ["success"] },
  "provider.create": { resourceType: "provider", results: ["success"] },
  "provider.update": { resourceType: "provider", results: ["success"] },
  "provider.delete": { resourceType: "provider", results: ["success"] },
  "provider_model.upsert": { resourceType: "provider_model", results: ["success"] },
  "provider_model.sync": { resourceType: "provider", results: ["success"] },
} as const satisfies Record<ModelAccessAuditAction, {
  resourceType: ModelAccessAuditResourceType;
  results: readonly AuditResult[];
}>;

export const AUTHORITY_ENTITLEMENT_AUDIT_ACTION_POLICY = {
  "authority_grant.bootstrap": policy("authority_grant", ["success"], ["beneficiaryUserId", "sourceKind"]),
  "authority_grant.cancel": policy("authority_grant", ["success"], ["reasonCode", "sourceKind"]),
  "authority_grant.consume": policy("authority_use", ["success"], ["grantQuotaId", "teamId", "ownerUserId"]),
  "platform_owner.handover": policy("authority_grant", ["success"], ["previousOwnerUserId", "nextOwnerUserId", "previousGrantId"]),
  "authority_product.create": policy("authority_product", ["success"], ["code", "version", "effectCode", "lifecycle"]),
  "authority_product.update": policy("authority_product", ["success"], ["code", "version", "lifecycle"]),
  "authority_product.list": policy("authority_product", ["success"], ["code", "version", "replacedProductId"]),
  "authority_product.close": policy("authority_product", ["success"], ["code", "version"]),
  "authority_purchase.create": policy("authority_purchase", ["success"], ["productId", "productCode", "productVersion", "grantUnits", "purchaseAmountUnits"]),
  "authority_purchase.refund": policy("authority_purchase", ["success"], ["refundId", "grantId", "reasonCode", "purchaseAmountUnits"]),
  "plan.create": policy("plan", ["success"], ["ownerId", "scopeRef", "version", "status", "accessPointCount", "budgetLimitCount"]),
  "plan.update": policy("plan", ["success"], ["ownerId", "scopeRef", "version", "oldStatus", "newStatus", "oldCatalogStatus", "newCatalogStatus"]),
  "plan.delete": policy("plan", ["success"], ["id"]),
  "plan_subscription.create": policy("plan_subscription", ["success"], ["scopeRef", "planId", "effectiveStart", "effectiveEnd", "priority", "source"]),
  "plan_subscription.cancel": policy("plan_subscription", ["success"], ["scopeRef", "planId", "effectiveEnd", "lifecycle"]),
  "plan_subscription.update": policy("plan_subscription", ["success", "failure"], ["scopeRef", "planId", "effectiveEnd", "priority", "lifecycle", "changedFields", "errorCode"]),
  "plan_subscription.delete": policy("plan_subscription", ["success"], ["id"]),
  "api_key.plan_source_restriction.replace": policy("api_key", ["success"], ["mode", "sourceCount", "teamCount"]),
  "team_provider_entitlement.grant": policy("team_provider_entitlement", ["success"], ["teamId", "productId", "productCode", "productVersion", "effectiveStart", "effectiveEnd"]),
  "team_provider_entitlement.cancel": policy("team_provider_entitlement", ["success"], ["teamId", "reasonCode", "sourceKind"]),
  "team_provider_entitlement.purchase": policy("team_provider_entitlement", ["success"], ["teamId", "productId", "productCode", "productVersion", "purchaseAmountUnits", "effectiveStart", "effectiveEnd"]),
  "personal_provider_slot.purchase": policy("personal_provider_slot", ["success"], ["productId", "productVersion", "periodId", "effectiveStart", "effectiveEnd", "durationDays"]),
  "personal_provider_slot.renew": policy("personal_provider_slot", ["success"], ["productId", "productVersion", "periodId", "effectiveStart", "effectiveEnd", "durationDays"]),
  "personal_provider_slot.retention_finalize": policy("personal_provider_slot", ["success"], ["renewalCutoff", "initiatedBy", "cleanupStatus"]),
  "partner_operating_entitlement.create": policy("partner_operating_entitlement", ["success"], ["sourceOrderId", "ownerUserId", "partnerTeamId", "planId", "subscriptionId", "effectiveStart", "effectiveEnd"]),
  "partner_operating_entitlement.cancel": policy("partner_operating_entitlement", ["success"], ["reasonCode", "effectiveEnd"]),
} as const satisfies Record<AuthorityEntitlementAuditAction, {
  resourceType: string;
  results: readonly AuditResult[];
  metadataKeys: readonly string[];
}>;

export const IDENTITY_TENANCY_AUDIT_ACTION_POLICY = {
  "auth.login": policy("user", ["success", "failure"], ["teamIds", "platformRoles", "teamRoles", "method", "errorCode"]),
  "auth.logout": policy("user", ["success"], ["refreshTokenId", "sessionId"]),
  "auth.refresh": policy("user", ["success"], ["refreshTokenId"]),
  "auth.password_change": policy("user", ["success", "failure", "denied"], ["surface", "otherSessionsRevoked", "failureCategory", "bucketCategory"]),
  "oidc.authorization": policy("oidc_client", ["success", "denied"], ["clientId", "scope", "result"]),
  "auth.passkey.register": policy("passkey", ["success"], []),
  "auth.passkey.list": policy("user", ["success"], ["passkeyCount"]),
  "auth.passkey.rename": policy("passkey", ["success"], []),
  "auth.passkey.delete": policy("passkey", ["success"], ["otherSessionsRevoked"]),
  "api_key.create": policy("api_key", ["success"], ["userId", "name", "expiresAt"]),
  "api_key.copy": policy("api_key", ["success", "failure", "denied"], ["userId", "status", "errorCode"]),
  "api_key.revoke": policy("api_key", ["success"], ["userId", "name"]),
  "api_key.disable": policy("api_key", ["success"], ["userId", "name"]),
  "api_key.enable": policy("api_key", ["success"], ["userId", "name"]),
  "user.create": policy("user", ["success"], ["teamId", "status"]),
  "user.update": policy("user", ["success"], ["field", "fields", "apiKeyLimit"]),
  "team.create": policy("team", ["success"], ["name", "ownerId", "status", "authorityUseId", "grantQuotaId"]),
  "team.update": policy("team", ["success"], ["teamId", "name", "status"]),
  "team.delete.request": policy("team", ["success", "denied"], ["teamId", "purgeNotBefore", "name", "status", "blockers", "errorCode"]),
  "team.delete.cancel": policy("team", ["success"], ["teamId", "deletionRequestId"]),
  "team.owner.transfer": policy("team", ["success"], ["previousOwnerUserId", "nextOwnerUserId"]),
  "team_membership.fallback_join": policy("team_membership", ["success"], ["teamId", "reason"]),
  "team_member.add": policy("team_membership", ["success"], ["teamId", "userId"]),
  "team_member.remove": policy("team_membership", ["success"], ["teamId", "userId"]),
  "team_member_roles.update": policy("team_membership", ["success"], ["teamId", "targetUserId", "roles"]),
  "team_invite_link.create": policy("team_invite_link", ["success"], ["inviteLinkId", "teamId", "createdByUserId", "capacityMode", "maxUses", "outcome"]),
  "team_invite_link.disable": policy("team_invite_link", ["success"], ["inviteLinkId", "teamId", "creatorId", "reason", "usedCount", "maxUses"]),
  "team_invite_link.accept": policy("team_membership", ["success"], ["inviteLinkId", "teamId", "userId", "membershipId", "outcome", "usedCount", "maxUses"]),
  "team_invite_setting.update": policy("team", ["success"], ["teamId", "changedFields", "enabled", "emailDomainRestricted", "disabledMemberLinkCount"]),
  "identity.email_upgrade.canonicalize": policy("user", ["success"], ["batchId", "ruleVersion"]),
  "identity.email_upgrade.freeze": policy("user", ["success"], ["batchId", "survivorUserId", "conflictTypes", "ruleVersion"]),
  "identity.email_upgrade.merge": policy("user", ["success"], ["batchId", "survivorUserId", "ruleVersion"]),
} as const satisfies Record<IdentityTenancyAuditAction, {
  resourceType: string;
  results: readonly AuditResult[];
  metadataKeys: readonly string[];
}>;

export const AUDIT_ACTION_POLICY = {
  ...MODEL_ACCESS_AUDIT_ACTION_POLICY,
  "access_point_price.create": { resourceType: "access_point_price", results: ["success"] },
  "personal_access_point_zero_price.ensure": policy("access_point_price", ["success"], ["accessPointId", "planId", "basePriceCreated", "planOverrideCreated", "zeroPrice"]),
  "personal_provider_model_zero_cost.ensure": policy("provider_model_cost", ["success"], ["providerId", "providerModelName", "costCreated", "zeroCost"]),
  "provider_invocation.reconcile_final": { resourceType: "provider_invocation", results: ["success", "failure"] },
  "audit_log.read": policy("audit_log", ["success", "failure"], ["routePattern", "count", "errorCode"]),
  "request_log.read": policy("request_log", ["success", "failure"], ["routePattern", "errorCode"]),
  "usage_log.read": policy("usage_log", ["success", "failure"], ["routePattern", "apiKeyId", "errorCode"]),
  "request_capture.read": policy("request_capture", ["success", "failure", "denied"], ["routePattern", "requestId", "apiKeyId", "format", "requestCaptureView", "effectiveCaptureStatus", "effectiveRepresentation", "count", "errorCode"]),
  "request_capture.download": policy("request_capture", ["success", "failure", "denied"], ["routePattern", "requestId", "apiKeyId", "format", "start", "end", "userId", "teamId", "status", "kind", "reqModel", "count", "missingCount", "byteCount", "errorCode"]),
  "provider_credential.read_summary": policy("provider", ["success", "failure"], ["routePattern", "providerId", "credentialType", "configured", "count", "errorCode"]),
  "provider_summary.read": policy("provider", ["success", "failure", "denied"], ["routePattern", "slotId", "slotCount", "providerCount", "modelCount", "page", "pageSize", "errorCode"]),
  "access_resolution.preview": policy("access_resolution", ["success", "failure"], ["routePattern", "apiKeyId", "userId", "effectiveScopeCount", "reqModel", "accessPointId", "errorCode"]),
  "external_price.lookup": policy("provider_model_cost", ["success", "failure"], ["routePattern", "providerId", "providerModelName", "errorCode"]),
  "plan_budget_usage.read": policy("plan_subscription", ["success", "failure"], ["routePattern", "subscriptionId", "targetUserId", "teamId", "scopeRef", "perspective", "calculatedAt", "count", "errorCode"]),
  "provider_invocation.reconciliation_read": policy("provider_invocation", ["success", "failure"], ["routePattern", "limit", "count", "errorCode"]),
  ...AUTHORITY_ENTITLEMENT_AUDIT_ACTION_POLICY,
  ...IDENTITY_TENANCY_AUDIT_ACTION_POLICY,
} as const satisfies Record<AuditAction, {
  resourceType: string;
  results: readonly AuditResult[];
}>;

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,191}$/u;
const STABLE_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,191}$/u;

export function assertAuditApplicationWrite(value: unknown): void {
  const candidate = requireRecord(value, "audit_event_invalid");
  if (typeof candidate.action === "string" && (AUDIT_ACTIONS as readonly string[]).includes(candidate.action)) {
    const event = requireExactRecord(value, [
      "actor", "source", "requestId", "action", "resource", "result", "metadata", "ipHash", "userAgentHash",
    ], ["requestId", "metadata", "ipHash", "userAgentHash"], "audit_event_invalid");
    const resource = requireExactRecord(event.resource, ["resourceType", "resourceId"], [], "audit_resource_invalid");
    if (event.ipHash !== undefined && event.ipHash !== null) requirePattern(event.ipHash, STABLE_CODE_PATTERN, "audit_ip_hash_invalid");
    if (event.userAgentHash !== undefined && event.userAgentHash !== null) requirePattern(event.userAgentHash, STABLE_CODE_PATTERN, "audit_user_agent_hash_invalid");
    assertAuditEventDraft({
      actor: event.actor,
      source: event.source,
      ...(event.requestId !== undefined ? { requestId: event.requestId } : {}),
      action: event.action,
      resourceType: resource.resourceType,
      resourceId: resource.resourceId,
      result: event.result,
      metadata: event.metadata ?? {},
    });
    return;
  }
  assertAuditCompatibilityWrite(value);
}

export function assertAuditCompatibilityWrite(value: unknown): void {
  const event = requireExactRecord(value, [
    "actor", "source", "requestId", "action", "resource", "result", "metadata", "ipHash", "userAgentHash",
  ], ["requestId", "metadata", "ipHash", "userAgentHash"], "audit_event_invalid");
  assertAuditActor(event.actor);
  requireEnum(event.source, ["owner", "web", "gateway", "system"], "audit_source_invalid");
  requireEnum(event.result, ["success", "failure", "denied"], "audit_result_invalid");
  requireEnum(event.action, COMPATIBILITY_AUDIT_ACTIONS, "audit_action_invalid");
  const resource = requireExactRecord(event.resource, ["resourceType", "resourceId"], [], "audit_resource_invalid");
  requirePattern(resource.resourceType, STABLE_CODE_PATTERN, "audit_resource_type_invalid");
  requireNonEmptyString(resource.resourceId, "audit_resource_id_invalid");
  if (event.requestId !== undefined && event.requestId !== null) requirePattern(event.requestId, REQUEST_ID_PATTERN, "audit_request_id_invalid");
  if (event.ipHash !== undefined && event.ipHash !== null) requirePattern(event.ipHash, STABLE_CODE_PATTERN, "audit_ip_hash_invalid");
  if (event.userAgentHash !== undefined && event.userAgentHash !== null) requirePattern(event.userAgentHash, STABLE_CODE_PATTERN, "audit_user_agent_hash_invalid");
  const metadata = event.metadata === undefined ? {} : requireRecord(event.metadata, "audit_metadata_invalid");
  assertSafeMetadataValues(metadata);
}

export function assertAuditEventDraft(value: unknown): asserts value is AuditEventDraft {
  const event = requireExactRecord(value, [
    "actor", "source", "requestId", "action", "resourceType", "resourceId", "result", "metadata",
  ], ["requestId"], "audit_event_invalid");
  assertAuditActor(event.actor);
  requireEnum(event.source, ["owner", "web", "gateway", "system"], "audit_source_invalid");
  if (event.requestId !== undefined && event.requestId !== null) {
    requirePattern(event.requestId, REQUEST_ID_PATTERN, "audit_request_id_invalid");
  }
  const action = requireEnum(event.action, AUDIT_ACTIONS, "audit_action_invalid");
  const policy = AUDIT_ACTION_POLICY[action];
  if (event.resourceType !== policy.resourceType) throw new Error("audit_resource_type_invalid");
  const resourceId = requireNonEmptyString(event.resourceId, "audit_resource_id_invalid");
  const result = requireEnum(event.result, policy.results, "audit_result_invalid");
  assertActionMetadata(action, result, resourceId, event.metadata);
}

function assertAuditActor(value: unknown): void {
  const actor = requireExactRecord(value, ["actorType", "actorId"], [], "audit_actor_invalid");
  requireEnum(actor.actorType, ["user", "api_key", "system"], "audit_actor_type_invalid");
  requireNonEmptyString(actor.actorId, "audit_actor_id_invalid");
}

function assertActionMetadata(
  action: AuditAction,
  result: AuditResult,
  resourceId: string,
  value: unknown,
): void {
  switch (action) {
    case "access_point.create":
      assertAccessPointCreateMetadata(result, resourceId, value);
      return;
    case "access_point.update": {
      const metadata = requireExactRecord(value, [
        "accessPointId", "oldRoutingRevision", "newRoutingRevision", "routingChanged", "descriptionChanged", "targetEdgeCount",
      ], [], "audit_metadata_invalid");
      assertResourceIdentity(resourceId, metadata.accessPointId, "audit_access_point_id_invalid");
      requirePositiveInteger(metadata.oldRoutingRevision, "audit_old_routing_revision_invalid");
      requirePositiveInteger(metadata.newRoutingRevision, "audit_new_routing_revision_invalid");
      requireBoolean(metadata.routingChanged, "audit_routing_changed_invalid");
      requireBoolean(metadata.descriptionChanged, "audit_description_changed_invalid");
      requireNonNegativeInteger(metadata.targetEdgeCount, "audit_target_edge_count_invalid");
      return;
    }
    case "access_point.remove": {
      const metadata = requireExactRecord(value, ["accessPointId", "routingRevision"], [], "audit_metadata_invalid");
      assertResourceIdentity(resourceId, metadata.accessPointId, "audit_access_point_id_invalid");
      requirePositiveInteger(metadata.routingRevision, "audit_routing_revision_invalid");
      return;
    }
    case "provider.create":
      assertProviderDefinitionMetadata(resourceId, value, false);
      return;
    case "provider.update": {
      const metadata = requireRecord(value, "audit_metadata_invalid");
      if (Object.prototype.hasOwnProperty.call(metadata, "ownerId")) {
        assertProviderDefinitionMetadata(resourceId, value, true);
        return;
      }
      const transition = requireExactRecord(value, ["providerId", "status", "statusChanged", "reason"], ["reason"], "audit_metadata_invalid");
      assertResourceIdentity(resourceId, transition.providerId, "audit_provider_id_invalid");
      requireEnum(transition.status, ["enabled", "disabled"], "audit_provider_status_invalid");
      requireBoolean(transition.statusChanged, "audit_provider_status_changed_invalid");
      if (transition.reason !== undefined) requirePattern(transition.reason, STABLE_CODE_PATTERN, "audit_reason_invalid");
      return;
    }
    case "provider.delete": {
      const metadata = requireExactRecord(value, ["providerId", "deleted"], [], "audit_metadata_invalid");
      assertResourceIdentity(resourceId, metadata.providerId, "audit_provider_id_invalid");
      if (metadata.deleted !== true) throw new Error("audit_provider_deleted_invalid");
      return;
    }
    case "provider_model.upsert": {
      const metadata = requireExactRecord(value, ["providerId", "providerModelId", "status", "changed"], [], "audit_metadata_invalid");
      requireNonEmptyString(metadata.providerId, "audit_provider_id_invalid");
      assertResourceIdentity(resourceId, metadata.providerModelId, "audit_provider_model_id_invalid");
      requireEnum(metadata.status, ["enabled", "disabled"], "audit_provider_model_status_invalid");
      requireBoolean(metadata.changed, "audit_provider_model_changed_invalid");
      return;
    }
    case "provider_model.sync": {
      const metadata = requireExactRecord(value, ["providerId", "observed", "created"], [], "audit_metadata_invalid");
      assertResourceIdentity(resourceId, metadata.providerId, "audit_provider_id_invalid");
      const observed = requireNonNegativeInteger(metadata.observed, "audit_provider_models_observed_invalid");
      const created = requireNonNegativeInteger(metadata.created, "audit_provider_models_created_invalid");
      if (created > observed) throw new Error("audit_provider_models_created_invalid");
      return;
    }
    case "access_point_price.create": {
      const metadata = requireExactRecord(value, ["accessPointId", "priceSource", "tierCount"], [], "audit_metadata_invalid");
      requireNonEmptyString(metadata.accessPointId, "audit_access_point_id_invalid");
      requireEnum(metadata.priceSource, ["explicit", "target_copy"], "audit_price_source_invalid");
      requireNonNegativeInteger(metadata.tierCount, "audit_tier_count_invalid");
      return;
    }
    case "personal_access_point_zero_price.ensure": {
      const metadata = requireExactRecord(value, ["accessPointId", "planId", "basePriceCreated", "planOverrideCreated", "zeroPrice"], [], "audit_metadata_invalid");
      requireNonEmptyString(metadata.accessPointId, "audit_access_point_id_invalid");
      requireNonEmptyString(metadata.planId, "audit_plan_id_invalid");
      requireBoolean(metadata.basePriceCreated, "audit_price_created_invalid");
      requireBoolean(metadata.planOverrideCreated, "audit_price_created_invalid");
      if (metadata.zeroPrice !== true) throw new Error("audit_zero_price_invalid");
      return;
    }
    case "personal_provider_model_zero_cost.ensure": {
      const metadata = requireExactRecord(value, ["providerId", "providerModelName", "costCreated", "zeroCost"], [], "audit_metadata_invalid");
      requireNonEmptyString(metadata.providerId, "audit_provider_id_invalid");
      requireNonEmptyString(metadata.providerModelName, "audit_provider_model_name_invalid");
      requireBoolean(metadata.costCreated, "audit_cost_created_invalid");
      if (metadata.zeroCost !== true) throw new Error("audit_zero_cost_invalid");
      return;
    }
    case "provider_invocation.reconcile_final":
      assertProviderInvocationReconciliationMetadata(result, value);
      return;
    default:
      if (SENSITIVE_READ_AUDIT_ACTIONS.includes(action as SensitiveReadAuditAction)) {
        assertSensitiveReadMetadata(action as SensitiveReadAuditAction, value);
        return;
      }
      assertContextMetadata(action, value);
  }
}

function assertContextMetadata(action: AuditAction, value: unknown): void {
  if (action in AUTHORITY_ENTITLEMENT_AUDIT_ACTION_POLICY) {
    const contextPolicy = AUTHORITY_ENTITLEMENT_AUDIT_ACTION_POLICY[action as AuthorityEntitlementAuditAction];
    const metadata = requireExactRecord(value, contextPolicy.metadataKeys, [], "audit_metadata_invalid", true);
    assertSafeMetadataValues(metadata);
    return;
  }
  if (!(action in IDENTITY_TENANCY_AUDIT_ACTION_POLICY)) throw new Error("audit_action_invalid");
  const identityPolicy = IDENTITY_TENANCY_AUDIT_ACTION_POLICY[action as IdentityTenancyAuditAction];
  const metadata = requireExactRecord(value, identityPolicy.metadataKeys, [], "audit_metadata_invalid", true);
  assertSafeMetadataValues(metadata);
}

function assertSensitiveReadMetadata(action: SensitiveReadAuditAction, value: unknown): void {
  const policy = AUDIT_ACTION_POLICY[action];
  const metadata = requireExactRecord(value, policy.metadataKeys, [], "audit_metadata_invalid", true);
  const routePattern = requireNonEmptyString(metadata.routePattern, "audit_route_pattern_invalid");
  if (!routePattern.startsWith("/")) throw new Error("audit_route_pattern_invalid");
  if (metadata.errorCode !== undefined) requirePattern(metadata.errorCode, STABLE_CODE_PATTERN, "audit_error_code_invalid");
  for (const key of ["count", "limit", "missingCount", "byteCount", "effectiveScopeCount"] as const) {
    if (metadata[key] !== undefined) requireNonNegativeInteger(metadata[key], `audit_${key}_invalid`);
  }
  assertSafeMetadataValues(metadata);
}

function assertSafeMetadataValues(metadata: Record<string, unknown>): void {
  const forbiddenKey = /(?:authorization|password|secret|credential(?:id|value|ref|preview)?$|prompt|body|payload|message|capturehash|jcs|patch|jsonpointer)/iu;
  for (const [key, value] of Object.entries(metadata)) {
    if (forbiddenKey.test(key)) throw new Error("audit_metadata_sensitive_key");
    assertSafeMetadataValue(value);
  }
}

function assertSafeMetadataValue(value: unknown): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value) && value.length <= 100) {
    for (const item of value) assertSafeMetadataValue(item);
    return;
  }
  throw new Error("audit_metadata_value_invalid");
}

function assertProviderInvocationReconciliationMetadata(result: AuditResult, value: unknown): void {
  const commonKeys = ["routePattern", "evidenceKind", "evidenceRef", "usageSource"] as const;
  const metadata = requireExactRecord(
    value,
    result === "success"
      ? [...commonKeys, "billingEventId", "actualChargeUnits", "postingCreated"]
      : [...commonKeys, "errorCode"],
    [],
    "audit_metadata_invalid",
  );
  if (metadata.routePattern !== "/api/owner/provider-invocations/:id/reconcile-final") throw new Error("audit_route_pattern_invalid");
  const evidenceKind = requireEnum(metadata.evidenceKind, [
    "provider_operation_query", "provider_billing_record", "provider_response",
  ], "audit_evidence_kind_invalid");
  if (!isSafeExternalEvidenceRef(metadata.evidenceRef)) throw new Error("audit_evidence_ref_invalid");
  const usageSource = requireEnum(metadata.usageSource, ["provider", "response"], "audit_usage_source_invalid");
  if ((evidenceKind === "provider_response") !== (usageSource === "response")) throw new Error("audit_usage_source_invalid");
  if (result === "success") {
    requireNonEmptyString(metadata.billingEventId, "audit_billing_event_id_invalid");
    requirePattern(metadata.actualChargeUnits, /^(?:0|[1-9][0-9]{0,38})$/u, "audit_actual_charge_units_invalid");
    requireBoolean(metadata.postingCreated, "audit_posting_created_invalid");
    return;
  }
  requirePattern(metadata.errorCode, STABLE_CODE_PATTERN, "audit_error_code_invalid");
}

function assertAccessPointCreateMetadata(result: AuditResult, resourceId: string, value: unknown): void {
  if (result === "success") {
    const metadata = requireExactRecord(value, ["accessPointId", "scopeRef"], [], "audit_metadata_invalid");
    assertResourceIdentity(resourceId, metadata.accessPointId, "audit_access_point_id_invalid");
    requireNonEmptyString(metadata.scopeRef, "audit_scope_ref_invalid");
    return;
  }
  if (resourceId !== "pending") throw new Error("audit_access_point_pending_resource_invalid");
  const metadata = requireExactRecord(value, ["scopeRef", "errorCode"], [], "audit_metadata_invalid");
  requireNonEmptyString(metadata.scopeRef, "audit_scope_ref_invalid");
  requirePattern(metadata.errorCode, STABLE_CODE_PATTERN, "audit_error_code_invalid");
}

function assertProviderDefinitionMetadata(resourceId: string, value: unknown, allowMaterialChanged: boolean): void {
  const required = [
    "providerId", "ownerId", "scopeRef", "kind", "status", "baseUrlResolverName", "credentialResolverName", "modelsResolverName",
  ] as const;
  const metadata = requireExactRecord(
    value,
    allowMaterialChanged ? [...required, "materialChanged"] : required,
    [],
    "audit_metadata_invalid",
  );
  assertResourceIdentity(resourceId, metadata.providerId, "audit_provider_id_invalid");
  requireNonEmptyString(metadata.ownerId, "audit_owner_id_invalid");
  requireNonEmptyString(metadata.scopeRef, "audit_scope_ref_invalid");
  requirePattern(metadata.kind, STABLE_CODE_PATTERN, "audit_provider_kind_invalid");
  requireEnum(metadata.status, ["enabled", "disabled"], "audit_provider_status_invalid");
  requirePattern(metadata.baseUrlResolverName, STABLE_CODE_PATTERN, "audit_base_url_resolver_name_invalid");
  requirePattern(metadata.credentialResolverName, STABLE_CODE_PATTERN, "audit_credential_resolver_name_invalid");
  requirePattern(metadata.modelsResolverName, STABLE_CODE_PATTERN, "audit_models_resolver_name_invalid");
  if (allowMaterialChanged) requireBoolean(metadata.materialChanged, "audit_material_changed_invalid");
}

function assertResourceIdentity(resourceId: string, value: unknown, code: string): void {
  if (requireNonEmptyString(value, code) !== resourceId) throw new Error(code);
}

function requireRecord(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function requireExactRecord(
  value: unknown,
  allowedKeys: readonly string[],
  optionalKeys: readonly string[],
  code: string,
  allKeysOptional = false,
): Record<string, unknown> {
  const record = requireRecord(value, code);
  const allowed = new Set(allowedKeys);
  const optional = new Set(optionalKeys);
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw new Error(code);
  if (!allKeysOptional) for (const key of allowedKeys) if (!optional.has(key) && !Object.prototype.hasOwnProperty.call(record, key)) throw new Error(code);
  return record;
}

function requireNonEmptyString(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(code);
  return value;
}

function requirePattern(value: unknown, pattern: RegExp, code: string): string {
  const text = requireNonEmptyString(value, code);
  if (!pattern.test(text)) throw new Error(code);
  return text;
}

function requireBoolean(value: unknown, code: string): boolean {
  if (typeof value !== "boolean") throw new Error(code);
  return value;
}

function requirePositiveInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(code);
  return value as number;
}

function requireNonNegativeInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(code);
  return value as number;
}

function requireEnum<const Values extends readonly string[]>(value: unknown, values: Values, code: string): Values[number] {
  if (typeof value !== "string" || !values.includes(value)) throw new Error(code);
  return value as Values[number];
}

function policy(resourceType: string, results: readonly AuditResult[], metadataKeys: readonly string[]) {
  return { resourceType, results, metadataKeys } as const;
}
