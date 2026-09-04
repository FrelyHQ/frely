const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/u;
const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,191}$/u;
const AUDIT_ID = /^audit_[a-z0-9]+$/u;

/**
 * Audit-owned validated append adapter for the three existing operational
 * corrections. The accepted action names and metadata shapes are deliberately
 * finite and preserve the scripts' established records.
 */
export async function appendOperationalAudit(executor, event) {
  assertOperationalAuditEvent(event);
  await executor.query(
    `INSERT INTO "audit_logs"
     ("id", "actor_type", "actor_id", "action", "resource_type", "resource_id", "result", "request_id", "source", "ip_hash", "user_agent_hash", "metadata_json", "created_at")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, NULL, $10, $11)`,
    [
      event.id,
      event.actorType,
      event.actorId,
      event.action,
      event.resourceType,
      event.resourceId,
      event.result,
      event.requestId,
      event.source,
      JSON.stringify(event.metadata),
      event.createdAt,
    ],
  );
}

export function assertOperationalAuditEvent(event) {
  assertExactRecord(event, ["id", "actorType", "actorId", "action", "resourceType", "resourceId", "result", "requestId", "source", "metadata", "createdAt"]);
  if (!AUDIT_ID.test(event.id)) throw new Error("OPERATIONAL_AUDIT_ID_INVALID");
  if (event.actorType !== "system" || event.result !== "success" || event.source !== "system") throw new Error("OPERATIONAL_AUDIT_ENVELOPE_INVALID");
  if (!SAFE_ID.test(event.actorId) || !SAFE_ID.test(event.resourceType) || !SAFE_ID.test(event.resourceId)) throw new Error("OPERATIONAL_AUDIT_IDENTITY_INVALID");
  if (event.requestId !== null && !SAFE_REQUEST_ID.test(event.requestId)) throw new Error("OPERATIONAL_AUDIT_REQUEST_ID_INVALID");
  if (typeof event.createdAt !== "string" || !Number.isFinite(Date.parse(event.createdAt))) throw new Error("OPERATIONAL_AUDIT_CREATED_AT_INVALID");

  if (event.action === "auth.abuse_counter.clear") {
    if (event.actorId !== "abuse-counter-repair-script" || event.resourceType !== "abuse_rate_limit_counter" || event.requestId === null) throw new Error("OPERATIONAL_AUDIT_POLICY_INVALID");
    assertExactRecord(event.metadata, ["bucket", "count", "windowSeconds"]);
    if (event.metadata.bucket !== "auth.login.failed" || !isNonNegativeInteger(event.metadata.count) || event.metadata.windowSeconds !== 600) throw new Error("OPERATIONAL_AUDIT_METADATA_INVALID");
    return;
  }
  if (event.action === "auth.password_change") {
    if (event.actorId !== "password-hash-restore-script" || event.resourceType !== "user" || event.requestId === null) throw new Error("OPERATIONAL_AUDIT_POLICY_INVALID");
    assertExactRecord(event.metadata, ["surface", "otherSessionsRevoked"]);
    if (event.metadata.surface !== "operational_recovery_correction" || event.metadata.otherSessionsRevoked !== false) throw new Error("OPERATIONAL_AUDIT_METADATA_INVALID");
    return;
  }
  if (event.action === "user_model_plan_scope_order.reconcile") {
    if (event.actorId !== "manual-pg-team-access-reconcile" || event.resourceType !== "team" || event.requestId !== null || event.resourceId !== event.metadata?.teamId) throw new Error("OPERATIONAL_AUDIT_POLICY_INVALID");
    assertExactRecord(event.metadata, ["teamId", "reconcileAt", "memberCount", "missingCount", "insertedCount"]);
    if (!SAFE_ID.test(event.metadata.teamId)
      || typeof event.metadata.reconcileAt !== "string"
      || !Number.isFinite(Date.parse(event.metadata.reconcileAt))
      || !isNonNegativeInteger(event.metadata.memberCount)
      || !isNonNegativeInteger(event.metadata.missingCount)
      || !isNonNegativeInteger(event.metadata.insertedCount)
      || event.metadata.insertedCount > event.metadata.missingCount) {
      throw new Error("OPERATIONAL_AUDIT_METADATA_INVALID");
    }
    return;
  }
  throw new Error("OPERATIONAL_AUDIT_ACTION_INVALID");
}

export function operationalAuditWorkerSource() {
  return [
    `const SAFE_ID = ${SAFE_ID.toString()};`,
    `const SAFE_REQUEST_ID = ${SAFE_REQUEST_ID.toString()};`,
    `const AUDIT_ID = ${AUDIT_ID.toString()};`,
    isNonNegativeInteger.toString(),
    assertExactRecord.toString(),
    assertOperationalAuditEvent.toString(),
    appendOperationalAudit.toString(),
  ].join("\n");
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(Number(value)) && Number(value) >= 0;
}

function assertExactRecord(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("OPERATIONAL_AUDIT_RECORD_INVALID");
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error("OPERATIONAL_AUDIT_RECORD_INVALID");
}
