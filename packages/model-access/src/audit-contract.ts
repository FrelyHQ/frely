import type {
  AuditActor,
  AuditActorType,
  AuditResult,
  AuditSource,
  ModelAccessAuditAction as CentralModelAccessAuditAction,
  ModelAccessAuditEventDraft,
  ModelAccessAuditInput as CentralModelAccessAuditInput,
} from "@frely/audit";
import type { AuditEventAppender } from "@frely/audit/application-internal";

export type ModelAccessAuditActorType = AuditActorType;
export type ModelAccessAuditSource = AuditSource;
export type ModelAccessAuditResult = AuditResult;
export type ModelAccessAuditResourceType = ModelAccessAuditEventDraft["resourceType"];
export type ModelAccessAuditAction = CentralModelAccessAuditAction;
export type ModelAccessAuditActor = AuditActor;
export type ModelAccessAuditInput = CentralModelAccessAuditInput;
export type ModelAccessAuditEvent = ModelAccessAuditEventDraft;
export type ModelAccessAuditAppender = AuditEventAppender;
