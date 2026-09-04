import type { AuditEventAppender } from "@frely/audit/application-internal";
import type { Prisma, PrismaTransactionOwner } from "@frely/postgres/server";
export { BillingCommerceCommands, BillingCommerceQueries } from "./commerce.js";

import type { BillingCommerceContextCommands, BillingCommerceContextQueries } from "./commerce-contracts.js";
import { BillingCommerceCommands, BillingCommerceQueries } from "./commerce.js";

export function bindBillingCommerceContext(owner: PrismaTransactionOwner & { prisma: Prisma.TransactionClient }, transaction: Prisma.TransactionClient, audit?: AuditEventAppender): Readonly<{ queries: BillingCommerceContextQueries; commands: BillingCommerceContextCommands }> {
  return Object.freeze({ queries: new BillingCommerceQueries(owner, transaction), commands: new BillingCommerceCommands(owner, transaction, audit) });
}

export function createBillingCommerceContext(owner: PrismaTransactionOwner & { prisma: Prisma.TransactionClient }, audit?: AuditEventAppender): Readonly<{ queries: BillingCommerceContextQueries; commands: BillingCommerceContextCommands }> {
  return Object.freeze({ queries: new BillingCommerceQueries(owner), commands: new BillingCommerceCommands(owner, undefined, audit) });
}
