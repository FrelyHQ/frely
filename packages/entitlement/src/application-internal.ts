import type { AuditEventAppender } from "@frely/audit/application-internal";
import type { Prisma, PrismaTransactionOwner } from "@frely/postgres/server";
export { EntitlementCommands, EntitlementQueries } from "./server.js";

import type { EntitlementContextCommands, EntitlementContextQueries } from "./contracts.js";
import { EntitlementCommands, EntitlementQueries } from "./server.js";

export function bindEntitlementContext(owner: PrismaTransactionOwner & { prisma: Prisma.TransactionClient }, transaction: Prisma.TransactionClient, audit?: AuditEventAppender): Readonly<{ queries: EntitlementContextQueries; commands: EntitlementContextCommands }> {
  return Object.freeze({ queries: new EntitlementQueries(owner, transaction), commands: new EntitlementCommands(owner, transaction, audit) });
}

export function createEntitlementContext(owner: PrismaTransactionOwner & { prisma: Prisma.TransactionClient }, audit?: AuditEventAppender): Readonly<{ queries: EntitlementContextQueries; commands: EntitlementContextCommands }> {
  return Object.freeze({ queries: new EntitlementQueries(owner), commands: new EntitlementCommands(owner, undefined, audit) });
}
