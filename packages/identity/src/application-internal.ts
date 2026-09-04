import type { AuditEventAppender } from "@frely/audit/application-internal";
import type { Prisma, PrismaTransactionOwner } from "@frely/postgres/server";
export { IdentityCanonicalEmailUpgrade, IdentityCommands, IdentityQueries } from "./server.js";
export { createBetterAuthRuntime } from "./better-auth.js";

import type { IdentityContextCommands, IdentityContextQueries } from "./contracts.js";
import { IdentityCommands, IdentityQueries } from "./server.js";

export function bindIdentityContext(owner: PrismaTransactionOwner & { prisma: Prisma.TransactionClient }, transaction: Prisma.TransactionClient, audit?: AuditEventAppender): Readonly<{ queries: IdentityContextQueries; commands: IdentityContextCommands }> {
  return Object.freeze({ queries: new IdentityQueries(owner, transaction), commands: new IdentityCommands(owner, transaction, audit) });
}

export function createIdentityContext(owner: PrismaTransactionOwner & { prisma: Prisma.TransactionClient }, audit?: AuditEventAppender): Readonly<{ queries: IdentityContextQueries; commands: IdentityContextCommands }> {
  return Object.freeze({ queries: new IdentityQueries(owner), commands: new IdentityCommands(owner, undefined, audit) });
}
