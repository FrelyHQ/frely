import type { AuditEventAppender } from "@frely/audit/application-internal";
import type { Prisma, PrismaTransactionOwner } from "@frely/postgres/server";
export { AuthorityCommands, AuthorityQueries } from "./server.js";

import type { AuthorityContextCommands, AuthorityContextQueries } from "./contracts.js";
import { AuthorityCommands, AuthorityQueries } from "./server.js";

export function bindAuthorityContext(owner: PrismaTransactionOwner & { prisma: Prisma.TransactionClient }, transaction: Prisma.TransactionClient, audit?: AuditEventAppender): Readonly<{ queries: AuthorityContextQueries; commands: AuthorityContextCommands }> {
  return Object.freeze({ queries: new AuthorityQueries(owner, transaction), commands: new AuthorityCommands(owner, transaction, audit) });
}

export function createAuthorityContext(owner: PrismaTransactionOwner & { prisma: Prisma.TransactionClient }, audit?: AuditEventAppender): Readonly<{ queries: AuthorityContextQueries; commands: AuthorityContextCommands }> {
  return Object.freeze({ queries: new AuthorityQueries(owner), commands: new AuthorityCommands(owner, undefined, audit) });
}
