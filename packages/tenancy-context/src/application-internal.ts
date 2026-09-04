import type { Prisma, PrismaTransactionOwner } from "@frely/postgres/server";
export { TenancyCommands, TenancyQueries } from "./server.js";

import type { TenancyContextCommands, TenancyContextQueries } from "./contracts.js";
import { TenancyCommands, TenancyQueries } from "./server.js";

export function bindTenancyContext(owner: PrismaTransactionOwner & { prisma: Prisma.TransactionClient }, transaction: Prisma.TransactionClient): Readonly<{ queries: TenancyContextQueries; commands: TenancyContextCommands }> {
  return Object.freeze({ queries: new TenancyQueries(owner, transaction), commands: new TenancyCommands(owner, transaction) });
}

export function createTenancyContext(owner: PrismaTransactionOwner & { prisma: Prisma.TransactionClient }): Readonly<{ queries: TenancyContextQueries; commands: TenancyContextCommands }> {
  return Object.freeze({ queries: new TenancyQueries(owner), commands: new TenancyCommands(owner) });
}
