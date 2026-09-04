/*
 * Explicit type-only UI/Application contracts.
 *
 * Client and shared UI consumers use this bounded surface without importing a
 * server runtime or persistence package. Context packages remain the semantic
 * owners; MODERNIZATION-08 may assign operation IDs without widening it.
 */
import type {
  ApplicationCommands,
  ApplicationQueries,
  PlanBudgetLimit,
} from "@frely/application/runtime";
import type { RequestLog } from "@frely/capture";

type SyncApplicationQueries = {
  [Method in keyof ApplicationQueries]: ApplicationQueries[Method] extends (...arguments_: infer Arguments) => infer Result
    ? (...arguments_: Arguments) => Awaited<Result>
    : never;
};

export interface UiQueryPort extends ApplicationQueries {}
export interface UiSyncQueryPort extends SyncApplicationQueries {
  getPrimarySubscriptionAmountLimit(planId: string): PlanBudgetLimit | undefined;
  listRequestLogs(): RequestLog[];
  listLatestRequestStartedAtByUser(): Map<string, string>;
  listLatestRequestStartedAtByApiKey(): Map<string, string>;
}
export interface UiCommandPort extends ApplicationCommands {}

export type {
  AccessPointPriceWorkbenchRow,
  ActiveDomainBinding,
  ApiKey,
  AuditActor,
  AuditLogDirectoryRow,
  AuditSource,
  BillingCommands,
  BudgetPolicy,
  BudgetUsageRecovery,
  CreditTopupAttachment,
  DirectoryPageSize,
  InstancePublicHost,
  InstancePublicHostPage,
  InvocationUsageUnits,
  ManagementPermissionAction,
  PlanAccessPointPriceOverrideInput,
  PlanBudgetLimitInput,
  PlanBudgetSourceView,
  PlanBudgetUsageSource,
  PlanPurchaseOrder,
  PlanPurchaseOrderStatus,
  PlanSubscription,
  PlanSubscriptionListFilter,
  PriceTierInput,
  Provider,
  ProviderCostWorkbenchRow,
  ProviderModel,
  ScopeBudgetPolicy,
  ServiceFulfillmentEffect,
  ServicePurchaseIntent,
  Team,
  TeamDeleteBlocker,
  TeamDeletionLifecycle,
  TeamDirectoryPage,
  TeamDirectorySort,
  TeamDirectorySortDirection,
  TeamMemberPlanUsageItem,
  TeamMemberUsageDirection,
  TeamMemberUsageSort,
  TeamPlanStatusFilter,
  TeamSubscriptionCandidate,
  TeamSubscriptionCandidatePage,
  UserAvailableModelDirectoryRow,
  UserTeamIdentityRow,
} from "@frely/application/runtime";

export type {
  RequestCaptureDownloadSlot,
  RequestCaptureStreamHooks,
  RequestLog,
  RequestLogListFilter,
} from "@frely/capture";
