import type {
  AuditActionName,
  AuditCommands,
  AuditMetadataValue,
  AuditResult,
  AuditSource,
} from "@frely/audit";
import type { AccessTokenClaims } from "@frely/auth";

export type AuditActorType = "user" | "api_key" | "system";
export type { AuditResult, AuditSource };

export interface AuditActor {
  actorType: AuditActorType;
  actorId: string;
}

export interface AuditResource {
  resourceType: string;
  resourceId: string;
}

export interface AuditEventInput {
  actor: AuditActor;
  source: AuditSource;
  action: AuditActionName;
  resource: AuditResource;
  metadata?: Readonly<Record<string, AuditMetadataValue>>;
  requestId?: string | null | undefined;
  ipHash?: string | null | undefined;
  userAgentHash?: string | null | undefined;
}

export async function auditSuccessAsync(audit: Pick<AuditCommands, "record">, input: AuditEventInput): Promise<void> {
  await audit.record({ ...input, result: "success" });
}

export async function auditFailureAsync(audit: Pick<AuditCommands, "record">, input: AuditEventInput & { error?: unknown }): Promise<void> {
  const { error, ...event } = input;
  await audit.record({ ...event, result: "failure", metadata: metadataWithError(event.metadata, error) });
}

export async function auditDeniedAsync(audit: Pick<AuditCommands, "record">, input: AuditEventInput & { error?: unknown }): Promise<void> {
  const { error, ...event } = input;
  await audit.record({ ...event, result: "denied", metadata: metadataWithError(event.metadata, error) });
}

export function actorFromClaims(claims: Pick<AccessTokenClaims, "sub">): AuditActor {
  return { actorType: "user", actorId: claims.sub };
}

export function actorFromPrincipal(principal: { apiKey: { id: string } }): AuditActor {
  return { actorType: "api_key", actorId: principal.apiKey.id };
}

export function systemActor(actorId: string): AuditActor {
  return { actorType: "system", actorId };
}

function metadataWithError(metadata: Readonly<Record<string, AuditMetadataValue>> | undefined, error: unknown): Readonly<Record<string, AuditMetadataValue>> {
  const errorCode = errorCodeFromUnknown(error);
  if (!errorCode) return metadata ?? {};
  return { ...(metadata ?? {}), errorCode };
}

function errorCodeFromUnknown(error: unknown): string | null {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  if (error instanceof Error && error.name) return error.name;
  return null;
}
