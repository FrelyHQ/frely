import { createHash } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig } from "@frely/config";
import {
  FilesystemArchiveRemote,
  HISTORY_FACT_ARCHIVE_SCHEMA_VERSION,
  historyFactParquetUncompressedBytes,
  historyFactSha256File,
  historyFactSha256Hex,
  parseHistoryFactArchiveManifestV1,
  preflightFilesystemArchiveMount,
  scanAndVerifyHistoryFactsParquet,
  writeHistoryFactsParquetFromAsync,
  type HistoryFactArchiveManifestV1,
  type HistoryFactRecord,
} from "@frely/capture";
import type { PostgresClientOwner, PostgresTransactionContext } from "@frely/postgres/server";

/** Domains archived by the database-history pipeline. Capture v3 is deliberately
 * absent: it has its own format, retention, reader and verification contract. */
export const REQUEST_HISTORY_ARCHIVE_DOMAINS = [
  "request-logs",
  "request-executions",
  "provider-attempts",
  "provider-invocation-usage-facts",
  "usage-reservations",
  "billing-events",
  "billing-access-point-edges",
  "billing-provider-cost-events",
  "mcp-orchestration-runs",
  "mcp-tool-call-attempts",
  "mcp-spend-reservations",
  "audit-logs",
] as const;

export type RequestHistoryArchiveDomain = (typeof REQUEST_HISTORY_ARCHIVE_DOMAINS)[number];

interface HistoryRow extends HistoryFactRecord {
  factKind: string;
  ref: Record<string, unknown>;
}

interface DomainSpec {
  domain: RequestHistoryArchiveDomain;
  factKind: string;
  table: string;
  idExpression?: string;
  occurredColumn: string;
  requestIdExpression: string;
  payloadExpression: string;
  joins?: string;
}

const DOMAIN_SPECS: readonly DomainSpec[] = [
  {
    domain: "request-logs", factKind: "request-log", table: "request_logs", occurredColumn: "started_at", requestIdExpression: "source.id",
    payloadExpression: `json_build_object('id',source.id,'apiKeyId',source.api_key_id,'userId',source.user_id,'teamId',source.team_id,'planId',source.plan_id,'planSubscriptionId',source.plan_subscription_id,'entryAccessPointId',source.entry_access_point_id,'billingScopeRef',source.billing_scope_ref,'providerId',source.provider_id,'requestPath',source.request_path,'ingressHostname',source.ingress_hostname,'ingressRouteId',source.ingress_route_id,'reqModel',source.req_model,'tarModel',source.tar_model,'ingressPluginsJson',source.ingress_plugins_json,'pipelinePluginsJson',source.pipeline_plugins_json,'status',source.status,'errorCode',source.error_code,'credentialFailureReason',source.credential_failure_reason,'startedAt',source.started_at,'endedAt',source.ended_at)`,
  },
  {
    domain: "request-executions", factKind: "request-execution", table: "request_executions", idExpression: "source.request_id", occurredColumn: "started_at", requestIdExpression: "source.request_id",
    payloadExpression: `json_build_object('requestId',source.request_id,'status',source.status,'ownerId',source.owner_id,'attemptCount',source.attempt_count,'outputCommitted',source.output_committed,'terminalErrorCode',source.terminal_error_code,'startedAt',source.started_at,'endedAt',source.ended_at,'selectedPlanSubscriptionId',source.selected_plan_subscription_id)`,
  },
  {
    domain: "provider-attempts", factKind: "provider-attempt", table: "request_provider_attempts", occurredColumn: "started_at", requestIdExpression: "source.request_id",
    payloadExpression: `json_build_object('id',source.id,'requestId',source.request_id,'attemptIndex',source.attempt_index,'selectorAccessPointId',source.selector_access_point_id,'selectorId',source.selector_id,'selectorBehaviorVersion',source.selector_behavior_version,'routingRevision',source.routing_revision,'candidateId',source.candidate_id,'selectorTargetEdgeId',source.selector_target_edge_id,'pathTargetEdgeIdsJson',source.path_target_edge_ids_json,'accessPointChainIdsJson',source.access_point_chain_ids_json,'providerId',source.provider_id,'providerModelId',source.provider_model_id,'providerModelName',source.provider_model_name,'outcome',source.outcome,'failureClass',source.failure_class,'failureReason',source.failure_reason,'outputCommitted',source.output_committed,'trustedUsageSource',source.trusted_usage_source,'startedAt',source.started_at,'endedAt',source.ended_at,'executionOwnerId',source.execution_owner_id,'costExposure',source.cost_exposure,'finalUsageEvidence',source.final_usage_evidence,'usageSettled',source.usage_settled,'reconciliationReason',source.reconciliation_reason,'invocationContract',source.invocation_contract,'planSubscriptionId',source.plan_subscription_id,'apiKeyId',source.api_key_id,'userId',source.user_id,'billingScopeRef',source.billing_scope_ref,'planSellerScopeRef',source.plan_seller_scope_ref,'providerOwnerScopeRef',source.provider_owner_scope_ref,'providerModelCostId',source.provider_model_cost_id,'providerCostTierKey',source.provider_cost_tier_key,'billablePriceSource',source.billable_price_source,'billablePriceId',source.billable_price_id,'billablePriceTierKey',source.billable_price_tier_key,'billablePriceSnapshotJson',source.billable_price_snapshot_json,'providerCostSnapshotJson',source.provider_cost_snapshot_json,'accessPointPriceSnapshotsJson',source.access_point_price_snapshots_json,'requestedServiceTier',source.requested_service_tier,'inputTokens',source.input_tokens,'maxOutputTokens',source.max_output_tokens,'tokenizerId',source.tokenizer_id,'tokenizerVersion',source.tokenizer_version)`,
  },
  {
    domain: "provider-invocation-usage-facts", factKind: "provider-invocation-usage-fact", table: "provider_invocation_usage_facts", idExpression: "source.provider_attempt_id", occurredColumn: "occurred_at", requestIdExpression: "source.request_id",
    payloadExpression: `json_build_object('providerAttemptId',source.provider_attempt_id,'requestId',source.request_id,'planSubscriptionId',source.plan_subscription_id,'apiKeyId',source.api_key_id,'userId',source.user_id,'inputTokens',source.input_tokens,'cachedInputTokens',source.cached_input_tokens,'cacheWriteTokens',source.cache_write_tokens,'outputTokens',source.output_tokens,'totalTokens',source.total_tokens,'actualChargeUnits',source.actual_charge_units,'usageSource',source.usage_source,'occurredAt',source.occurred_at,'settledAt',source.settled_at,'postingLedgerEventId',source.posting_ledger_event_id,'billingEventId',source.billing_event_id)`,
  },
  {
    domain: "usage-reservations", factKind: "usage-reservation", table: "usage_reservations", occurredColumn: "created_at", requestIdExpression: "source.request_id",
    payloadExpression: `json_build_object('id',source.id,'providerAttemptId',source.provider_attempt_id,'requestId',source.request_id,'creditAccountId',source.credit_account_id,'planSubscriptionId',source.plan_subscription_id,'userId',source.user_id,'status',source.status,'reservationUnits',source.reservation_units,'heldUnits',source.held_units,'inputTokens',source.input_tokens,'maxOutputTokens',source.max_output_tokens,'tokenizerId',source.tokenizer_id,'tokenizerVersion',source.tokenizer_version,'serviceTier',source.service_tier,'billablePriceSource',source.billable_price_source,'billablePriceId',source.billable_price_id,'billablePriceTierKey',source.billable_price_tier_key,'priceSnapshotJson',source.price_snapshot_json,'postingLedgerEventId',source.posting_ledger_event_id,'createdAt',source.created_at,'updatedAt',source.updated_at)`,
  },
  {
    domain: "billing-events", factKind: "billing-event", table: "billing_events", occurredColumn: "created_at", requestIdExpression: "source.request_id",
    payloadExpression: `json_build_object('id',source.id,'requestId',source.request_id,'billingSubscriptionId',source.billing_subscription_id,'billingScopeRef',source.billing_scope_ref,'billablePriceId',source.billable_price_id,'billablePriceSource',source.billable_price_source,'billablePriceTierKey',source.billable_price_tier_key,'operationKind',source.operation_kind,'mcpOrchestrationRunId',source.mcp_orchestration_run_id,'mcpToolCallAttemptId',source.mcp_tool_call_attempt_id,'mcpChargeUnits',source.mcp_charge_units,'providerModelCostId',source.provider_model_cost_id,'providerCostTierKey',source.provider_cost_tier_key,'inputTokens',source.input_tokens,'cachedInputTokens',source.cached_input_tokens,'cacheWriteTokens',source.cache_write_tokens,'outputTokens',source.output_tokens,'totalTokens',source.total_tokens,'billableAmount',source.billable_amount,'providerCostAmount',source.provider_cost_amount,'grossMarginAmount',source.gross_margin_amount,'billablePriceSnapshotJson',source.billable_price_snapshot_json,'costPriceSnapshotJson',source.cost_price_snapshot_json,'billableAmountUnits',source.billable_amount_units,'providerCostAmountUnits',source.provider_cost_amount_units,'grossMarginAmountUnits',source.gross_margin_amount_units,'usageSource',source.usage_source,'occurredAt',source.created_at)`,
  },
  {
    domain: "billing-access-point-edges", factKind: "billing-access-point-edge", table: "billing_access_point_edges", occurredColumn: "created_at", requestIdExpression: "source.request_id",
    payloadExpression: `json_build_object('id',source.id,'requestId',source.request_id,'edgeOrder',source.edge_order,'chainIndex',source.chain_index,'buyerScopeRef',source.buyer_scope_ref,'sellerScopeRef',source.seller_scope_ref,'accessPointId',source.access_point_id,'targetAccessPointId',source.target_access_point_id,'isInternal',source.is_internal,'accessPointPriceId',source.access_point_price_id,'priceTierKey',source.price_tier_key,'priceSnapshotJson',source.price_snapshot_json,'inputTokens',source.input_tokens,'cachedInputTokens',source.cached_input_tokens,'cacheWriteTokens',source.cache_write_tokens,'outputTokens',source.output_tokens,'amount',source.amount,'amountUnits',source.amount_units,'createdAt',source.created_at)`,
  },
  {
    domain: "billing-provider-cost-events", factKind: "billing-provider-cost-event", table: "billing_provider_cost_events", occurredColumn: "created_at", requestIdExpression: "source.request_id",
    payloadExpression: `json_build_object('id',source.id,'requestId',source.request_id,'providerAttemptId',source.provider_attempt_id,'operationKind',source.operation_kind,'providerOwnerScopeRef',source.provider_owner_scope_ref,'providerId',source.provider_id,'providerModelName',source.provider_model_name,'providerModelCostId',source.provider_model_cost_id,'costTierKey',source.cost_tier_key,'costSnapshotJson',source.cost_snapshot_json,'inputTokens',source.input_tokens,'cachedInputTokens',source.cached_input_tokens,'cacheWriteTokens',source.cache_write_tokens,'outputTokens',source.output_tokens,'amount',source.amount,'amountUnits',source.amount_units,'createdAt',source.created_at)`,
  },
  {
    domain: "mcp-orchestration-runs", factKind: "mcp-orchestration-run", table: "mcp_orchestration_runs", occurredColumn: "started_at", requestIdExpression: "source.request_id",
    payloadExpression: `json_build_object('id',source.id,'requestId',source.request_id,'status',source.status,'startedAt',source.started_at,'endedAt',source.ended_at)`,
  },
  {
    domain: "mcp-tool-call-attempts", factKind: "mcp-tool-call-attempt", table: "mcp_tool_call_attempts", occurredColumn: "started_at", requestIdExpression: "run.request_id",
    payloadExpression: `json_build_object('id',source.id,'runId',source.run_id,'sequence',source.sequence,'planId',source.plan_id,'planSubscriptionId',source.plan_subscription_id,'publicToolAlias',source.public_tool_alias,'upstreamToolName',source.upstream_tool_name,'connectorId',source.connector_id,'risk',source.risk,'status',source.status,'chargeUnits',source.charge_units,'stableErrorCode',source.stable_error_code,'startedAt',source.started_at,'endedAt',source.ended_at)`,
    joins: `INNER JOIN mcp_orchestration_runs run ON run.id=source.run_id`,
  },
  {
    domain: "mcp-spend-reservations", factKind: "mcp-spend-reservation", table: "mcp_spend_reservations", occurredColumn: "created_at", requestIdExpression: "run.request_id",
    payloadExpression: `json_build_object('id',source.id,'runId',source.run_id,'toolCallAttemptId',source.tool_call_attempt_id,'planSubscriptionId',source.plan_subscription_id,'accountId',source.account_id,'reservedUnits',source.reserved_units,'consumedUnits',source.consumed_units,'status',source.status,'expiresAt',source.expires_at,'createdAt',source.created_at,'terminalAt',source.terminal_at)`,
    joins: `INNER JOIN mcp_orchestration_runs run ON run.id=source.run_id`,
  },
  {
    domain: "audit-logs", factKind: "audit-log", table: "audit_logs", occurredColumn: "created_at", requestIdExpression: "source.request_id",
    payloadExpression: `json_build_object('id',source.id,'actorType',source.actor_type,'actorId',source.actor_id,'action',source.action,'resourceType',source.resource_type,'resourceId',source.resource_id,'result',source.result,'requestId',source.request_id,'source',source.source,'ipHash',source.ip_hash,'userAgentHash',source.user_agent_hash,'metadataJson',source.metadata_json,'createdAt',source.created_at)`,
  },
];

const MAX_HISTORY_ROWS_PER_DOMAIN = 1_000_000;

export interface RequestHistoryArchivePlan {
  archiveMonth: string;
  cutoffGte: string;
  cutoffLt: string;
  eligibleBefore: string;
}

export function planRequestHistoryArchiveMonth(value: string | undefined, now = new Date(), hotDays = 180): RequestHistoryArchivePlan {
  const archiveMonth = value === undefined || value === "previous" ? previousEligibleUtcMonth(now, hotDays) : value;
  if (!/^\d{4}-\d{2}$/.test(archiveMonth)) throw archiveError("request_history_archive_month_invalid");
  const parts = archiveMonth.split("-").map(Number);
  const year = parts[0] as number;
  const month = parts[1] as number;
  const start = new Date(Date.UTC(year, month - 1, 1));
  if (start.getUTCFullYear() !== year || start.getUTCMonth() !== month - 1) throw archiveError("request_history_archive_month_invalid");
  const end = new Date(Date.UTC(year, month, 1));
  const eligibleBefore = new Date(now.getTime() - hotDays * 86_400_000);
  if (end > eligibleBefore) throw archiveError("request_history_archive_month_not_eligible");
  return { archiveMonth, cutoffGte: start.toISOString(), cutoffLt: end.toISOString(), eligibleBefore: eligibleBefore.toISOString() };
}

export async function runRequestHistoryArchive(input: {
  config: AppConfig;
  client: PostgresClientOwner;
  month?: string;
  now?: Date;
  dryRun?: boolean;
}): Promise<Record<string, unknown>> {
  const plan = planRequestHistoryArchiveMonth(input.month, input.now, input.config.archive.history.hotDays);
  if (!input.config.archive.history.enabled) throw archiveError("request_history_archive_disabled");
  if (!input.config.archive.coldDirectory) throw archiveError("request_history_archive_cold_directory_required");
  const rowsByDomain = await loadRows(input.client, plan);
  const rowCounts = Object.fromEntries(REQUEST_HISTORY_ARCHIVE_DOMAINS.map((domain) => [domain, rowsByDomain.get(domain)?.length ?? 0]));
  if (input.dryRun) return { archiveMonth: plan.archiveMonth, cutoff: { gte: plan.cutoffGte, lt: plan.cutoffLt }, eligibleBefore: plan.eligibleBefore, rowCounts, dryRun: true };

  await preflightFilesystemArchiveMount({ coldDirectory: input.config.archive.coldDirectory, hotDirectory: input.config.archive.directory, requireMount: input.config.archive.requireColdMount });
  const cold = new FilesystemArchiveRemote(input.config.archive.coldDirectory, { createRoot: false, enforcePrivateObjects: true });
  const staging = join(input.config.archive.directory, ".staging", `request-history-${plan.archiveMonth}`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true, mode: 0o700 });
  const createdAt = (input.now ?? new Date()).toISOString();
  try {
    const artifacts: HistoryArchiveArtifact[] = [];
    for (const spec of DOMAIN_SPECS) {
      artifacts.push(await writeDomainArtifact(cold, staging, spec, plan, rowsByDomain.get(spec.domain) ?? [], createdAt));
    }
    artifacts.sort((a, b) => a.domain.localeCompare(b.domain));
    const sourceSnapshotSha256 = closureSourceSnapshot(artifacts);
    const closureObjectKey = historyObjectKey(plan.archiveMonth, "closure-manifest-v1.json");
    const closureManifest: RequestHistoryClosureManifestV1 = { manifestVersion: 1, kind: "request-history-closure", archiveMonth: plan.archiveMonth, cutoffGte: plan.cutoffGte, cutoffLt: plan.cutoffLt, sourceSnapshotSha256, artifacts, createdAt };
    const closureBytes = Buffer.from(`${JSON.stringify(closureManifest)}\n`, "utf8");
    const closureSha = historyFactSha256Hex(closureBytes);
    await cold.put(closureObjectKey, closureBytes, closureSha);
    if (historyFactSha256Hex(await cold.read(closureObjectKey)) !== closureSha) throw archiveError("request_history_archive_closure_readback_mismatch");
    const currentRows = await loadRows(input.client, plan);
    for (const domain of REQUEST_HISTORY_ARCHIVE_DOMAINS) {
      const before = rowsSnapshot(rowsByDomain.get(domain) ?? []);
      const after = rowsSnapshot(currentRows.get(domain) ?? []);
      if (before.count !== after.count || before.sha256 !== after.sha256) throw archiveError("request_history_archive_source_snapshot_changed");
    }
    await input.client.withTransaction(async (tx) => commitArchive(tx, plan, closureManifest, closureSha, rowsByDomain, createdAt));
    return { archiveMonth: plan.archiveMonth, status: "verified", artifacts: artifacts.map(({ domain, rowCount, objectSha256 }) => ({ domain, rowCount, objectSha256 })), autoPurge: input.config.archive.history.autoPurge };
  } catch (error) {
    await input.client.withTransaction(async (tx) => {
      await tx.query(`UPDATE "history_archive_closures" SET status='failed',failure_code=$1 WHERE archive_month=$2 AND status IN ('collecting','failed')`, [archiveErrorCode(error), plan.archiveMonth]).catch(() => undefined);
    }).catch(() => undefined);
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function runRequestHistoryArchiveCatchUp(input: Omit<Parameters<typeof runRequestHistoryArchive>[0], "month">): Promise<Record<string, unknown>[]> {
  const end = planRequestHistoryArchiveMonth("previous", input.now, input.config.archive.history.hotDays).archiveMonth;
  const first = await input.client.query<{ month: string | null }>(`SELECT MIN(month) AS month FROM (
    SELECT substr(started_at,1,7) AS month FROM request_logs
    UNION ALL SELECT substr(started_at,1,7) FROM request_executions
    UNION ALL SELECT substr(started_at,1,7) FROM request_provider_attempts
    UNION ALL SELECT substr(occurred_at,1,7) FROM provider_invocation_usage_facts
    UNION ALL SELECT substr(created_at,1,7) FROM usage_reservations
    UNION ALL SELECT substr(created_at,1,7) FROM billing_events
    UNION ALL SELECT substr(created_at,1,7) FROM billing_access_point_edges
    UNION ALL SELECT substr(created_at,1,7) FROM billing_provider_cost_events
    UNION ALL SELECT substr(started_at,1,7) FROM mcp_orchestration_runs
    UNION ALL SELECT substr(started_at,1,7) FROM mcp_tool_call_attempts
    UNION ALL SELECT substr(created_at,1,7) FROM mcp_spend_reservations
    UNION ALL SELECT substr(created_at,1,7) FROM audit_logs
  ) months WHERE month IS NOT NULL`);
  if (!first.rows[0]?.month) return [];
  const results: Record<string, unknown>[] = [];
  for (let month = first.rows[0].month; month <= end; month = nextUtcMonth(month)) {
    try { results.push(await runRequestHistoryArchive({ ...input, month })); }
    catch (error) { results.push({ archiveMonth: month, status: "blocked", errorCode: archiveErrorCode(error) }); }
  }
  return results;
}

export async function verifyRequestHistoryArchive(input: { config: AppConfig; client: PostgresClientOwner; month: string }): Promise<RequestHistoryClosureManifestV1> {
  if (!input.config.archive.coldDirectory) throw archiveError("request_history_archive_cold_directory_required");
  const closure = await input.client.query<{ status: string; source_snapshot_sha256: string; closure_manifest_object_key: string; closure_manifest_sha256: string | null }>(`SELECT status,source_snapshot_sha256,closure_manifest_object_key,closure_manifest_sha256 FROM "history_archive_closures" WHERE archive_month=$1`, [input.month]);
  const row = closure.rows[0];
  if (!row || !["verified", "purged"].includes(row.status) || !row.closure_manifest_sha256) throw archiveError("request_history_archive_closure_not_verified");
  const cold = new FilesystemArchiveRemote(input.config.archive.coldDirectory, { createRoot: false, enforcePrivateObjects: true });
  const bytes = await cold.read(row.closure_manifest_object_key);
  if (historyFactSha256Hex(bytes) !== row.closure_manifest_sha256) throw archiveError("request_history_archive_closure_manifest_mismatch");
  const manifest = parseRequestHistoryClosureManifestV1(bytes.toString("utf8"));
  if (manifest.sourceSnapshotSha256 !== row.source_snapshot_sha256 || manifest.archiveMonth !== input.month) throw archiveError("request_history_archive_closure_identity_mismatch");
  const staging = join(input.config.archive.directory, ".staging", `verify-request-history-${input.month}`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true, mode: 0o700 });
  try {
    for (const artifact of manifest.artifacts) {
      const artifactManifestBytes = await cold.read(artifact.manifestObjectKey);
      if (historyFactSha256Hex(artifactManifestBytes) !== artifact.manifestSha256) throw archiveError("request_history_archive_artifact_manifest_mismatch");
      const artifactManifest = parseHistoryFactArchiveManifestV1(artifactManifestBytes.toString("utf8"));
      const path = join(staging, `${artifact.domain}.parquet`);
      await cold.downloadToFile(artifact.objectKey, path);
      await scanAndVerifyHistoryFactsParquet(path, artifactManifest);
    }
  } finally { await rm(staging, { recursive: true, force: true }); }
  return manifest;
}

export function parseRequestHistoryClosureManifestV1(value: string | unknown): RequestHistoryClosureManifestV1 {
  let raw: Record<string, unknown>;
  try { raw = (typeof value === "string" ? JSON.parse(value) : value) as Record<string, unknown>; }
  catch { throw archiveError("request_history_archive_closure_manifest_invalid"); }
  if (!raw || raw.manifestVersion !== 1 || raw.kind !== "request-history-closure" || !/^\d{4}-\d{2}$/.test(String(raw.archiveMonth)) || !/^[a-f0-9]{64}$/.test(String(raw.sourceSnapshotSha256)) || !Array.isArray(raw.artifacts) || raw.artifacts.length !== REQUEST_HISTORY_ARCHIVE_DOMAINS.length) {
    throw archiveError("request_history_archive_closure_manifest_invalid");
  }
  const artifacts = raw.artifacts as Array<Record<string, unknown>>;
  const allowed = new Set(REQUEST_HISTORY_ARCHIVE_DOMAINS);
  const domains = artifacts.map((artifact) => String(artifact.domain));
  if (new Set(domains).size !== domains.length || domains.some((domain) => !allowed.has(domain as RequestHistoryArchiveDomain))) throw archiveError("request_history_archive_closure_manifest_invalid");
  return raw as unknown as RequestHistoryClosureManifestV1;
}

export interface RequestHistoryClosureManifestV1 {
  manifestVersion: 1;
  kind: "request-history-closure";
  archiveMonth: string;
  cutoffGte: string;
  cutoffLt: string;
  sourceSnapshotSha256: string;
  artifacts: HistoryArchiveArtifact[];
  createdAt: string;
}

export interface HistoryArchiveArtifact {
  archiveMonth: string;
  domain: RequestHistoryArchiveDomain;
  schemaVersion: number;
  rowCount: number;
  compressedBytes: number;
  uncompressedBytes: number;
  objectKey: string;
  objectSha256: string;
  manifestObjectKey: string;
  manifestSha256: string;
  sourceSnapshotSha256: string;
  createdAt: string;
}

async function loadRows(client: PostgresClientOwner, plan: RequestHistoryArchivePlan): Promise<Map<RequestHistoryArchiveDomain, HistoryRow[]>> {
  return client.withReadOnlyTransaction(async (tx) => {
    const result = new Map<RequestHistoryArchiveDomain, HistoryRow[]>();
    for (const spec of DOMAIN_SPECS) {
      const idExpression = spec.idExpression ?? "source.id";
      const query = `SELECT ${idExpression}::text AS id, ${spec.requestIdExpression}::text AS request_id, source.${spec.occurredColumn}::text AS occurred_at, ${spec.payloadExpression}::text AS payload_json FROM "${spec.table}" source ${spec.joins ?? ""} WHERE source.${spec.occurredColumn} >= $1 AND source.${spec.occurredColumn} < $2 ORDER BY source.${spec.occurredColumn} ASC, ${idExpression} ASC LIMIT ${MAX_HISTORY_ROWS_PER_DOMAIN + 1}`;
      const rawRows = (await tx.query<Record<string, unknown>>(query, [plan.cutoffGte, plan.cutoffLt])).rows;
      if (rawRows.length > MAX_HISTORY_ROWS_PER_DOMAIN) throw archiveError("request_history_archive_domain_row_limit_exceeded");
      const rows = rawRows.map((row: Record<string, unknown>) => ({ id: String(row.id), requestId: row.request_id === null ? null : String(row.request_id), occurredAt: String(row.occurred_at), payloadJson: String(row.payload_json), factKind: spec.factKind, ref: {} }));
      result.set(spec.domain, rows);
    }
    return result;
  });
}

async function writeDomainArtifact(cold: FilesystemArchiveRemote, staging: string, spec: DomainSpec, plan: RequestHistoryArchivePlan, rows: HistoryRow[], createdAt: string): Promise<HistoryArchiveArtifact> {
  const objectKey = historyObjectKey(plan.archiveMonth, `${spec.domain}/${spec.domain}-v1.parquet`);
  const manifestObjectKey = historyObjectKey(plan.archiveMonth, `${spec.domain}/${spec.domain}-manifest-v1.json`);
  const parquetPath = join(staging, `${spec.domain}-v1.parquet`);
  const written = await writeHistoryFactsParquetFromAsync(parquetPath, (async function* () { for (const row of rows) yield row; })());
  const fileStat = await stat(parquetPath);
  const manifest: HistoryFactArchiveManifestV1 = { manifestVersion: 1, schemaVersion: HISTORY_FACT_ARCHIVE_SCHEMA_VERSION, kind: "history-facts", domain: spec.domain, cutoffGte: plan.cutoffGte, cutoffLt: plan.cutoffLt, recordCount: written.count, objectKey, compressedBytes: fileStat.size, uncompressedBytes: await historyFactParquetUncompressedBytes(parquetPath), sha256: await historyFactSha256File(parquetPath), sourceSnapshotSha256: written.sourceSnapshotSha256, createdAt };
  await scanAndVerifyHistoryFactsParquet(parquetPath, manifest);
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
  await writeFile(join(staging, `${spec.domain}-manifest-v1.json`), manifestBytes, { mode: 0o600, flag: "wx" });
  const manifestSha = historyFactSha256Hex(manifestBytes);
  await cold.putFile(objectKey, parquetPath, manifest.compressedBytes, manifest.sha256);
  await cold.put(manifestObjectKey, manifestBytes, manifestSha);
  const readbackManifest = parseHistoryFactArchiveManifestV1((await cold.read(manifestObjectKey)).toString("utf8"));
  const readbackPath = join(staging, `${spec.domain}-readback.parquet`);
  await cold.downloadToFile(objectKey, readbackPath);
  await scanAndVerifyHistoryFactsParquet(readbackPath, readbackManifest);
  return { archiveMonth: plan.archiveMonth, domain: spec.domain, schemaVersion: HISTORY_FACT_ARCHIVE_SCHEMA_VERSION, rowCount: manifest.recordCount, compressedBytes: manifest.compressedBytes, uncompressedBytes: manifest.uncompressedBytes, objectKey, objectSha256: manifest.sha256, manifestObjectKey, manifestSha256: manifestSha, sourceSnapshotSha256: manifest.sourceSnapshotSha256, createdAt };
}

async function commitArchive(tx: PostgresTransactionContext, plan: RequestHistoryArchivePlan, manifest: RequestHistoryClosureManifestV1, closureSha: string, rowsByDomain: Map<RequestHistoryArchiveDomain, HistoryRow[]>, createdAt: string): Promise<void> {
  const existing = await tx.query<{ status: string; source_snapshot_sha256: string }>(`SELECT status,source_snapshot_sha256 FROM "history_archive_closures" WHERE archive_month=$1 FOR UPDATE`, [plan.archiveMonth]);
  if (existing.rows[0] && existing.rows[0].source_snapshot_sha256 !== manifest.sourceSnapshotSha256) throw archiveError("request_history_archive_source_snapshot_changed");
  if (!existing.rows[0]) {
    await tx.query(`INSERT INTO "history_archive_closures" (archive_month,status,source_snapshot_sha256,closure_manifest_object_key,closure_manifest_sha256,failure_code,created_at,verified_at,purged_at) VALUES ($1,'collecting',$2,$3,NULL,NULL,$4,NULL,NULL)`, [plan.archiveMonth, manifest.sourceSnapshotSha256, historyObjectKey(plan.archiveMonth, "closure-manifest-v1.json"), createdAt]);
  }
  for (const artifact of manifest.artifacts) {
    await tx.query(`INSERT INTO "history_archive_artifacts" (archive_month,domain,schema_version,row_count,compressed_bytes,uncompressed_bytes,object_key,object_sha256,manifest_object_key,manifest_sha256,source_snapshot_sha256,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (archive_month,domain) DO NOTHING`, [artifact.archiveMonth, artifact.domain, artifact.schemaVersion, artifact.rowCount, artifact.compressedBytes, artifact.uncompressedBytes, artifact.objectKey, artifact.objectSha256, artifact.manifestObjectKey, artifact.manifestSha256, artifact.sourceSnapshotSha256, artifact.createdAt]);
    for (const row of rowsByDomain.get(artifact.domain) ?? []) {
      const ref = historyRefMetadata(row);
      await tx.query(`INSERT INTO "history_archive_fact_refs" (fact_kind,fact_id,request_id,archive_month,artifact_domain,object_sha256,row_key,occurred_at,actor_type,actor_id,action,resource_type,resource_id,result,source,amount,buyer_scope_ref,seller_scope_ref,provider_owner_scope_ref,provider_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,$2,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) ON CONFLICT (fact_kind,fact_id) DO NOTHING`, [row.factKind, row.id, row.requestId, artifact.archiveMonth, artifact.domain, artifact.objectSha256, row.occurredAt, ref.actorType, ref.actorId, ref.action, ref.resourceType, ref.resourceId, ref.result, ref.source, ref.amount, ref.buyerScopeRef, ref.sellerScopeRef, ref.providerOwnerScopeRef, ref.providerId, createdAt]);
    }
  }
  await tx.query(`UPDATE "history_archive_closures" SET status='verified',closure_manifest_sha256=$1,failure_code=NULL,verified_at=$2 WHERE archive_month=$3 AND status IN ('collecting','failed')`, [closureSha, createdAt, plan.archiveMonth]);
}

function historyRefMetadata(row: HistoryRow): {
  actorType: string | null; actorId: string | null; action: string | null; resourceType: string | null; resourceId: string | null;
  result: string | null; source: string | null; amount: number | null; buyerScopeRef: string | null; sellerScopeRef: string | null;
  providerOwnerScopeRef: string | null; providerId: string | null;
} {
  let payload: Record<string, unknown> = {};
  try { const parsed = JSON.parse(row.payloadJson); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>; } catch { /* Parquet writer already validates this. */ }
  const text = (key: string): string | null => typeof payload[key] === "string" ? payload[key] as string : null;
  const number = (key: string): number | null => typeof payload[key] === "number" && Number.isFinite(payload[key]) ? payload[key] as number : null;
  return {
    actorType: text("actorType"), actorId: text("actorId"), action: text("action"), resourceType: text("resourceType"), resourceId: text("resourceId"),
    result: text("result"), source: text("source"), amount: number("amount") ?? number("billableAmount") ?? number("providerCostAmount"),
    buyerScopeRef: text("buyerScopeRef"), sellerScopeRef: text("sellerScopeRef"), providerOwnerScopeRef: text("providerOwnerScopeRef"), providerId: text("providerId"),
  };
}

function closureSourceSnapshot(artifacts: readonly HistoryArchiveArtifact[]): string {
  const digest = createHash("sha256");
  for (const artifact of artifacts) digest.update(`${JSON.stringify([artifact.domain, artifact.rowCount, artifact.sourceSnapshotSha256])}\n`);
  return digest.digest("hex");
}

function rowsSnapshot(rows: readonly HistoryRow[]): { count: number; sha256: string } {
  const digest = createHash("sha256");
  for (const row of rows) digest.update(`${JSON.stringify([row.id, row.requestId, row.occurredAt, row.payloadJson])}\n`);
  return { count: rows.length, sha256: digest.digest("hex") };
}

function historyObjectKey(month: string, suffix: string): string { return `history/v1/year=${month.slice(0, 4)}/month=${month.slice(5, 7)}/${suffix}`; }
function previousEligibleUtcMonth(now: Date, hotDays: number): string {
  const eligible = new Date(now.getTime() - hotDays * 86_400_000);
  return new Date(Date.UTC(eligible.getUTCFullYear(), eligible.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
}
function nextUtcMonth(month: string): string { const parts = month.split("-").map(Number); const year = parts[0] as number; const value = parts[1] as number; return new Date(Date.UTC(year, value, 1)).toISOString().slice(0, 7); }
function archiveError(code: string): Error & { code: string } { return Object.assign(new Error(code), { code }); }
function archiveErrorCode(error: unknown): string { return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "request_history_archive_failed"; }
