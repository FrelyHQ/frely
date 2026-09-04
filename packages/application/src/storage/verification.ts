import type { PostgresClientOwner, PostgresTransactionContext } from "@frely/postgres/server";
import type { ApplicationOperationPortContractMethods } from "./application-operation-contract.js";
import type { ApplicationCommands, ApplicationQueries } from "./application-capabilities.js";
import { PostgresApplicationOperations } from "./postgres-application-operations.js";

export interface TenancyAccessPointVerificationQueries extends Pick<ApplicationQueries,
  "getUser" | "getTeam" | "getActiveTeamDeletion"
> {}

export interface DbOpsVerificationQueries extends Pick<ApplicationQueries,
  "listProviders" | "listProviderModels" | "listAccessPoints" | "getProviderBinding" | "listRecentRequestLogs"
> {}

export interface DbOpsVerificationCommands extends Pick<ApplicationCommands,
  "backfillPrepaidSellerSettlements" | "releaseDueSellerSettlements"
> {}

export interface ProviderInvocationVerificationCommands extends Pick<ApplicationCommands,
  "releaseDueSellerSettlements" | "finishRequestLog"
> {}

export interface PostgresContractVerificationOperations extends ApplicationOperationPortContractMethods,
  Pick<ApplicationQueries, "pageOrderedPlanSourcesForUser" | "listUserModelPlanScopeOrders">,
  Pick<ApplicationCommands,
    | "createProviderModelCost"
    | "createAccessPoint"
    | "createPlanSubscription"
    | "cancelPlanSubscription"
    | "updatePlanTemplate"
    | "updateAccessPointAdmin"
  > {}

const TENANCY_ACCESS_POINT_VERIFICATION_QUERY_METHODS = [
  "getUser",
  "getTeam",
  "getActiveTeamDeletion",
] as const satisfies readonly (keyof TenancyAccessPointVerificationQueries)[];

const DB_OPS_VERIFICATION_QUERY_METHODS = [
  "listProviders",
  "listProviderModels",
  "listAccessPoints",
  "getProviderBinding",
  "listRecentRequestLogs",
] as const satisfies readonly (keyof DbOpsVerificationQueries)[];

const DB_OPS_VERIFICATION_COMMAND_METHODS = [
  "backfillPrepaidSellerSettlements",
  "releaseDueSellerSettlements",
] as const satisfies readonly (keyof DbOpsVerificationCommands)[];

const PROVIDER_INVOCATION_VERIFICATION_COMMAND_METHODS = [
  "releaseDueSellerSettlements",
  "finishRequestLog",
] as const satisfies readonly (keyof ProviderInvocationVerificationCommands)[];

const POSTGRES_CONTRACT_VERIFICATION_METHODS = [
  "backend",
  "getTeam",
  "listTeams",
  "upsertTeam",
  "getUser",
  "listUsers",
  "getUserByEmail",
  "upsertUser",
  "getTeamMembership",
  "grantTeamMembership",
  "getOrCreateActiveTeamInviteLink",
  "getTeamInviteLink",
  "consumeTeamInviteLinkUse",
  "getApiKeyByHash",
  "listApiKeys",
  "createApiKey",
  "getProvider",
  "listProviders",
  "upsertProvider",
  "getProviderModel",
  "listProviderModels",
  "upsertProviderModel",
  "getPlan",
  "listPlanDefinitions",
  "listPlanBudgetLimits",
  "createPlanDefinition",
  "pageOrderedPlanSourcesForUser",
  "listUserModelPlanScopeOrders",
  "createProviderModelCost",
  "createAccessPoint",
  "createPlanSubscription",
  "cancelPlanSubscription",
  "updatePlanTemplate",
  "updateAccessPointAdmin",
] as const satisfies readonly (keyof PostgresContractVerificationOperations)[];

function bindVerificationCapability<Capability extends object>(
  source: PostgresApplicationOperations,
  keys: readonly (keyof Capability)[],
): Capability {
  const capability = Object.create(null) as Capability;
  for (const key of keys) {
    const value = source[key as keyof PostgresApplicationOperations];
    if (typeof value !== "function" && key !== "backend") {
      throw new Error(`application_verification_capability_missing:${String(key)}`);
    }
    Object.defineProperty(capability, key, {
      configurable: false,
      enumerable: true,
      value: typeof value === "function" ? value.bind(source) : value,
      writable: false,
    });
  }
  return Object.freeze(capability);
}

/** Restricted query-only profile used by the disposable tenancy verifier. */
export function createTenancyAccessPointVerificationQueries(
  owner: PostgresClientOwner,
): TenancyAccessPointVerificationQueries {
  return bindVerificationCapability(new PostgresApplicationOperations(owner), TENANCY_ACCESS_POINT_VERIFICATION_QUERY_METHODS);
}

/** Restricted and disjoint db-ops profile. It cannot open or own a transaction. */
export function createDbOpsVerificationCapabilities(owner: PostgresClientOwner): Readonly<{
  queries: DbOpsVerificationQueries;
  commands: DbOpsVerificationCommands;
}> {
  const source = new PostgresApplicationOperations(owner);
  return Object.freeze({
    queries: bindVerificationCapability(source, DB_OPS_VERIFICATION_QUERY_METHODS),
    commands: bindVerificationCapability(source, DB_OPS_VERIFICATION_COMMAND_METHODS),
  });
}

/** Command-only profile used by Provider Invocation verification. */
export function createProviderInvocationVerificationCommands(
  owner: PostgresClientOwner,
): ProviderInvocationVerificationCommands {
  return bindVerificationCapability(new PostgresApplicationOperations(owner), PROVIDER_INVOCATION_VERIFICATION_COMMAND_METHODS);
}

/**
 * Restricted contract-gate profile. A transaction must already be bound by the
 * owning verifier before this factory is called; no transaction callback is exposed.
 */
export function createPostgresContractVerificationOperations(
  owner: PostgresClientOwner,
  transaction?: PostgresTransactionContext,
): PostgresContractVerificationOperations {
  return bindVerificationCapability(
    new PostgresApplicationOperations(owner, transaction),
    POSTGRES_CONTRACT_VERIFICATION_METHODS,
  );
}

export * from "./application-operation-contract.js";
