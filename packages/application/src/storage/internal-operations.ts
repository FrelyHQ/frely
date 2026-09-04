import { BillingCommerceRuntimeCommands, BillingCommerceRuntimeQueries } from "@frely/billing/server";
import type { PostgresClientOwner } from "@frely/postgres/server";
import type { ApplicationCommands } from "./application-capabilities.js";
import { createApplicationCommands, createApplicationQueries } from "./application-capabilities.js";
import { BillingCommerceApplicationService } from "../billing-commerce.js";
import { BillingCommandService } from "./billing/commands.js";
import { PostgresApplicationOperations } from "./postgres-application-operations.js";
import { PostgresTaskLeaseStore } from "./postgres-task-lease.js";

export { BillingCommandService, PostgresTaskLeaseStore };

/** Narrow command profile used only by disposable Model Access verification. */
export function createModelAccessVerificationCommands(
  owner: PostgresClientOwner,
): Pick<ApplicationCommands, "createAccessPointPrice"> {
  const operations = new PostgresApplicationOperations(owner);
  return Object.freeze({
    createAccessPointPrice: operations.createAccessPointPrice.bind(operations),
  });
}

/** Bounded Billing/Commerce services used by disposable database verification. */
export function createBillingCommerceVerificationServices(owner: PostgresClientOwner) {
  const operations = new PostgresApplicationOperations(owner);
  const queries = createApplicationQueries(operations);
  const commands = createApplicationCommands(operations);
  return Object.freeze({
    queries: new BillingCommerceRuntimeQueries(queries),
    commands: new BillingCommerceRuntimeCommands(commands),
    application: new BillingCommerceApplicationService(commands),
  });
}
