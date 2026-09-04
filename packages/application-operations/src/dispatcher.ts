import type { ExplicitTypedApplicationOperationId } from "./operation-ids.generated.js";
import type { ApplicationOperationRegistry } from "./registry.js";
import {
  RESERVED_EXECUTION_CONTEXT_INPUT_FIELDS,
  type ApplicationOperationDescriptor,
  type ApplicationOperationExecutionContext,
  type ApplicationOperationPublicErrorCode,
} from "./types.js";

export interface OperationContract<Input, Output> {
  readonly inputSchemaId: string;
  readonly outputSchemaId: string;
  parseInput(value: unknown): Input;
  parseOutput(value: unknown): Output;
}

export interface ApplicationOperationBinding<Id extends string, Input, Output> {
  readonly id: Id;
  readonly contract: OperationContract<Input, Output>;
  handle(input: Input, context: ApplicationOperationExecutionContext): Promise<Output>;
}

type AnyBinding = ApplicationOperationBinding<string, unknown, unknown>;
type BindingId<Bindings extends readonly AnyBinding[]> = Bindings[number]["id"];
type BindingFor<Bindings extends readonly AnyBinding[], Id extends BindingId<Bindings>> = Extract<Bindings[number], { readonly id: Id }>;
type BindingTypes<Binding> = Binding extends ApplicationOperationBinding<string, infer Input, infer Output>
  ? { readonly input: Input; readonly output: Output }
  : never;
type BindingInput<Binding> = BindingTypes<Binding>["input"];
type BindingOutput<Binding> = BindingTypes<Binding>["output"];

export interface ApplicationOperationPublicError {
  readonly schema: "application-operation-error.v1";
  readonly code: ApplicationOperationPublicErrorCode;
  readonly status: number;
  readonly message: string;
  readonly retryable: boolean;
}

const publicErrorDefaults: Record<ApplicationOperationPublicErrorCode, Omit<ApplicationOperationPublicError, "schema" | "code">> = {
  invalid_operation_input: { status: 400, message: "The operation input is invalid.", retryable: false },
  unauthenticated: { status: 401, message: "Authentication is required.", retryable: false },
  forbidden: { status: 403, message: "The operation is not permitted.", retryable: false },
  not_found: { status: 404, message: "The requested resource was not found.", retryable: false },
  conflict: { status: 409, message: "The operation conflicts with current state.", retryable: false },
  rate_limited: { status: 429, message: "The operation is temporarily rate limited.", retryable: true },
  operation_cancelled: { status: 499, message: "The operation was cancelled.", retryable: true },
  internal_error: { status: 500, message: "The operation could not be completed.", retryable: false },
};

export class CanonicalOperationPublicError extends Error {
  readonly code: ApplicationOperationPublicErrorCode;

  constructor(code: ApplicationOperationPublicErrorCode) {
    super(publicErrorDefaults[code].message);
    this.name = "CanonicalOperationPublicError";
    this.code = code;
  }
}

export class ApplicationOperationDispatchError extends Error {
  readonly operationId: string;
  readonly publicError: ApplicationOperationPublicError;

  constructor(operationId: string, code: ApplicationOperationPublicErrorCode, _cause?: unknown) {
    const detail = publicErrorDefaults[code];
    super(detail.message);
    this.name = "ApplicationOperationDispatchError";
    this.operationId = operationId;
    this.publicError = Object.freeze({ schema: "application-operation-error.v1", code, ...detail });
  }
}

export function mapApplicationOperationError(error: unknown): ApplicationOperationPublicError {
  if (error instanceof ApplicationOperationDispatchError) return error.publicError;
  const detail = publicErrorDefaults.internal_error;
  return Object.freeze({ schema: "application-operation-error.v1", code: "internal_error", ...detail });
}

function assertExecutionContext(context: ApplicationOperationExecutionContext): void {
  if (!context || typeof context !== "object") throw new TypeError("operation execution context is required");
  if (!context.actor || typeof context.actor.id !== "string" || context.actor.id === "") throw new TypeError("trusted actor is required");
  if (!context.principal || !(typeof context.principal.id === "string" || context.principal.id === null)) throw new TypeError("trusted principal is required");
  if (typeof context.requestId !== "string" || context.requestId === "") throw new TypeError("trusted request id is required");
  if (!context.capabilities || typeof context.capabilities.has !== "function") throw new TypeError("trusted capabilities are required");
  if (!context.signal || typeof context.signal.aborted !== "boolean") throw new TypeError("AbortSignal is required");
}

function assertNoTrustedContextInput(operationId: string, input: unknown): void {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return;
  for (const field of RESERVED_EXECUTION_CONTEXT_INPUT_FIELDS) {
    if (Object.hasOwn(input, field)) throw new ApplicationOperationDispatchError(operationId, "invalid_operation_input");
  }
}

function throwIfCancelled(operationId: string, signal: AbortSignal): void {
  if (signal.aborted) throw new ApplicationOperationDispatchError(operationId, "operation_cancelled", signal.reason);
}

export function defineApplicationOperationBinding<const Id extends ExplicitTypedApplicationOperationId, Input, Output>(
  id: Id,
  descriptor: ApplicationOperationDescriptor,
  contract: OperationContract<Input, Output>,
  handler: (input: Input, context: ApplicationOperationExecutionContext) => Promise<Output>,
): ApplicationOperationBinding<Id, Input, Output> {
  if (descriptor.id !== id) throw new TypeError(`${id}: operation descriptor identity mismatch`);
  if (descriptor.execution.dispatchPolicy !== "typed-handler") {
    throw new TypeError(`${descriptor.id}: operation is not explicitly dispatchable`);
  }
  if (contract.inputSchemaId !== descriptor.input.schemaId || contract.outputSchemaId !== descriptor.output.schemaId) {
    throw new TypeError(`${descriptor.id}: operation contract schema mismatch`);
  }
  return Object.freeze({ id, contract, handle: handler });
}

export interface ApplicationOperationDispatcher<Bindings extends readonly AnyBinding[]> {
  dispatch<Id extends BindingId<Bindings>>(
    id: Id,
    input: BindingInput<BindingFor<Bindings, Id>>,
    context: ApplicationOperationExecutionContext,
  ): Promise<BindingOutput<BindingFor<Bindings, Id>>>;
}

export function createApplicationOperationDispatcher<const Bindings extends readonly AnyBinding[]>(
  registry: ApplicationOperationRegistry,
  bindings: Bindings,
): ApplicationOperationDispatcher<Bindings> {
  const byId = new Map<string, AnyBinding>();
  for (const binding of bindings) {
    if (byId.has(binding.id)) throw new TypeError(`duplicate operation binding: ${binding.id}`);
    const descriptor = registry.require(binding.id);
    if (descriptor.execution.dispatchPolicy !== "typed-handler") throw new TypeError(`${binding.id}: operation is not explicitly dispatchable`);
    if (binding.contract.inputSchemaId !== descriptor.input.schemaId || binding.contract.outputSchemaId !== descriptor.output.schemaId) {
      throw new TypeError(`${binding.id}: operation binding schema mismatch`);
    }
    byId.set(binding.id, binding);
  }

  return Object.freeze({
    async dispatch<Id extends BindingId<Bindings>>(
      id: Id,
      input: BindingInput<BindingFor<Bindings, Id>>,
      context: ApplicationOperationExecutionContext,
    ): Promise<BindingOutput<BindingFor<Bindings, Id>>> {
      assertExecutionContext(context);
      const descriptor = registry.require(id);
      const binding = byId.get(id);
      if (!binding || descriptor.execution.dispatchPolicy !== "typed-handler") {
        throw new ApplicationOperationDispatchError(id, "internal_error");
      }
      throwIfCancelled(id, context.signal);
      if (!context.capabilities.has(descriptor.capability.policy)) {
        throw new ApplicationOperationDispatchError(id, "forbidden");
      }
      assertNoTrustedContextInput(id, input);
      let parsedInput: unknown;
      try {
        parsedInput = binding.contract.parseInput(input);
      } catch (error) {
        throw new ApplicationOperationDispatchError(id, "invalid_operation_input", error);
      }
      throwIfCancelled(id, context.signal);
      try {
        const output = await binding.handle(parsedInput as never, context);
        throwIfCancelled(id, context.signal);
        try {
          return binding.contract.parseOutput(output) as BindingOutput<BindingFor<Bindings, Id>>;
        } catch (error) {
          throw new ApplicationOperationDispatchError(id, "internal_error", error);
        }
      } catch (error) {
        if (context.signal.aborted) throw new ApplicationOperationDispatchError(id, "operation_cancelled", error);
        if (error instanceof ApplicationOperationDispatchError) throw error;
        if (error instanceof CanonicalOperationPublicError && descriptor.publicErrors.codes.includes(error.code)) {
          throw new ApplicationOperationDispatchError(id, error.code, error);
        }
        throw new ApplicationOperationDispatchError(id, "internal_error", error);
      }
    },
  });
}
