import type { Prisma } from "@frely/postgres/server";

/** Transaction-bound read-only facts used by the offline Identity migration coordinator. */
export class ModelAccessIdentityMigrationQueries {
  constructor(private readonly transaction: Prisma.TransactionClient) {}

  async classifyIdentityMigrationUser(userId: string): Promise<{ unsafeReferenceCount: number }> {
    const userScopeRef = `user:${userId}`;
    const [providers, accessPoints] = await Promise.all([
      this.transaction.providers.count({ where: { OR: [{ owner_id: userId }, { scope_ref: userScopeRef }] } }),
      this.transaction.accessPoint.count({ where: { OR: [{ ownerId: userId }, { scopeRef: userScopeRef }] } }),
    ]);
    return Object.freeze({ unsafeReferenceCount: providers + accessPoints });
  }
}

export * from "./audit-contract.js";
export type * from "./capabilities.js";
export * from "./commands.js";
export * from "./description.js";
export * from "./domain.js";
export * from "./management-readback.js";
export * from "./provider-management.js";
export * from "./routing-kernel.js";
export * from "./routing-queries.js";
export * from "./routing-runtime.js";
