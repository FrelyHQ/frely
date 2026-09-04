import { createModelAccessApplicationCapabilities } from "@frely/model-access/application-internal";
import type { ModelAccessCommands, ModelAccessManagementQueries, ModelAccessRoutingQueries } from "@frely/model-access/server";
import { createAuditApplicationCapabilities, PrismaAuditEventAppender } from "@frely/audit/application-internal";
import type { AuditCommands, AuditQueries } from "@frely/audit/server";
import type { AppConfig } from "@frely/config";
import type { EntitlementQueries } from "@frely/entitlement/server";
import type {
  RequestExecutionCommands,
  RequestExecutionQueries,
  RequestExecutionReconciliationReadWorkflow,
} from "../request-execution.js";
import { createApplicationContextServices } from "../application-internal.js";
import type {
  AuthorityEntitlementApplicationService,
  GatewayIdentityApplicationService,
  IdentityTenancyApplicationService,
} from "../public-service-contracts.js";
import type { DatabaseBackend } from "./backend-admission.js";
import { createPostgresClientFromEnvironment, PostgresClientOwner, type PostgresClientOptions } from "@frely/postgres/server";
import { PostgresApplicationOperations } from "./postgres-application-operations.js";
import { createRequestExecutionApplicationCapabilities } from "./provider-invocation/commands.js";
import { BillingCommandService } from "./billing/commands.js";
import type { BillingCommands } from "./billing/contracts.js";
import {
  BillingCommerceRuntimeCommands,
  BillingCommerceRuntimeQueries,
  type BillingCommerceRuntimeCommandPort,
  type BillingCommerceRuntimeQueryPort,
} from "@frely/billing/server";
import { PostgresProviderRuntimeTargetReader } from "@frely/provider-runtime/server";
import type { ProviderRuntimeTargetExpectation } from "@frely/provider-runtime";
import { createRequestExecutionLeaseCommands } from "@frely/request-execution/application-internal";
import type { RequestExecutionLeasePort } from "@frely/request-execution/server";
import type { PublicHostCommands } from "./public-host.js";
import {
  createApplicationCommands,
  createApplicationQueries,
  type ApplicationCommands,
  type ApplicationQueries,
} from "./application-capabilities.js";
import { PublicHostApplicationCommands } from "./public-host-commands.js";
import { createGatewayCommands, createGatewayQueries, type GatewayCommands, type GatewayQueries } from "./gateway-capabilities.js";

export interface RuntimeDatabaseConnectionOptions {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: unknown;
  max?: number;
  connectionTimeoutMillis?: number;
  idleTimeoutMillis?: number;
  applicationName?: string;
  statementTimeoutMillis?: number;
  lockTimeoutMillis?: number;
  idleInTransactionSessionTimeoutMillis?: number;
  transactionTimeoutMillis?: number;
  searchPath?: string;
}

export interface RuntimeDatabaseOptions {
  backend: DatabaseBackend;
  config: AppConfig;
  connection?: RuntimeDatabaseConnectionOptions;
  environment?: NodeJS.ProcessEnv;
}

export interface ShadowRiskProfile {
  profileDigest: string;
  requestStartsLimit: number;
  requestStartsWindowMs: number;
  maxInFlight: number;
  riskBudgetWindowMs: number;
  leaseTtlMs: number;
  maxReservedCreditUnits: number;
}

export interface ShadowRiskLease {
  readonly reservationId: string;
  readonly reservedCreditUnits: number;
  settle(actualCreditUnits: number, nowMs?: number): Promise<void>;
  closeUnknown(nowMs?: number): Promise<void>;
}

export interface ShadowRiskInspection {
  profileDigest: string;
  revision: number;
  windowStartedAtMs: number;
  requestStarts: number;
  inFlight: number;
  reservedCreditUnits: number;
}

export interface ShadowRiskStateStore {
  initialize(nowMs?: number): Promise<void>;
  selfCheck(): Promise<void>;
  acquire(input: { reservedCreditUnits: number; nowMs?: number }): Promise<ShadowRiskLease>;
  recoverExpiredLease(input: { reservationId: string; terminalEvidenceDigest: string; nowMs?: number }): Promise<void>;
  inspect(nowMs?: number): Promise<ShadowRiskInspection>;
}

export interface ShadowRiskOperations {
  createShadowRiskStateStore(guardId: string, profile: ShadowRiskProfile): ShadowRiskStateStore;
}

export interface ProviderRuntimeTargetReader {
  loadAvailableTarget(providerModelId: string): Promise<ProviderRuntimeTargetExpectation & Readonly<{
    authMethod: "oauth" | "api-key" | "credential-import";
    credentialOwnership: "cpa-managed";
  }>>;
}

export interface RuntimeDatabase {
  backend: DatabaseBackend;
  queries: ApplicationQueries;
  commands: ApplicationCommands;
  gatewayQueries: GatewayQueries;
  gatewayCommands: GatewayCommands;
  audit: AuditCommands;
  auditQueries: AuditQueries;
  modelAccess: ModelAccessCommands;
  modelAccessQueries: ModelAccessManagementQueries;
  modelAccessRoutingQueries: ModelAccessRoutingQueries;
  billing: BillingCommands;
  billingCommerceQueries: BillingCommerceRuntimeQueryPort<ApplicationQueries>;
  billingCommerceCommands: BillingCommerceRuntimeCommandPort<ApplicationCommands>;
  requestExecutionQueries: RequestExecutionQueries;
  requestExecutionCommands: RequestExecutionCommands;
  requestExecutionReconciliationRead: RequestExecutionReconciliationReadWorkflow;
  requestExecutionLeases: RequestExecutionLeasePort;
  providerRuntimeTargets: ProviderRuntimeTargetReader;
  publicHosts: PublicHostCommands;
  shadowRisk: ShadowRiskOperations;
  identityTenancy: IdentityTenancyApplicationService;
  authorityEntitlement: AuthorityEntitlementApplicationService;
  gatewayIdentity: GatewayIdentityApplicationService;
  gatewayEntitlementQueries: EntitlementQueries;
  close(): Promise<void>;
}

/**
 * Opens the application runtime. Schema migration remains an operator action;
 * application startup is read-only with respect to schema and only performs
 * compatibility admission.
 */
export async function openRuntimeDatabase(options: RuntimeDatabaseOptions): Promise<RuntimeDatabase> {
  const owner = options.connection
    ? new PostgresClientOwner(options.connection as PostgresClientOptions)
    : createPostgresClientFromEnvironment(options.environment);
  const client = new PostgresApplicationOperations(owner);
  const queries = createApplicationQueries(client);
  const commands = createApplicationCommands(client);
  const gatewayQueries = createGatewayQueries(queries);
  const gatewayCommands = createGatewayCommands(commands);
  const auditAppender = new PrismaAuditEventAppender();
  const auditCapabilities = createAuditApplicationCapabilities(owner, Object.freeze({
    pageAuditLogs: queries.pageAuditLogs.bind(queries),
  }), auditAppender);
  const audit = auditCapabilities.commands;
  const auditQueries = auditCapabilities.queries;
  const modelAccessCapabilities = createModelAccessApplicationCapabilities(owner, auditAppender);
  const modelAccess = modelAccessCapabilities.commands;
  const modelAccessQueries = modelAccessCapabilities.managementQueries;
  const modelAccessRoutingQueries = modelAccessCapabilities.routingQueries;
  const billing = new BillingCommandService(owner, auditAppender);
  const billingCommerceQueries = new BillingCommerceRuntimeQueries<ApplicationQueries>(queries);
  const billingCommerceCommands = new BillingCommerceRuntimeCommands<ApplicationCommands>(commands);
  const requestExecutionCapabilities = createRequestExecutionApplicationCapabilities(owner, {
    userPaygoConcurrencyLimit: positiveEnvironmentInteger(options.environment?.FRIDAY_RELAY_USER_PAYGO_MAX_IN_FLIGHT, 2, 100, "FRIDAY_RELAY_USER_PAYGO_MAX_IN_FLIGHT"),
  }, auditAppender);
  const requestExecutionQueries = requestExecutionCapabilities.queries;
  const requestExecutionCommands = requestExecutionCapabilities.commands;
  const requestExecutionReconciliationRead = requestExecutionCapabilities.reconciliationRead;
  const requestExecutionLeases = createRequestExecutionLeaseCommands(owner);
  const providerRuntimeTargets = new PostgresProviderRuntimeTargetReader(owner);
  const applicationContexts = createApplicationContextServices(owner, options.config, auditAppender);
  try {
    await client.assertSchemaCompatible();
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
  return {
    backend: "postgres",
    queries,
    commands,
    gatewayQueries,
    gatewayCommands,
    audit,
    auditQueries,
    modelAccess,
    modelAccessQueries,
    modelAccessRoutingQueries,
    billing,
    billingCommerceQueries,
    billingCommerceCommands,
    requestExecutionQueries,
    requestExecutionCommands,
    requestExecutionReconciliationRead,
    requestExecutionLeases,
    providerRuntimeTargets,
    publicHosts: new PublicHostApplicationCommands(owner),
    shadowRisk: Object.freeze({ createShadowRiskStateStore: client.createShadowRiskStateStore.bind(client) }),
    identityTenancy: applicationContexts.identityTenancy,
    authorityEntitlement: applicationContexts.authorityEntitlement,
    gatewayIdentity: applicationContexts.gatewayIdentity,
    gatewayEntitlementQueries: applicationContexts.gatewayEntitlementQueries,
    close: () => client.close(),
  };
}

function positiveEnvironmentInteger(value: string | undefined, fallback: number, maximum: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`${name}_invalid`);
  return parsed;
}
