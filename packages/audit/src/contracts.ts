import type { AuditApplicationEvent, AuditEventDraft } from "./model-access-policy.js";

export interface AuditLogDirectoryInput {
  page?: number;
  pageSize?: number;
  source?: string;
  result?: string;
  actor?: string;
  action?: string;
  resource?: string;
}

export interface AuditLogDirectoryRow {
  id: string;
  createdAt: string;
  actorType: string;
  actorId: string;
  source: string;
  action: string;
  resourceType: string;
  resourceId: string;
  result: string;
}

export interface AuditLogPage {
  items: AuditLogDirectoryRow[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface AuditQueries {
  pageAuditLogs(input?: AuditLogDirectoryInput): Promise<AuditLogPage>;
}

export interface AuditCommands {
  record(event: AuditEventDraft | AuditApplicationEvent): Promise<void>;
}

type AssertAuditCapabilitiesDisjoint<Value extends never> = Value;
type _AuditCapabilitiesDisjoint = AssertAuditCapabilitiesDisjoint<Extract<keyof AuditQueries, keyof AuditCommands>>;
