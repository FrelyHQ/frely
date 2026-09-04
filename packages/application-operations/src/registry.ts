import {
  APPLICATION_OPERATION_ID_PATTERN,
  APPLICATION_OPERATION_PUBLIC_ERROR_CODES,
  type ApplicationOperationDescriptor,
  type ApplicationOperationExclusion,
  type OwnerOperationMetadata,
} from "./types.js";

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export function validateApplicationOperationDescriptor(value: unknown): asserts value is ApplicationOperationDescriptor {
  const operation = record(value, "operation");
  const id = stringValue(operation.id, "operation.id");
  if (!APPLICATION_OPERATION_ID_PATTERN.test(id)) throw new TypeError(`${id}: invalid operation id`);
  stringValue(operation.inventoryId, `${id}.inventoryId`);
  if (!new Set(["user-query", "owner-query", "command"]).has(operation.kind as string)) throw new TypeError(`${id}: invalid kind`);
  stringValue(operation.audience, `${id}.audience`);
  const contextOwner = stringValue(operation.contextOwner, `${id}.contextOwner`);
  const owner = record(operation.applicationOwner, `${id}.applicationOwner`);
  if (owner.owner !== contextOwner) throw new TypeError(`${id}: canonical handler owner mismatch`);
  if (operation.kind === "command" ? owner.kind !== "typed-command-handler" : owner.kind !== "bounded-query-module") {
    throw new TypeError(`${id}: canonical handler kind mismatch`);
  }
  stringValue(owner.key, `${id}.applicationOwner.key`);
  stringValue(owner.source, `${id}.applicationOwner.source`);
  stringValue(owner.exportName, `${id}.applicationOwner.exportName`);
  for (const direction of ["input", "output"] as const) {
    const contract = record(operation[direction], `${id}.${direction}`);
    stringValue(contract.contractId, `${id}.${direction}.contractId`);
    stringValue(contract.schemaId, `${id}.${direction}.schemaId`);
    if (contract.schemaVersion !== 1 || contract.schemaKind !== "canonical-operation-contract") throw new TypeError(`${id}: invalid ${direction} schema`);
    if (contract.validationOwner !== owner.key) throw new TypeError(`${id}: ${direction} schema owner mismatch`);
    if (contract.executionContextFields !== "forbidden" || contract.transportFields !== "forbidden") {
      throw new TypeError(`${id}: ${direction} contract widens trusted or transport input`);
    }
  }
  const capability = record(operation.capability, `${id}.capability`);
  if (capability.source !== "execution-context" || capability.trustedScopeSource !== "execution-context-only") {
    throw new TypeError(`${id}: capability must come from execution context`);
  }
  stringValue(capability.policy, `${id}.capability.policy`);
  const risks = new Set(["low", "sensitive-read", "consequential", "high"]);
  if (!risks.has(operation.risk as string)) throw new TypeError(`${id}: invalid risk`);
  stringValue(operation.sensitivity, `${id}.sensitivity`);
  if (operation.kind === "command") {
    if (operation.idempotency !== "canonical-handler-owned" || operation.concurrency !== "canonical-handler-owned") {
      throw new TypeError(`${id}: invalid Command idempotency/concurrency policy`);
    }
  } else if (operation.idempotency !== "idempotent-read" || operation.concurrency !== "parallel-bounded-read") {
    throw new TypeError(`${id}: invalid Query idempotency/concurrency policy`);
  }
  if (operation.cancellation !== "abort-signal-propagated") throw new TypeError(`${id}: invalid cancellation policy`);
  const transaction = record(operation.transactionOwner, `${id}.transactionOwner`);
  if (transaction.owner !== contextOwner) throw new TypeError(`${id}: transaction owner mismatch`);
  stringValue(transaction.policy, `${id}.transactionOwner.policy`);
  const audit = record(operation.audit, `${id}.audit`);
  stringValue(audit.builder, `${id}.audit.builder`);
  stringValue(audit.policy, `${id}.audit.policy`);
  if (audit.actorSource !== "execution-context") throw new TypeError(`${id}: Audit actor must come from execution context`);
  const errors = record(operation.publicErrors, `${id}.publicErrors`);
  if (errors.mapping !== "application-operation-error.v1" || !Array.isArray(errors.codes)) throw new TypeError(`${id}: invalid public error mapping`);
  const allowedErrors = new Set(APPLICATION_OPERATION_PUBLIC_ERROR_CODES);
  for (const code of errors.codes) if (!allowedErrors.has(code as never)) throw new TypeError(`${id}: invalid public error code ${String(code)}`);
  const result = record(operation.result, `${id}.result`);
  if (result.bounded !== true) throw new TypeError(`${id}: result must be bounded`);
  stringValue(result.policy, `${id}.result.policy`);
  if (!new Set(["none", "cursor", "offset-or-handler-bounded"]).has(result.pagination as string)) throw new TypeError(`${id}: invalid pagination policy`);
  if (!new Set(["no-store", "request-scoped-private", "private-no-store", "canonical-handler-policy"]).has(result.cache as string)) {
    throw new TypeError(`${id}: invalid cache policy`);
  }
  const execution = record(operation.execution, `${id}.execution`);
  if (!new Set(["bounded-loader-only", "canonical-owner-api-only", "typed-handler"]).has(execution.dispatchPolicy as string)) {
    throw new TypeError(`${id}: invalid dispatch policy`);
  }
  if (execution.transportNeutral !== true || execution.canonicalExecutionOnly !== true || execution.mcpProjection !== "none") {
    throw new TypeError(`${id}: invalid execution boundary`);
  }
  if (operation.kind === "user-query" && execution.dispatchPolicy !== "bounded-loader-only") {
    throw new TypeError(`${id}: User Queries cannot enter generic dispatch`);
  }
  if (execution.dispatchPolicy === "typed-handler" && operation.kind !== "command") {
    throw new TypeError(`${id}: only Commands may be explicitly dispatchable`);
  }
}

export class ApplicationOperationRegistry {
  readonly #operations: readonly Readonly<ApplicationOperationDescriptor>[];
  readonly #byId: ReadonlyMap<string, Readonly<ApplicationOperationDescriptor>>;

  constructor(values: readonly unknown[]) {
    const byId = new Map<string, Readonly<ApplicationOperationDescriptor>>();
    const inventoryIds = new Set<string>();
    const schemaIds = new Set<string>();
    const operations = values.map((value) => {
      validateApplicationOperationDescriptor(value);
      if (byId.has(value.id)) throw new TypeError(`duplicate operation id: ${value.id}`);
      if (inventoryIds.has(value.inventoryId)) throw new TypeError(`duplicate inventory operation: ${value.inventoryId}`);
      for (const schemaId of [value.input.schemaId, value.output.schemaId]) {
        if (schemaIds.has(schemaId)) throw new TypeError(`duplicate operation schema id: ${schemaId}`);
        schemaIds.add(schemaId);
      }
      const operation = deepFreeze(value);
      byId.set(operation.id, operation);
      inventoryIds.add(operation.inventoryId);
      return operation;
    });
    this.#operations = Object.freeze(operations);
    this.#byId = byId;
  }

  list(): readonly Readonly<ApplicationOperationDescriptor>[] {
    return this.#operations;
  }

  get(id: string): Readonly<ApplicationOperationDescriptor> | undefined {
    return this.#byId.get(id);
  }

  require(id: string): Readonly<ApplicationOperationDescriptor> {
    const operation = this.get(id);
    if (!operation) throw new TypeError(`unregistered operation: ${id}`);
    return operation;
  }
}

export function createApplicationOperationRegistry(values: readonly unknown[]): ApplicationOperationRegistry {
  return new ApplicationOperationRegistry(values);
}

export function createApplicationOperationExclusions(values: readonly unknown[]): readonly Readonly<ApplicationOperationExclusion>[] {
  const ids = new Set<string>();
  return Object.freeze(values.map((value) => {
    const exclusion = record(value, "exclusion");
    const inventoryId = stringValue(exclusion.inventoryId, "exclusion.inventoryId");
    if (ids.has(inventoryId)) throw new TypeError(`duplicate exclusion: ${inventoryId}`);
    if (exclusion.genericDispatch !== "forbidden" || exclusion.mcpProjection !== "none") throw new TypeError(`${inventoryId}: invalid exclusion boundary`);
    ids.add(inventoryId);
    return deepFreeze(value as ApplicationOperationExclusion);
  }));
}

export class OwnerOperationMetadataRegistry {
  readonly #operations: readonly Readonly<OwnerOperationMetadata>[];
  readonly #byOperationId: ReadonlyMap<string, Readonly<OwnerOperationMetadata>>;

  constructor(values: readonly unknown[], operations: ApplicationOperationRegistry) {
    const byOperationId = new Map<string, Readonly<OwnerOperationMetadata>>();
    const metadata = values.map((value) => {
      const owner = record(value, "owner operation metadata");
      const operationId = stringValue(owner.operationId, "owner operation metadata.operationId");
      if (byOperationId.has(operationId)) throw new TypeError(`duplicate Owner operation metadata: ${operationId}`);
      const operation = operations.require(operationId);
      if (owner.inventoryId !== operation.inventoryId || owner.kind !== operation.kind) {
        throw new TypeError(`${operationId}: Owner metadata identity mismatch`);
      }
      if (operation.kind !== "owner-query" && !(operation.kind === "command" && operation.audience === "platform-owner")) {
        throw new TypeError(`${operationId}: Owner metadata points to a non-Owner operation`);
      }
      const canonicalOperationId = stringValue(owner.canonicalOperationId, `${operationId}.canonicalOperationId`);
      const canonicalOperation = operations.require(canonicalOperationId);
      const privatePath = stringValue(owner.path, `${operationId}.path`);
      if (!privatePath.startsWith("/api/owner/")) throw new TypeError(`${operationId}: Owner path is not private`);
      if (owner.execution !== "canonical-owner-api-only" || owner.mcpProjection !== "none") {
        throw new TypeError(`${operationId}: Owner metadata widens execution`);
      }
      if (!new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]).has(owner.method as string)) throw new TypeError(`${operationId}: invalid Owner method`);
      stringValue(owner.sensitivity, `${operationId}.sensitivity`);
      stringValue(owner.bounds, `${operationId}.bounds`);
      const handler = record(owner.handler, `${operationId}.handler`);
      if (handler.key !== canonicalOperation.applicationOwner.key) throw new TypeError(`${operationId}: canonical Owner handler mismatch`);
      const frozen = deepFreeze(value as OwnerOperationMetadata);
      byOperationId.set(operationId, frozen);
      return frozen;
    });
    this.#operations = Object.freeze(metadata);
    this.#byOperationId = byOperationId;
  }

  list(): readonly Readonly<OwnerOperationMetadata>[] {
    return this.#operations;
  }

  get(operationId: string): Readonly<OwnerOperationMetadata> | undefined {
    return this.#byOperationId.get(operationId);
  }

  require(operationId: string): Readonly<OwnerOperationMetadata> {
    const metadata = this.get(operationId);
    if (!metadata) throw new TypeError(`unregistered Owner operation metadata: ${operationId}`);
    return metadata;
  }
}
