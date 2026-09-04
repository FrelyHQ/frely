import fs from "node:fs";
import { describe, expect, test } from "vitest";
import {
  ApplicationOperationDispatchError,
  applicationOperationExclusions,
  applicationOperationRegistry,
  createApplicationOperationDispatcher,
  createApplicationOperationRegistry,
  defineApplicationOperationBinding,
  EXPLICIT_TYPED_APPLICATION_OPERATION_IDS,
  mapApplicationOperationError,
  ownerOperationMetadata,
  type ApplicationOperationExecutionContext,
} from "./index.js";

const acceptedInventory = JSON.parse(
  fs.readFileSync(new URL("../../../ops/build/ui-application-operations.json", import.meta.url), "utf8"),
) as { operations: Array<{ id: string; classification: string; host: string; audience: string }> };

function executionContext(signal = new AbortController().signal): ApplicationOperationExecutionContext {
  return {
    actor: { kind: "user", id: "usr_registry_test" },
    principal: { kind: "user", id: "usr_registry_test" },
    trustedScope: "user:usr_registry_test",
    capabilities: new Set(["existing-handler:authenticated-user"]),
    requestId: "req_registry_test",
    concurrencyKey: "intent_registry_test",
    signal,
  };
}

describe("application operation registry", () => {
  test("has exact approved/exclusion and Owner metadata parity with the accepted inventory", () => {
    const approved = new Set(acceptedInventory.operations
      .filter((operation) => ["User Query", "Owner Query", "Command"].includes(operation.classification))
      .map((operation) => operation.id));
    const exclusions = new Set(acceptedInventory.operations
      .filter((operation) => !["User Query", "Owner Query", "Command"].includes(operation.classification))
      .map((operation) => operation.id));
    expect(new Set(applicationOperationRegistry.list().map((operation) => operation.inventoryId))).toEqual(approved);
    expect(new Set(applicationOperationExclusions.map((operation) => operation.inventoryId))).toEqual(exclusions);

    const ownerOperations = new Set(acceptedInventory.operations
      .filter((operation) => operation.classification === "Owner Query"
        || (operation.classification === "Command" && operation.host === "admin" && operation.audience === "platform-owner"))
      .map((operation) => operation.id));
    expect(new Set(ownerOperationMetadata.list().map((operation) => operation.inventoryId))).toEqual(ownerOperations);
    expect(ownerOperationMetadata.list().every((operation) => operation.path.startsWith("/api/owner/")
      && operation.execution === "canonical-owner-api-only"
      && operation.mcpProjection === "none")).toBe(true);
  });

  test("rejects duplicate identities and a schema-invalid User Query dispatch policy", () => {
    const descriptor = applicationOperationRegistry.list()[0]!;
    expect(() => createApplicationOperationRegistry([descriptor, descriptor])).toThrow(/duplicate operation id/);
    const userQuery = applicationOperationRegistry.list().find((operation) => operation.kind === "user-query")!;
    const invalid = structuredClone(userQuery) as unknown as { execution: { dispatchPolicy: string } };
    invalid.execution.dispatchPolicy = "typed-handler";
    expect(() => createApplicationOperationRegistry([invalid])).toThrow(/User Queries cannot enter generic dispatch/);
  });

  test("dispatches only an explicitly bound Command and rejects trusted context in payload", async () => {
    const operationId = EXPLICIT_TYPED_APPLICATION_OPERATION_IDS[0];
    const descriptor = applicationOperationRegistry.require(operationId);
    const binding = defineApplicationOperationBinding(
      operationId,
      descriptor,
      {
        inputSchemaId: descriptor.input.schemaId,
        outputSchemaId: descriptor.output.schemaId,
        parseInput(value: unknown): { value: string } {
          if (typeof value !== "object" || value === null || !("value" in value) || typeof value.value !== "string") throw new TypeError("invalid");
          return { value: value.value };
        },
        parseOutput(value: unknown): { accepted: string } {
          if (typeof value !== "object" || value === null || !("accepted" in value) || typeof value.accepted !== "string") throw new TypeError("invalid");
          return { accepted: value.accepted };
        },
      },
      async (input) => ({ accepted: input.value }),
    );
    const dispatcher = createApplicationOperationDispatcher(applicationOperationRegistry, [binding] as const);
    await expect(dispatcher.dispatch(binding.id, { value: "bounded" }, executionContext())).resolves.toEqual({ accepted: "bounded" });
    await expect(dispatcher.dispatch(binding.id, { value: "bounded", actor: "caller-controlled" } as { value: string }, executionContext()))
      .rejects.toMatchObject({ publicError: { code: "invalid_operation_input" } });
    await expect(dispatcher.dispatch(binding.id, { value: "bounded" }, {
      ...executionContext(),
      capabilities: new Set(),
    })).rejects.toMatchObject({ publicError: { code: "forbidden" } });
  });

  test("maps cancellation and unknown failures to stable public errors", async () => {
    const operationId = EXPLICIT_TYPED_APPLICATION_OPERATION_IDS[0];
    const descriptor = applicationOperationRegistry.require(operationId);
    const binding = defineApplicationOperationBinding(
      operationId,
      descriptor,
      {
        inputSchemaId: descriptor.input.schemaId,
        outputSchemaId: descriptor.output.schemaId,
        parseInput: (value: unknown) => value as null,
        parseOutput: (value: unknown) => value as null,
      },
      async () => null,
    );
    const dispatcher = createApplicationOperationDispatcher(applicationOperationRegistry, [binding] as const);
    const controller = new AbortController();
    controller.abort();
    await expect(dispatcher.dispatch(binding.id, null, executionContext(controller.signal)))
      .rejects.toMatchObject({ publicError: { code: "operation_cancelled", status: 499 } });
    expect(mapApplicationOperationError(new Error("credential=must-not-leak"))).toEqual({
      schema: "application-operation-error.v1",
      code: "internal_error",
      status: 500,
      message: "The operation could not be completed.",
      retryable: false,
    });
    expect(mapApplicationOperationError(new ApplicationOperationDispatchError(binding.id, "conflict"))).toMatchObject({ code: "conflict", status: 409 });
  });
});
