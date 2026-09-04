import type { AuditCommands, AuditMetadataValue } from "@frely/audit";
import type { AuditActor, AuditSource } from "./audit.js";

export async function auditedPlanBudgetReadAsync<T>(audit: Pick<AuditCommands, "record">, context: {
  actor: AuditActor;
  source: AuditSource;
  requestId: string;
  resource: { resourceType: string; resourceId: string };
  metadata: Readonly<Record<string, AuditMetadataValue>>;
}, read: () => Promise<T>): Promise<T> {
  try {
    const value = await read();
    await audit.record({ actor: context.actor, source: context.source, requestId: context.requestId, action: "plan_budget_usage.read", resourceType: "plan_subscription", resourceId: context.resource.resourceId, result: "success", metadata: context.metadata });
    return value;
  } catch (error) {
    await audit.record({ actor: context.actor, source: context.source, requestId: context.requestId, action: "plan_budget_usage.read", resourceType: "plan_subscription", resourceId: context.resource.resourceId, result: "failure", metadata: { ...context.metadata, errorCode: error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "internal_error" } });
    throw error;
  }
}
