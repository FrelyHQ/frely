import type { BillingCommerceApplicationService } from "@frely/application/server";
import type { AppConfig } from "@frely/config";
import {
  openRuntimeDatabase,
  type RuntimeDatabase,
  type RuntimeDatabaseOptions,
} from "@frely/application/runtime";
import type { UiCommandPort, UiQueryPort } from "./contracts.js";

export type * from "./contracts.js";

/*
 * Explicit host/protocol helpers whose persistence implementation is hidden
 * behind the UI Application server entry point. Binary/Capture and auth
 * transports remain excluded from generic command dispatch; their business
 * decisions still use typed Context services.
 */
export {
  actorFromClaims,
  actorFromPrincipal,
  auditDeniedAsync,
  auditedPlanBudgetReadAsync,
  auditFailureAsync,
  auditSuccessAsync,
  buildAudienceTeamMemberPlanBudgetSources,
  buildAudienceTeamMemberPlanBudgetSourcesAsync,
  buildAudienceUserPlanBudgetSources,
  buildAudienceUserPlanBudgetSourcesAsync,
  cardActivationBatchView,
  cardActivationCodeHash,
  cardActivationCodeSafeView,
  createPublicHostPolicy,
  CreditCursorError,
  creditUnitsToUsd,
  normalizeAuthorityHostname,
  normalizeDirectoryPageSize,
  normalizePlanBudgetLimits,
  normalizePublicHostname,
  parseHostHeader,
  signCardActivationIntent,
  teamMembershipRoles,
  verifyCardActivationIntent,
} from "@frely/application/runtime";

export {
  archiveReadRemoteFromConfig,
  openRequestCaptureStoreForConfig,
  parseRequestCaptureView,
  prepareRequestCaptureDownload,
  queryRequestLogsAcrossStorageAsync,
  requestCaptureFileStream,
  RequestCaptureReader,
  requestCaptureTarStream,
  requestCaptureViewResponse,
  RequestLogArchiveReader,
  requestLogMatchesFilter,
} from "@frely/capture";

export { assertSafeProviderConfigInput, sanitizeProvider } from "@frely/providers/credentials";

/**
 * Typed server boundary consumed by Admin/Web hosts.
 *
 * Hosts may authenticate, parse input, perform a bounded first read, redact,
 * and map protocol behavior. They cannot obtain a RuntimeDatabase, concrete
 * persistence implementation, generated client, or unit-of-work owner from this contract.
 */
export interface UiApplicationBoundary {
  readonly queries: UiQueryPort;
  readonly commands: UiCommandPort;
  readonly audit: RuntimeDatabase["audit"];
  readonly auditQueries: RuntimeDatabase["auditQueries"];
  readonly modelAccess: RuntimeDatabase["modelAccess"];
  readonly modelAccessQueries: RuntimeDatabase["modelAccessQueries"];
  readonly modelAccessRoutingQueries: RuntimeDatabase["modelAccessRoutingQueries"];
  readonly billing: RuntimeDatabase["billing"];
  readonly billingQueries: RuntimeDatabase["billingCommerceQueries"];
  readonly billingCommands: RuntimeDatabase["billingCommerceCommands"];
  readonly requestExecutionCommands: RuntimeDatabase["requestExecutionCommands"];
  readonly requestExecutionReconciliationRead: RuntimeDatabase["requestExecutionReconciliationRead"];
  readonly requestExecutionLeases: RuntimeDatabase["requestExecutionLeases"];
  readonly publicHosts: RuntimeDatabase["publicHosts"];
  readonly providerRuntimeTargets: RuntimeDatabase["providerRuntimeTargets"];
  readonly identityTenancy: RuntimeDatabase["identityTenancy"];
  readonly authorityEntitlement: RuntimeDatabase["authorityEntitlement"];
  readonly billingCommerce: BillingCommerceApplicationService;
  close(): Promise<void>;
}

export interface UiApplicationBoundaryOptions extends RuntimeDatabaseOptions {
  readonly config: AppConfig;
}

/** Composition root; database and transaction ownership never cross this return contract. */
export async function openUiApplicationBoundary(
  options: UiApplicationBoundaryOptions,
): Promise<UiApplicationBoundary> {
  const database = await openRuntimeDatabase(options);
  return {
    queries: database.queries,
    commands: database.commands,
    audit: database.audit,
    auditQueries: database.auditQueries,
    modelAccess: database.modelAccess,
    modelAccessQueries: database.modelAccessQueries,
    modelAccessRoutingQueries: database.modelAccessRoutingQueries,
    billing: database.billing,
    billingQueries: database.billingCommerceQueries,
    billingCommands: database.billingCommerceCommands,
    requestExecutionCommands: database.requestExecutionCommands,
    requestExecutionReconciliationRead: database.requestExecutionReconciliationRead,
    requestExecutionLeases: database.requestExecutionLeases,
    publicHosts: database.publicHosts,
    providerRuntimeTargets: database.providerRuntimeTargets,
    identityTenancy: database.identityTenancy,
    authorityEntitlement: database.authorityEntitlement,
    billingCommerce: database.billingCommerceCommands,
    close: () => database.close(),
  };
}
