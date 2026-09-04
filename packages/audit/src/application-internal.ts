import { createId, nowIso } from "@frely/core";
import type { Prisma, PrismaTransactionOwner } from "@frely/postgres/server";
import type { AuditCommands, AuditQueries } from "./contracts.js";
import {
  assertAuditApplicationWrite,
  assertAuditEventDraft,
  type AuditApplicationEvent,
  type AuditEventDraft,
} from "./model-access-policy.js";

export interface AuditApplicationCapabilities {
  readonly queries: AuditQueries;
  readonly commands: AuditCommands;
}

/** Active-policy appender injected into Context command implementations. */
export interface AuditEventAppender {
  append(transaction: Prisma.TransactionClient, event: AuditEventDraft): Promise<void>;
}

/** Audit-owned appender for validated active or finite compatibility events. */
export interface AuditApplicationEventAppender {
  appendApplication(transaction: Prisma.TransactionClient, event: AuditApplicationEvent): Promise<void>;
}

export class PrismaAuditEventAppender implements AuditEventAppender, AuditApplicationEventAppender {
  async append(transaction: Prisma.TransactionClient, event: AuditEventDraft): Promise<void> {
    assertAuditEventDraft(event);
    await appendPrismaAuditRow(transaction, {
      actorType: event.actor.actorType,
      actorId: event.actor.actorId,
      action: event.action,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      result: event.result,
      requestId: event.requestId ?? null,
      source: event.source,
      ipHash: null,
      userAgentHash: null,
      metadata: event.metadata,
    });
  }

  async appendApplication(transaction: Prisma.TransactionClient, event: AuditApplicationEvent): Promise<void> {
    assertAuditApplicationWrite(event);
    await appendPrismaAuditRow(transaction, {
      actorType: event.actor.actorType,
      actorId: event.actor.actorId,
      action: event.action,
      resourceType: event.resource.resourceType,
      resourceId: event.resource.resourceId,
      result: event.result,
      requestId: event.requestId ?? null,
      source: event.source,
      ipHash: event.ipHash ?? null,
      userAgentHash: event.userAgentHash ?? null,
      metadata: event.metadata ?? {},
    });
  }
}

export interface PostgresAuditQueryExecutor {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
}

/** Audit-owned compatibility adapter for the legacy pg-backed Application implementation. */
export class PostgresAuditEventAppender {
  async append(executor: PostgresAuditQueryExecutor, event: AuditApplicationEvent): Promise<void> {
    assertAuditApplicationWrite(event);
    await executor.query(
      `INSERT INTO "audit_logs"
       ("id", "actor_type", "actor_id", "action", "resource_type", "resource_id", "result", "request_id", "source", "ip_hash", "user_agent_hash", "metadata_json", "created_at")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        createId("audit"),
        event.actor.actorType,
        event.actor.actorId,
        event.action,
        event.resource.resourceType,
        event.resource.resourceId,
        event.result,
        event.requestId ?? null,
        event.source,
        event.ipHash ?? null,
        event.userAgentHash ?? null,
        JSON.stringify(event.metadata ?? {}),
        nowIso(),
      ],
    );
  }
}

export interface BoundAuditApplicationCommands {
  record(event: AuditApplicationEvent): Promise<void>;
}

export function bindPostgresAuditCommands(executor: PostgresAuditQueryExecutor): BoundAuditApplicationCommands {
  const appender = new PostgresAuditEventAppender();
  return Object.freeze({ record: (event: AuditApplicationEvent) => appender.append(executor, event) });
}

export class AuditCommandService implements AuditCommands {
  constructor(
    private readonly owner: PrismaTransactionOwner,
    private readonly activeAppender: AuditEventAppender = new PrismaAuditEventAppender(),
  ) {}

  record(event: AuditEventDraft | AuditApplicationEvent): Promise<void> {
    return this.owner.withPrismaTransaction(
      (transaction) => appendAuditCommand(transaction, event, this.activeAppender),
      1,
    );
  }
}

export function createAuditApplicationCapabilities(
  owner: PrismaTransactionOwner,
  querySource: AuditQueries,
  appender: AuditEventAppender = new PrismaAuditEventAppender(),
): AuditApplicationCapabilities {
  const queries: AuditQueries = Object.freeze({
    pageAuditLogs: querySource.pageAuditLogs.bind(querySource),
  });
  const commands = createAuditCommands(owner, appender);
  if ((queries as object) === (commands as object)) throw new Error("audit_capability_identity_reused");
  return Object.freeze({ queries, commands });
}

export function createAuditCommands(
  owner: PrismaTransactionOwner,
  appender: AuditEventAppender = new PrismaAuditEventAppender(),
): AuditCommands {
  const service = new AuditCommandService(owner, appender);
  return Object.freeze({ record: service.record.bind(service) });
}

export function bindAuditCommands(
  transaction: Prisma.TransactionClient,
  appender: AuditEventAppender = new PrismaAuditEventAppender(),
): AuditCommands {
  return Object.freeze({ record: (event: AuditEventDraft | AuditApplicationEvent) => appendAuditCommand(transaction, event, appender) });
}

async function appendAuditCommand(
  transaction: Prisma.TransactionClient,
  event: AuditEventDraft | AuditApplicationEvent,
  activeAppender: AuditEventAppender,
): Promise<void> {
  if ("resource" in event) {
    await new PrismaAuditEventAppender().appendApplication(transaction, event);
    return;
  }
  await activeAppender.append(transaction, event);
}

async function appendPrismaAuditRow(transaction: Prisma.TransactionClient, row: {
  actorType: string;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  result: string;
  requestId: string | null;
  source: string;
  ipHash: string | null;
  userAgentHash: string | null;
  metadata: unknown;
}): Promise<void> {
  await transaction.audit_logs.create({
    data: {
      id: createId("audit"),
      actor_type: row.actorType,
      actor_id: row.actorId,
      action: row.action,
      resource_type: row.resourceType,
      resource_id: row.resourceId,
      result: row.result,
      request_id: row.requestId,
      source: row.source,
      ip_hash: row.ipHash,
      user_agent_hash: row.userAgentHash,
      metadata_json: JSON.stringify(row.metadata),
      created_at: nowIso(),
    },
  });
}
