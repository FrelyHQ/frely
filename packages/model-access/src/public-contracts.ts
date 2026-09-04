import type { ModelAccessAuditInput } from "@frely/audit";
import type {
  AccessPointRequestOverrides,
  AccessPointSelectorId,
  AccessPointTargetType,
  ScopeRef,
} from "@frely/core";
import type {
  CompiledRoutingPlan,
  EvaluatedRoutingCandidate,
  GraphCompilationBudget,
  GraphCompilationBudgetSnapshot,
} from "./routing-kernel.js";
import type {
  GatewayRoutingQueryInput,
  GatewayRoutingSnapshot,
} from "./routing-runtime.js";

export type { ModelAccessAuditInput };

export interface AccessPointManagementTarget {
  id: string;
  accessPointId: string;
  targetType: AccessPointTargetType;
  targetAccessPointId: string | null;
  targetProviderId: string | null;
  targetProviderModelName: string | null;
  targetProviderModelId: string | null;
  position: number;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface AccessPointManagementView {
  id: string;
  ownerId: string;
  scopeRef: ScopeRef;
  name: string;
  description: string | null;
  apiFamily: string;
  exposedModel: string;
  targetModel: string;
  selectorId: AccessPointSelectorId;
  selectorBehaviorVersion: 1;
  selectorConfigJson: string;
  requestOverridesJson: string;
  routingRevision: number;
  targetType: AccessPointTargetType;
  targetId: string | null;
  targetProviderId: string | null;
  targetProviderModelName: string | null;
  priority: number;
  weight: number;
  fallbackOrder: number;
  status: string;
  createdAt: string;
  updatedAt: string;
  routing: {
    selector: { id: AccessPointSelectorId; behaviorVersion: 1; config: unknown };
    requestOverrides: AccessPointRequestOverrides;
    targets: AccessPointManagementTarget[];
    routingRevision: number;
  };
}

export interface ProviderManagementView {
  id: string;
  ownerId: string;
  scopeRef: ScopeRef;
  name: string;
  kind: string;
  status: string;
  baseUrlResolver: string;
  credentialResolver: string;
  modelsResolver: string;
  configJson: string;
  cpaInstanceId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderModelManagementView {
  id: string;
  providerId: string;
  providerModelName: string;
  displayName: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderModelManagementPage {
  items: ProviderModelManagementView[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface CreateAccessPointCommand {
  idempotencyKey: string;
  ownerId: string;
  scopeRef: ScopeRef;
  name: string;
  description?: string | null;
  apiFamily: string;
  exposedModel: string;
  targetModel: string;
  routing: import("./domain.js").RoutingDefinitionInput;
  priority?: number;
  weight?: number;
  fallbackOrder?: number;
  status?: string;
}

export interface ChangeAccessPointCommand {
  ownerId?: string;
  scopeRef?: ScopeRef;
  name: string;
  description?: string | null;
  apiFamily: string;
  exposedModel: string;
  targetModel: string;
  routing?: import("./domain.js").RoutingDefinitionInput;
  priority?: number;
  weight?: number;
  fallbackOrder?: number;
  status?: string;
}

export interface AccessPointCommandResult {
  id: string;
  routingRevision: number;
  routingChanged: boolean;
  removed: boolean;
  replayed: boolean;
}

export interface ProviderDefinitionCommand {
  id: string;
  ownerId: string;
  scopeRef: ScopeRef;
  name: string;
  kind: string;
  status: "enabled" | "disabled";
  baseUrlResolver: string;
  credentialResolver: string;
  modelsResolver: string;
  configJson: string;
  cpaInstanceId: string;
  authMethod: string;
}

export interface ProviderCatalogObservationResult {
  providerId: string;
  observed: number;
  created: number;
  items: ProviderModelManagementView[];
}

export interface ChangeProviderModelCommand {
  displayName?: string;
  status?: "enabled" | "disabled";
}

export interface ProviderBindingTransitionView {
  providerId: string;
  authMethod: "oauth" | "api-key" | "credential-import";
  credentialOwnership: "cpa-managed" | "linked";
  credentialRefsJson: string;
  credentialPreview: string | null;
  revision: number;
  syncStatus: "pending" | "ready" | "error" | "cleared";
  previousSyncStatus: "pending" | "ready" | "error" | "cleared";
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BeginProviderBindingTransitionCommand {
  expectedRevision: number;
  expectedAuthMethod: string;
  expectedSyncStatus: string;
  expectedErrorCode: string | null;
  expectedBindingUpdatedAt: string;
  expectedProviderUpdatedAt: string;
  disableProvider?: boolean;
  audit?: ModelAccessAuditInput;
  allowStaleRecovery?: boolean;
}

export interface CompleteProviderBindingTransitionCommand {
  credentialRefsJson?: string;
  credentialPreview?: string | null;
  syncStatus: "pending" | "ready" | "cleared" | "error";
  errorCode?: string | null;
}

export interface RoutingAccessPointDiagnostic {
  readonly id: string;
  readonly ownerId: string;
  readonly scopeRef: string;
  readonly name: string;
  readonly description: string | null;
  readonly exposedModel: string;
  readonly targetModel: string;
  readonly status: string;
  readonly routingRevision: number;
}

export interface RoutingProviderDiagnostic {
  readonly id: string;
  readonly scopeRef: string;
  readonly name: string;
  readonly status: string;
  readonly bindingStatus: string | null;
}

export interface RoutingProviderModelDiagnostic {
  readonly id: string;
  readonly providerId: string;
  readonly providerModelName: string;
  readonly displayName: string;
  readonly status: string;
}

export interface RoutingDiagnosticReport {
  readonly outcome: "available" | "unavailable";
  readonly evaluatedAt: string;
  readonly entryAccessPoint: RoutingAccessPointDiagnostic;
  readonly plan: CompiledRoutingPlan;
  readonly candidates: readonly EvaluatedRoutingCandidate[];
  readonly selectedCandidateId: string | null;
  readonly accessPoints: readonly RoutingAccessPointDiagnostic[];
  readonly providers: readonly RoutingProviderDiagnostic[];
  readonly providerModels: readonly RoutingProviderModelDiagnostic[];
  readonly work: GraphCompilationBudgetSnapshot;
}

export interface ModelAccessManagementQueries {
  getProvider(id: string): Promise<ProviderManagementView | undefined>;
  listProvidersByIds(providerIds: readonly string[]): Promise<ProviderManagementView[]>;
  getProviderModel(providerId: string, providerModelName: string): Promise<ProviderModelManagementView | undefined>;
  listProviderModels(input?: { providerIds?: readonly string[]; status?: string }): Promise<ProviderModelManagementView[]>;
  hasEnabledProviderModel(providerId: string): Promise<boolean>;
  pageProviderModels(page?: number, pageSize?: number, input?: { providerIds?: readonly string[]; status?: string }): Promise<ProviderModelManagementPage>;
  getAccessPointWithRouting(id: string): Promise<AccessPointManagementView | undefined>;
}

export interface ModelAccessRoutingQueries {
  inspectAccessPointRouting(accessPointId: string, budget: GraphCompilationBudget): Promise<RoutingDiagnosticReport>;
  evaluateGatewayRouting(input: GatewayRoutingQueryInput): Promise<GatewayRoutingSnapshot>;
  evaluateEntryRouting(input: { readonly entryAccessPointId: string; readonly requestedModel?: string }, budget: GraphCompilationBudget): Promise<RoutingDiagnosticReport>;
}

export interface ProviderManagementCommands {
  createProvider(command: ProviderDefinitionCommand, audit: ModelAccessAuditInput): Promise<ProviderManagementView>;
  changeProvider(id: string, command: ProviderDefinitionCommand, audit: ModelAccessAuditInput): Promise<ProviderManagementView>;
  changeProviderStatus(id: string, status: "enabled" | "disabled", audit: ModelAccessAuditInput): Promise<ProviderManagementView>;
  registerProviderModel(providerId: string, providerModelName: string, displayName: string, audit: ModelAccessAuditInput): Promise<ProviderModelManagementView>;
  changeProviderModel(providerId: string, providerModelName: string, command: ChangeProviderModelCommand, audit: ModelAccessAuditInput): Promise<ProviderModelManagementView>;
  applyProviderCatalogObservation(providerId: string, modelNames: readonly string[], audit: ModelAccessAuditInput): Promise<ProviderCatalogObservationResult>;
  beginProviderBindingTransition(providerId: string, options: BeginProviderBindingTransitionCommand): Promise<ProviderBindingTransitionView>;
  completeProviderBindingTransition(providerId: string, expectedRevision: number, command: CompleteProviderBindingTransitionCommand): Promise<ProviderBindingTransitionView>;
  removeProvider(id: string, audit: ModelAccessAuditInput): Promise<{ id: string; deleted: true }>;
}

export interface ModelAccessQueries extends ModelAccessManagementQueries, ModelAccessRoutingQueries {}

export interface ModelAccessCommands {
  readonly providers: ProviderManagementCommands;
  createAccessPoint(command: CreateAccessPointCommand, audit: ModelAccessAuditInput): Promise<AccessPointCommandResult>;
  changeAccessPoint(id: string, command: ChangeAccessPointCommand, audit: ModelAccessAuditInput): Promise<AccessPointCommandResult>;
  removeAccessPoint(id: string, audit: ModelAccessAuditInput): Promise<AccessPointCommandResult>;
}

export type ModelAccessManagementQueryService = ModelAccessManagementQueries;
export type ModelAccessRoutingQueryService = ModelAccessRoutingQueries;
export type ProviderManagementCommandService = ProviderManagementCommands;
export type ModelAccessCommandService = ModelAccessCommands;

type AssertModelAccessCapabilitiesDisjoint<Value extends never> = Value;
type _ModelAccessCapabilitiesDisjoint = AssertModelAccessCapabilitiesDisjoint<Extract<keyof ModelAccessQueries, keyof ModelAccessCommands>>;
