import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RelayError } from "@frely/core";
import { PrismaAuditEventAppender, type AuditEventAppender } from "@frely/audit/application-internal";
import {
  ModelAccessCommandService,
  ModelAccessManagementQueryService,
  ModelAccessRoutingQueryService,
} from "@frely/model-access/application-internal";
import {
  createModelAccessRoutingQueryBudget,
  type ChangeAccessPointCommand,
  type CreateAccessPointCommand,
} from "@frely/model-access/server";
import { BillingCommandService, createModelAccessVerificationCommands } from "@frely/application/internal/operations";
import { PostgresClientOwner, type PrismaTransactionOwner } from "@frely/postgres/server";
import { PostgresVerificationRuntime } from "./postgres-verification-runtime.js";
import { SqlShapeCollector, type SqlShapeInventory } from "./sql-shape-observation.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const postgresPackageRoot = join(packageRoot, "..", "postgres");
const prismaConfigPath = join(postgresPackageRoot, "prisma.config.ts");
const prismaBinPath = join(postgresPackageRoot, "node_modules", ".bin", "prisma");
const postgresImage = process.env.FRIDAY_RELAY_MODEL_ACCESS_POSTGRES_IMAGE ?? "postgres:16-alpine";
const postgresUser = "friday_model_access";
const postgresPassword = "friday_model_access_local_only";
const database = "friday_model_access";
const maximumCommandOutputBytes = 32 * 1024 * 1024;
const now = new Date().toISOString();
const audit = { actor: { actorType: "user" as const, actorId: "owner" }, source: "owner" as const, requestId: "req_model_access_verifier" };
type ObserveSqlShape = <T>(label: string, operation: () => Promise<T>) => Promise<T>;

async function main(): Promise<void> {
  const runtime = await PostgresVerificationRuntime.start({
    verifier: "model_access",
    databases: [database],
    docker: { image: postgresImage, user: postgresUser, password: postgresPassword, containerPrefix: "friday-relay-model-access" },
    allowSuppliedDisposableDatabase: true,
  });
  let owner: PostgresClientOwner | undefined;
  try {
    const connectionString = runtime.connectionString(database);
    run("bun", [prismaBinPath, "migrate", "deploy", "--config", prismaConfigPath], undefined, {
      ...process.env,
      FRIDAY_RELAY_PG_CONNECTION_STRING: connectionString,
    }, runtime);
    let activeSqlCollector: SqlShapeCollector | undefined;
    const routingSqlShapes: Record<string, SqlShapeInventory> = {};
    const observeRoutingSql: ObserveSqlShape = async <T>(label: string, operation: () => Promise<T>): Promise<T> => {
      const collector = new SqlShapeCollector();
      activeSqlCollector = collector;
      try {
        return await operation();
      } finally {
        activeSqlCollector = undefined;
        routingSqlShapes[label] = collector.snapshot();
      }
    };
    owner = new PostgresClientOwner({
      connectionString,
      max: 4,
      queryObserver: (observation) => activeSqlCollector?.record(observation),
    });
    const commands = new ModelAccessCommandService(owner, new PrismaAuditEventAppender());
    const queries = new ModelAccessManagementQueryService(owner);
    const routingQueries = new ModelAccessRoutingQueryService(owner);
    const billing = new BillingCommandService(owner);
    await seedOwner(owner);
    await seedProvider(owner);
    await verifyAuditValidationRollback(owner, commands);
    const providerVerification = await verifyProviderManagement(owner, commands, queries);

    const createInput = accessPointInput("AP A", "edge_a");
    const created = await commands.createAccessPoint(createInput, audit);
    assert(created.routingRevision === 1, "create_revision");
    assert(!created.replayed, "create_not_replayed");
    const createdView = await queries.getAccessPointWithRouting(created.id);
    assert(createdView?.routing.routingRevision === 1 && createdView.routing.targets.length === 1, "create_management_readback");
    assert(createdView?.routing.targets[0]?.targetProviderModelId === "provider_model_test", "create_stable_provider_model_reference");
    assert(createdView !== undefined && !("createRequestHash" in createdView) && !("createIdempotencyKeyHash" in createdView), "management_readback_internal_hashes_hidden");
    const routingReport = await observeRoutingSql(
      "gateway.initial_diagnostic",
      () => routingQueries.inspectAccessPointRouting(created.id, createModelAccessRoutingQueryBudget()),
    );
    assert(routingReport.entryAccessPoint.id === created.id && routingReport.entryAccessPoint.routingRevision === 1, "routing_query_entry_revision");
    assert(routingReport.candidates[0]?.providerModelId === "provider_model_test", "routing_query_stable_provider_model_identity");
    assert(routingReport.work.visitedNodes === 1 && routingReport.work.visitedEdges === 1, "routing_query_bounded_graph_work");
    const routingProjection = JSON.stringify(routingReport);
    assert(!routingProjection.includes("credentialResolver") && !routingProjection.includes("api-key:verifier"), "routing_query_credential_redacted");
    assert(!routingProjection.includes("baseUrlResolver") && !routingProjection.includes("https://example.invalid"), "routing_query_base_url_redacted");
    const gatewayRoutingSnapshot = await observeRoutingSql(
      "gateway.initial",
      () => routingQueries.evaluateGatewayRouting({
        entryAccessPointId: created.id,
        requestedModel: "model-test",
      }),
    );
    assert(gatewayRoutingSnapshot.candidates[0]?.providerModelId === "provider_model_test", "gateway_routing_snapshot_stable_provider_model_identity");
    assert(Object.keys(gatewayRoutingSnapshot.scopeReferences.accessPoints[0] ?? {}).sort().join(",") === "id,routingRevision,scopeRef", "gateway_routing_snapshot_access_point_scope_allowlist");
    assert(Object.keys(gatewayRoutingSnapshot.scopeReferences.providers[0] ?? {}).sort().join(",") === "id,scopeRef", "gateway_routing_snapshot_provider_scope_allowlist");
    const gatewayRoutingProjection = JSON.stringify(gatewayRoutingSnapshot);
    assert(!gatewayRoutingProjection.includes("credentialResolver") && !gatewayRoutingProjection.includes("api-key:verifier"), "gateway_routing_snapshot_credential_redacted");
    assert(!gatewayRoutingProjection.includes("baseUrlResolver") && !gatewayRoutingProjection.includes("https://example.invalid"), "gateway_routing_snapshot_base_url_redacted");
    const replayedCreate = await commands.createAccessPoint(createInput, audit);
    assert(replayedCreate.id === created.id && replayedCreate.replayed, "create_idempotency_replay");
    const createAudits = await owner.prisma.audit_logs.findMany({ where: { action: "access_point.create", resource_id: created.id } });
    assert(createAudits.length === 1, "create_idempotency_single_audit");
    assert(createAudits[0]?.result === "success", "create_audit_success");
    const createAuditMetadata = JSON.parse(createAudits[0]!.metadata_json) as Record<string, unknown>;
    assert(Object.keys(createAuditMetadata).sort().join(",") === "accessPointId,scopeRef", "create_audit_metadata_exact");
    assert(createAuditMetadata.accessPointId === created.id && createAuditMetadata.scopeRef === "global:", "create_audit_metadata_values");
    await expectRelay("access_point_idempotency_conflict", () => commands.createAccessPoint({ ...createInput, name: "AP A conflict" }, audit));
    assert(await owner.prisma.audit_logs.count({ where: { action: "access_point.create", result: { in: ["denied", "failure"] } } }) === 0, "create_rejection_not_audited");
    const concurrentCreateInput = accessPointInput("AP concurrent create", "edge_concurrent_create");
    const concurrentCreates = await Promise.all([
      commands.createAccessPoint(concurrentCreateInput, audit),
      commands.createAccessPoint(concurrentCreateInput, audit),
    ]);
    assert(concurrentCreates[0]!.id === concurrentCreates[1]!.id, "concurrent_create_single_identity");
    assert(concurrentCreates.filter((result) => result.replayed).length === 1, "concurrent_create_single_transition");
    assert(await owner.prisma.audit_logs.count({ where: { action: "access_point.create", resource_id: concurrentCreates[0]!.id } }) === 1, "concurrent_create_single_audit");
    const initialEdge = await owner.prisma.accessPointTarget.findUniqueOrThrow({ where: { id: "edge_a" } });
    assert(initialEdge.targetProviderModelId === "provider_model_test", "command_dual_writes_provider_model_reference");
    const oldWriterEdge = await owner.prisma.accessPointTarget.create({ data: {
      id: "edge_old_writer_compatibility",
      accessPointId: created.id,
      targetType: "provider-model",
      targetAccessPointId: null,
      targetProviderId: "provider_test",
      targetProviderModelName: "model-test",
      position: 99,
      status: "disabled",
      removedAt: now,
      createdAt: now,
      updatedAt: now,
    } });
    assert(oldWriterEdge.targetProviderModelId === "provider_model_test", "old_writer_reference_derived");
    await expectFailure(() => owner!.prisma.accessPointTarget.create({ data: {
      id: "edge_provider_model_reference_mismatch",
      accessPointId: created.id,
      targetType: "provider-model",
      targetAccessPointId: null,
      targetProviderId: "provider_test",
      targetProviderModelName: "model-test",
      targetProviderModelId: "provider_model_mismatch",
      position: 100,
      status: "disabled",
      removedAt: now,
      createdAt: now,
      updatedAt: now,
    } }));

    const noOp = await commands.changeAccessPoint(created.id, changeInput("AP A renamed", "edge_a", 1), audit);
    assert(noOp.routingRevision === 1 && !noOp.routingChanged, "semantic_noop_revision");
    const preservedEdge = await owner.prisma.accessPointTarget.findUniqueOrThrow({ where: { id: "edge_a" } });
    assert(preservedEdge.createdAt === initialEdge.createdAt, "edge_created_at_preserved");

    const overridden = await commands.changeAccessPoint(created.id, {
      ...changeInput("AP A renamed", "edge_a", 1),
      routing: {
        ...changeInput("AP A renamed", "edge_a", 1).routing!,
        requestOverrides: { service_tier: "fast", temperature: 0 },
      },
    }, audit);
    assert(overridden.routingRevision === 2 && overridden.routingChanged, "request_overrides_increment_revision");
    assert((await owner.prisma.accessPoint.findUniqueOrThrow({ where: { id: created.id } })).requestOverridesJson === '{"service_tier":"fast","temperature":0}', "request_overrides_canonical");

    const expanded = await commands.changeAccessPoint(created.id, {
      ...changeInput("AP A renamed", "edge_a", 2),
      routing: {
        selector: { id: "ordered-fallback", behaviorVersion: 1, config: { maxAttempts: 2, retryOn: ["timeout"] } },
        requestOverrides: { service_tier: "fast", temperature: 0 },
        expectedRoutingRevision: 2,
        targets: [providerTarget("edge_a", 0), providerTarget("edge_b", 1)],
      },
    }, audit);
    assert(expanded.routingRevision === 3 && expanded.routingChanged, "routing_revision_increment");

    const contracted = await commands.changeAccessPoint(created.id, changeInput("AP A renamed", "edge_a", 3), audit);
    assert(contracted.routingRevision === 4, "routing_contraction_revision");
    const tombstone = await owner.prisma.accessPointTarget.findUniqueOrThrow({ where: { id: "edge_b" } });
    assert(tombstone.status === "disabled" && tombstone.removedAt !== null, "omitted_edge_tombstone");
    await expectRelay("access_point_target_removed", () => commands.changeAccessPoint(created.id, {
      ...changeInput("AP A renamed", "edge_a", 4),
      routing: {
        selector: { id: "ordered-fallback", behaviorVersion: 1, config: {} },
        expectedRoutingRevision: 4,
        targets: [providerTarget("edge_a", 0), providerTarget("edge_b", 1)],
      },
    }, audit));

    const target = await commands.createAccessPoint(accessPointInput("AP B", "edge_target"), audit);
    const configuredPrice = await billing.configureInitialAccessPointPrice(target.id, { price: { inputPer1M: 1, cachedInputPer1M: 1, cacheWritePer1M: 1, outputPer1M: 1 } }, audit);
    const replayedPrice = await billing.configureInitialAccessPointPrice(target.id, { price: { inputPer1M: 99, cachedInputPer1M: 99, cacheWritePer1M: 99, outputPer1M: 99 } }, audit);
    assert(replayedPrice.replayed && replayedPrice.priceId === configuredPrice.priceId, "initial_price_idempotency");
    assert(await owner.prisma.audit_logs.count({ where: { action: "access_point_price.create", resource_id: configuredPrice.priceId } }) === 1, "initial_price_single_audit");
    const initialPriceAudit = await owner.prisma.audit_logs.findFirstOrThrow({ where: { action: "access_point_price.create", resource_id: configuredPrice.priceId } });
    assert(initialPriceAudit.result === "success", "initial_price_audit_result_explicit");
    assert(Object.keys(JSON.parse(initialPriceAudit.metadata_json) as Record<string, unknown>).sort().join(",") === "accessPointId,priceSource,tierCount", "initial_price_audit_metadata_strict");
    const appendPriceOperations = createModelAccessVerificationCommands(owner);
    const appendPriceCountBeforeAuditFailure = await owner.prisma.access_point_prices.count({ where: { access_point_id: target.id } });
    await owner.prisma.$executeRawUnsafe(`
      CREATE FUNCTION "verification_fail_append_price_audit"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."action" = 'access_point_price.create' THEN RAISE EXCEPTION 'verification append price audit failure'; END IF;
        RETURN NEW;
      END $$
    `);
    await owner.prisma.$executeRawUnsafe(`
      CREATE TRIGGER "verification_fail_append_price_audit"
      BEFORE INSERT ON "audit_logs"
      FOR EACH ROW EXECUTE FUNCTION "verification_fail_append_price_audit"()
    `);
    try {
      await expectFailure(() => appendPriceOperations.createAccessPointPrice({
        accessPointId: target.id,
        inputPer1M: 6,
        cachedInputPer1M: 6,
        cacheWritePer1M: 6,
        outputPer1M: 6,
        tiers: [],
      }, audit));
    } finally {
      await owner.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "verification_fail_append_price_audit" ON "audit_logs"`);
      await owner.prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "verification_fail_append_price_audit"()`);
    }
    assert(await owner.prisma.access_point_prices.count({ where: { access_point_id: target.id } }) === appendPriceCountBeforeAuditFailure,
      "append_price_audit_failure_rolls_back_price");
    const appendedPrice = await appendPriceOperations.createAccessPointPrice({
      accessPointId: target.id,
      inputPer1M: 7,
      cachedInputPer1M: 7,
      cacheWritePer1M: 7,
      outputPer1M: 7,
      tiers: [],
    }, audit);
    assert(await owner.prisma.audit_logs.count({ where: { action: "access_point_price.create", resource_id: appendedPrice.id } }) === 1,
      "append_price_and_audit_commit_atomically");
    const copiedPriceAccessPoint = await commands.createAccessPoint(accessPointInput("AP copied price", "edge_copied_price"), audit);
    const copiedPrice = await billing.configureInitialAccessPointPrice(copiedPriceAccessPoint.id, { price: null }, audit);
    const copiedPriceRow = await owner.prisma.access_point_prices.findUniqueOrThrow({ where: { id: copiedPrice.priceId } });
    assert(copiedPriceRow.input_price_units_per_1m === 2_000_000n && copiedPriceRow.output_price_units_per_1m === 8_000_000n, "initial_price_target_copy");
    const concurrentPriceAccessPoint = await commands.createAccessPoint(accessPointInput("AP concurrent price", "edge_concurrent_price"), audit);
    const concurrentPrices = await Promise.all([
      billing.configureInitialAccessPointPrice(concurrentPriceAccessPoint.id, { price: { inputPer1M: 3, cachedInputPer1M: 3, cacheWritePer1M: 3, outputPer1M: 3 } }, audit),
      billing.configureInitialAccessPointPrice(concurrentPriceAccessPoint.id, { price: { inputPer1M: 4, cachedInputPer1M: 4, cacheWritePer1M: 4, outputPer1M: 4 } }, audit),
    ]);
    assert(concurrentPrices[0]!.priceId === concurrentPrices[1]!.priceId, "initial_price_concurrent_identity");
    assert(await owner.prisma.access_point_prices.count({ where: { access_point_id: concurrentPriceAccessPoint.id, initial_price: 1 } }) === 1, "initial_price_concurrent_unique");
    const auditFailurePriceAccessPoint = await commands.createAccessPoint(accessPointInput("AP price audit failure", "edge_price_audit_failure"), audit);
    const failingAuditAppender: AuditEventAppender = { async append() { throw new Error("audit_persistence_unavailable"); } };
    const failingBilling = new BillingCommandService(owner, failingAuditAppender);
    await expectFailure(() => failingBilling.configureInitialAccessPointPrice(auditFailurePriceAccessPoint.id, { price: { inputPer1M: 5, cachedInputPer1M: 5, cacheWritePer1M: 5, outputPer1M: 5 } }, audit));
    assert(await owner.prisma.access_point_prices.count({ where: { access_point_id: auditFailurePriceAccessPoint.id } }) === 0, "initial_price_audit_failure_rolls_back");
    await commands.changeAccessPoint(target.id, changeInput("AP B", "edge_target", 1, "enabled"), audit);
    await expectRelay("access_point_must_be_disabled", () => commands.removeAccessPoint(target.id, audit));
    await commands.changeAccessPoint(target.id, changeInput("AP B", "edge_target", 1, "disabled"), audit);

    await commands.changeAccessPoint(created.id, {
      ...changeInput("AP A renamed", "edge_a", 4),
      targetModel: "model-test",
      routing: {
        selector: { id: "direct", behaviorVersion: 1, config: {} },
        expectedRoutingRevision: 4,
        targets: [{ id: "edge_inbound", type: "access-point", targetAccessPointId: target.id, position: 0, status: "enabled" }],
      },
    }, audit);
    await expectRelay("access_point_has_inbound_edge", () => commands.removeAccessPoint(target.id, audit));
    await commands.changeAccessPoint(created.id, {
      ...changeInput("AP A renamed", "edge_replacement", 5),
      routing: {
        selector: { id: "direct", behaviorVersion: 1, config: {} },
        expectedRoutingRevision: 5,
        targets: [providerTarget("edge_replacement", 0)],
      },
    }, audit);

    await owner.prisma.plans.create({ data: {
      id: "plan_enabled", owner_id: "owner", scope_ref: "global:", name: "Verifier Plan", version: 1,
      description: null, admin_note: null, billing_mode: "prepaid", purchase_amount: 0,
      purchase_amount_units: 0n,
      duration_seconds: 3600, plan_status: "enabled", catalog_status: "unlisted", created_at: now, updated_at: now,
    } });
    await owner.prisma.plan_access_points.create({ data: { id: "plan_ap", plan_id: "plan_enabled", access_point_id: target.id, created_at: now } });
    await expectRelay("access_point_has_enabled_plan", () => commands.removeAccessPoint(target.id, audit));
    await owner.prisma.plans.update({ where: { id: "plan_enabled" }, data: { plan_status: "disabled", updated_at: now } });
    const removed = await commands.removeAccessPoint(target.id, audit);
    assert(removed.removed, "logical_remove");
    assert((await owner.prisma.accessPoint.findUniqueOrThrow({ where: { id: target.id } })).removedAt !== null, "removed_marker");
    await expectFailure(() => owner!.prisma.accessPoint.update({ where: { id: target.id }, data: { removedAt: null } }));
    const concurrentRemoveTarget = await commands.createAccessPoint(accessPointInput("AP concurrent remove", "edge_concurrent_remove"), audit);
    const concurrentRemoves = await Promise.all([
      commands.removeAccessPoint(concurrentRemoveTarget.id, audit),
      commands.removeAccessPoint(concurrentRemoveTarget.id, audit),
    ]);
    assert(concurrentRemoves.every((result) => result.removed), "concurrent_remove_result");
    assert(concurrentRemoves.filter((result) => result.replayed).length === 1, "concurrent_remove_single_transition");

    const cycleLeft = await commands.createAccessPoint(accessPointInput("Cycle left", "edge_cycle_left_provider"), audit);
    const cycleRight = await commands.createAccessPoint(accessPointInput("Cycle right", "edge_cycle_right_provider"), audit);
    const reciprocal = await Promise.allSettled([
      commands.changeAccessPoint(cycleLeft.id, accessPointTargetChange("Cycle left", cycleRight.id), audit),
      commands.changeAccessPoint(cycleRight.id, accessPointTargetChange("Cycle right", cycleLeft.id), audit),
    ]);
    assert(reciprocal.filter((result) => result.status === "fulfilled").length === 1, "concurrent_reciprocal_one_commit");
    assert(reciprocal.some((result) => result.status === "rejected" && result.reason instanceof RelayError && result.reason.code === "access_point_cycle"), "concurrent_cycle_rejected");
    await verifyModelAccessAuditRows(owner);
    const routingDepthVerification = await verifyRoutingDepthAndBatchReads(owner, observeRoutingSql);
    const acceptedGatewayShapes = Object.entries(routingSqlShapes)
      .filter(([label]) => label === "gateway.initial" || [1, 12, 40, 200].some((hopCount) => label === `gateway.${hopCount}`));
    const acceptedDiagnosticShapes = Object.entries(routingSqlShapes)
      .filter(([label]) => label === "gateway.initial_diagnostic" || [1, 12, 40, 200].some((hopCount) => label === `diagnostic.${hopCount}`));
    assertFixedSqlShapes(acceptedGatewayShapes, "gateway_routing_sql_shape_fixed_across_depth");
    assertFixedSqlShapes(acceptedDiagnosticShapes, "diagnostic_routing_sql_shape_fixed_across_depth");

    process.stdout.write(`${JSON.stringify({
      createRevision: created.routingRevision,
      createIdempotency: true,
      routingQueryStableIdentity: true,
      routingQuerySecretsRedacted: true,
      gatewayRoutingSnapshotRedacted: true,
      auditValidationRollback: true,
      auditMetadataStrict: true,
      concurrentCreateClosed: true,
      initialPriceIdempotency: true,
      initialPriceTargetCopy: true,
      initialPriceConcurrent: true,
      appendPriceAuditAtomic: true,
      noOpRevision: noOp.routingRevision,
      requestOverridesRevision: overridden.routingRevision,
      expandedRevision: expanded.routingRevision,
      contractedRevision: contracted.routingRevision,
      tombstoneRetained: true,
      removeBlockers: ["enabled", "inbound_edge", "enabled_plan"],
      irreversibleRemove: true,
      concurrentRemoveClosed: true,
      concurrentCycleClosed: true,
      routingDepthVerification,
      routingSqlShapes,
      providerManagement: providerVerification,
    })}\n`);
  } finally {
    await owner?.close().catch(() => undefined);
    await runtime.cleanup();
  }
}

async function verifyAuditValidationRollback(
  owner: PostgresClientOwner,
  commands: ModelAccessCommandService,
): Promise<void> {
  const beforeAccessPoints = await owner.prisma.accessPoint.count();
  const beforeAudits = await owner.prisma.audit_logs.count();
  await expectFailure(() => commands.createAccessPoint(
    accessPointInput("AP invalid audit rollback", "edge_invalid_audit_rollback"),
    { ...audit, requestId: "invalid request id" },
  ));
  assert(await owner.prisma.accessPoint.count() === beforeAccessPoints, "invalid_audit_rolls_back_access_point");
  assert(await owner.prisma.audit_logs.count() === beforeAudits, "invalid_audit_persists_no_event");
}

async function verifyModelAccessAuditRows(owner: PostgresClientOwner): Promise<void> {
  const actions = [
    "access_point.create", "access_point.update", "access_point.remove",
    "provider.create", "provider.update", "provider.delete",
    "provider_model.upsert", "provider_model.sync",
  ];
  const rows = await owner.prisma.audit_logs.findMany({ where: { action: { in: actions } } });
  assert(rows.length > 0, "model_access_audit_rows_present");
  assert(!rows.some((row) => row.action === "access_point.create" && row.result !== "success"), "access_point_create_has_no_rejection_audits");
  for (const action of actions) {
    assert(rows.some((row) => row.action === action), `model_access_audit_action_present:${action}`);
  }
  for (const row of rows) {
    assert(row.result === "success" || row.result === "failure" || row.result === "denied", `audit_result_explicit:${row.action}`);
    const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
    const keys = Object.keys(metadata).sort().join(",");
    const allowed = MODEL_ACCESS_AUDIT_METADATA_KEYS[row.action] ?? [];
    assert(allowed.includes(keys), `audit_metadata_keys:${row.action}:${keys}`);
    const serialized = JSON.stringify(metadata);
    assert(!serialized.includes("Provider management verifier"), `audit_provider_name_redacted:${row.action}`);
    assert(!serialized.includes("model-new") && !serialized.includes("Owner Model"), `audit_provider_model_name_redacted:${row.action}`);
    assert(!serialized.includes("https://") && !serialized.includes("api-key:") && !serialized.includes("cliproxyapi:"), `audit_resolver_value_redacted:${row.action}`);
  }
}

async function verifyRoutingDepthAndBatchReads(owner: PostgresClientOwner, observeSql: ObserveSqlShape): Promise<{
  readonly acceptedHopCases: readonly number[];
  readonly routingQueryRawRoundTrips: number;
  readonly rejectedHopCase: number;
  readonly rejectedRoutingQueryRawRoundTrips: number;
}> {
  const acceptedHopCases = [1, 12, 40, 200] as const;
  for (const hopCount of acceptedHopCases) {
    const entryAccessPointId = await seedLinearRoutingChain(owner, hopCount);
    const queryCount = { value: 0 };
    const routingQueries = new ModelAccessRoutingQueryService(countingRoutingOwner(owner, queryCount));
    const report = await observeSql(
      `diagnostic.${hopCount}`,
      () => routingQueries.inspectAccessPointRouting(entryAccessPointId, createModelAccessRoutingQueryBudget()),
    );
    assert(report.candidates[0]?.accessPointChainIds.length === hopCount + 1, `routing_depth_accepted:${hopCount}`);
    assert(queryCount.value === 2, `routing_depth_fixed_query_round_trips:${hopCount}:${queryCount.value}`);

    const gatewayQueryCount = { value: 0 };
    const gatewayRoutingQueries = new ModelAccessRoutingQueryService(countingRoutingOwner(owner, gatewayQueryCount));
    const gatewaySnapshot = await observeSql(
      `gateway.${hopCount}`,
      () => gatewayRoutingQueries.evaluateGatewayRouting({
        entryAccessPointId,
        requestedModel: "model-test",
      }),
    );
    assert(gatewaySnapshot.candidates[0]?.accessPointChainIds.length === hopCount + 1, `gateway_routing_depth_accepted:${hopCount}`);
    assert(gatewayQueryCount.value === 2, `gateway_routing_depth_fixed_query_round_trips:${hopCount}:${gatewayQueryCount.value}`);
  }

  const rejectedHopCount = 201;
  const rejectedEntryAccessPointId = await seedLinearRoutingChain(owner, rejectedHopCount);
  const rejectedQueryCount = { value: 0 };
  const rejectedRoutingQueries = new ModelAccessRoutingQueryService(countingRoutingOwner(owner, rejectedQueryCount));
  await expectRelay("access_point_depth_exceeded", () => observeSql(
    `diagnostic.${rejectedHopCount}`,
    () => rejectedRoutingQueries.inspectAccessPointRouting(rejectedEntryAccessPointId, createModelAccessRoutingQueryBudget()),
  ));
  assert(rejectedQueryCount.value <= 2, `routing_depth_bounded_query_round_trips:${rejectedHopCount}:${rejectedQueryCount.value}`);

  const rejectedGatewayQueryCount = { value: 0 };
  const rejectedGatewayRoutingQueries = new ModelAccessRoutingQueryService(countingRoutingOwner(owner, rejectedGatewayQueryCount));
  await expectRelay("access_point_depth_exceeded", () => observeSql(
    `gateway.${rejectedHopCount}`,
    () => rejectedGatewayRoutingQueries.evaluateGatewayRouting({
      entryAccessPointId: rejectedEntryAccessPointId,
      requestedModel: "model-test",
    }),
  ));
  assert(rejectedGatewayQueryCount.value <= 2, `gateway_routing_depth_bounded_query_round_trips:${rejectedHopCount}:${rejectedGatewayQueryCount.value}`);

  return {
    acceptedHopCases,
    routingQueryRawRoundTrips: 2,
    rejectedHopCase: rejectedHopCount,
    rejectedRoutingQueryRawRoundTrips: rejectedQueryCount.value,
  };
}

async function seedLinearRoutingChain(owner: PostgresClientOwner, hopCount: number): Promise<string> {
  const accessPointCount = hopCount + 1;
  const accessPoints = Array.from({ length: accessPointCount }, (_, index) => {
    const id = `verify_depth_${hopCount}_ap_${index}`;
    const final = index === accessPointCount - 1;
    return {
      id,
      ownerId: "owner",
      scopeRef: "global:",
      name: `Routing depth verifier ${hopCount}:${index}`,
      description: null,
      apiFamily: "openai-responses",
      exposedModel: "model-test",
      targetModel: "model-test",
      routingRuleId: "direct",
      routingRuleBehaviorVersion: 1,
      routingRuleConfigJson: "{}",
      requestOverridesJson: "{}",
      routingRevision: 1,
      legacyTargetType: final ? "provider-model" : "access-point",
      legacyTargetId: final ? null : `verify_depth_${hopCount}_ap_${index + 1}`,
      legacyTargetProviderId: final ? "provider_test" : null,
      legacyTargetProviderModelName: final ? "model-test" : null,
      priority: 100,
      weight: 1,
      fallbackOrder: 100,
      status: "enabled",
      removedAt: null,
      createIdempotencyKeyHash: null,
      createRequestHash: null,
      createdAt: now,
      updatedAt: now,
    };
  });
  const targets = Array.from({ length: accessPointCount }, (_, index) => {
    const final = index === accessPointCount - 1;
    return {
      id: `verify_depth_${hopCount}_edge_${index}`,
      accessPointId: `verify_depth_${hopCount}_ap_${index}`,
      targetType: final ? "provider-model" : "access-point",
      targetAccessPointId: final ? null : `verify_depth_${hopCount}_ap_${index + 1}`,
      targetProviderId: final ? "provider_test" : null,
      targetProviderModelName: final ? "model-test" : null,
      targetProviderModelId: final ? "provider_model_test" : null,
      position: 0,
      status: "enabled",
      removedAt: null,
      createdAt: now,
      updatedAt: now,
    };
  });
  await owner.prisma.accessPoint.createMany({ data: accessPoints });
  await owner.prisma.accessPointTarget.createMany({ data: targets });
  return accessPoints[0]!.id;
}

function countingRoutingOwner(owner: PostgresClientOwner, queryCount: { value: number }): PrismaTransactionOwner {
  return {
    withPrismaTransaction(callback, maxAttempts, options) {
      return owner.withPrismaTransaction((transaction) => callback(new Proxy(transaction, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          if (property === "$queryRaw" && typeof value === "function") {
            return (...args: unknown[]) => {
              queryCount.value += 1;
              return Reflect.apply(value, target, args);
            };
          }
          if (typeof value === "function") return value.bind(target);
          return value;
        },
      })), maxAttempts, options);
    },
  };
}

function assertFixedSqlShapes(entries: readonly (readonly [string, SqlShapeInventory])[], assertion: string): void {
  const baseline = entries[0]?.[1];
  assert(baseline !== undefined && entries.every(([, inventory]) => inventory.statementCount === baseline.statementCount
    && inventory.shapeDigests.join("\u0000") === baseline.shapeDigests.join("\u0000")), assertion);
}

const MODEL_ACCESS_AUDIT_METADATA_KEYS: Readonly<Record<string, readonly string[]>> = {
  "access_point.create": ["accessPointId,scopeRef"],
  "access_point.update": ["accessPointId,descriptionChanged,newRoutingRevision,oldRoutingRevision,routingChanged,targetEdgeCount"],
  "access_point.remove": ["accessPointId,routingRevision"],
  "provider.create": ["baseUrlResolverName,credentialResolverName,kind,modelsResolverName,ownerId,providerId,scopeRef,status"],
  "provider.update": [
    "baseUrlResolverName,credentialResolverName,kind,materialChanged,modelsResolverName,ownerId,providerId,scopeRef,status",
    "providerId,status,statusChanged",
    "providerId,reason,status,statusChanged",
  ],
  "provider.delete": ["deleted,providerId"],
  "provider_model.upsert": ["changed,providerId,providerModelId,status"],
  "provider_model.sync": ["created,observed,providerId"],
};

function accessPointInput(name: string, edgeId: string): CreateAccessPointCommand {
  return {
    idempotencyKey: `create:${edgeId}`, ownerId: "owner", scopeRef: "global:", name, apiFamily: "openai-responses",
    exposedModel: "model-test", targetModel: "model-test", status: "disabled",
    routing: { selector: { id: "direct", behaviorVersion: 1, config: {} }, targets: [providerTarget(edgeId, 0)] },
  };
}

function changeInput(name: string, edgeId: string, revision: number, status = "disabled"): ChangeAccessPointCommand {
  return {
    name, apiFamily: "openai-responses", exposedModel: "model-test", targetModel: "model-test", status,
    routing: {
      selector: { id: "direct", behaviorVersion: 1, config: {} },
      expectedRoutingRevision: revision,
      targets: [providerTarget(edgeId, 0)],
    },
  };
}

function providerTarget(id: string, position: number) {
  return { id, type: "provider-model" as const, targetProviderId: "provider_test", targetProviderModelName: "model-test", position, status: "enabled" as const };
}

function accessPointTargetChange(name: string, targetAccessPointId: string): ChangeAccessPointCommand {
  return {
    name, apiFamily: "openai-responses", exposedModel: "model-test", targetModel: "model-test", status: "disabled",
    routing: {
      selector: { id: "direct", behaviorVersion: 1, config: {} }, expectedRoutingRevision: 1,
      targets: [{ type: "access-point", targetAccessPointId, position: 0, status: "enabled" }],
    },
  };
}

async function verifyProviderManagement(
  owner: PostgresClientOwner,
  commands: ModelAccessCommandService,
  queries: ModelAccessManagementQueryService,
) {
  const provider = await commands.providers.createProvider({
    id: "prv_aaaaaaaaaaaaaaaaaaaaaaaa",
    ownerId: "owner",
    scopeRef: "global:",
    name: "Provider management verifier",
    kind: "openai-compatible",
    status: "disabled",
    baseUrlResolver: "literal:",
    credentialResolver: "api-key:",
    modelsResolver: "cliproxyapi:catalog",
    configJson: "{}",
    cpaInstanceId: "cpa_default",
    authMethod: "api-key",
  }, audit);
  assert(provider.status === "disabled", "provider_create_disabled");
  assert((await owner.prisma.provider_bindings.findUniqueOrThrow({ where: { provider_id: provider.id } })).sync_status === "pending", "provider_binding_atomic_create");
  assert(await owner.prisma.audit_logs.count({ where: { action: "provider.create", resource_id: provider.id } }) === 1, "provider_create_atomic_audit");

  const observed = await commands.providers.applyProviderCatalogObservation(provider.id, ["model-new", "model-new"], audit);
  assert(observed.observed === 1 && observed.created === 1, "provider_catalog_deduplicated");
  const discovered = await queries.getProviderModel(provider.id, "model-new");
  assert(discovered?.status === "disabled", "provider_catalog_new_model_disabled");
  await owner.prisma.provider_bindings.update({ where: { provider_id: provider.id }, data: { sync_status: "ready", updated_at: now } });
  await expectRelay("cliproxy_provider_not_ready", () => commands.providers.changeProviderStatus(provider.id, "enabled", audit));
  const enabledModel = await commands.providers.changeProviderModel(provider.id, "model-new", { displayName: "Owner Model", status: "enabled" }, audit);
  assert(enabledModel.status === "enabled" && enabledModel.displayName === "Owner Model", "provider_model_explicit_enable");
  assert((await commands.providers.changeProviderStatus(provider.id, "enabled", audit)).status === "enabled", "provider_enable_requires_ready_model");
  await commands.providers.applyProviderCatalogObservation(provider.id, ["model-new", "model-second"], audit);
  const preserved = await queries.getProviderModel(provider.id, "model-new");
  assert(preserved?.status === "enabled" && preserved.displayName === "Owner Model", "provider_catalog_preserves_owner_state");
  const firstModelPage = await queries.pageProviderModels(1, 1, { providerIds: [provider.id] });
  const secondModelPage = await queries.pageProviderModels(2, 1, { providerIds: [provider.id] });
  assert(firstModelPage.total === 2 && firstModelPage.totalPages === 2 && firstModelPage.items[0]?.providerModelName === "model-new", "provider_model_first_page_bounded");
  assert(secondModelPage.items.length === 1 && secondModelPage.items[0]?.providerModelName === "model-second", "provider_model_second_page_stable");
  assert((await queries.pageProviderModels(1, 20, { providerIds: [] })).items.length === 0, "provider_model_empty_scope_bounded");

  await expectFailure(() => owner.prisma.provider_models.create({ data: {
    id: "provider_model_duplicate_verifier",
    provider_id: provider.id,
    provider_model_name: "model-new",
    display_name: "Duplicate",
    status: "disabled",
    created_at: now,
    updated_at: now,
  } }));
  assert((await queries.getProviderModel(provider.id, "model-new"))?.id === enabledModel.id, "provider_model_physical_identity_unique");

  let providerSnapshot = await queries.getProvider(provider.id);
  let bindingSnapshot = await owner.prisma.provider_bindings.findUniqueOrThrow({ where: { provider_id: provider.id } });
  assert(providerSnapshot !== undefined, "provider_snapshot_exists");
  const staleBegin = {
    expectedRevision: bindingSnapshot.revision,
    expectedAuthMethod: bindingSnapshot.auth_method,
    expectedSyncStatus: bindingSnapshot.sync_status,
    expectedErrorCode: bindingSnapshot.error_code,
    expectedBindingUpdatedAt: bindingSnapshot.updated_at,
    expectedProviderUpdatedAt: providerSnapshot.updatedAt,
  };
  await commands.providers.changeProvider(provider.id, {
    id: provider.id,
    ownerId: provider.ownerId,
    scopeRef: provider.scopeRef,
    name: provider.name,
    kind: provider.kind,
    status: "enabled",
    baseUrlResolver: provider.baseUrlResolver,
    credentialResolver: provider.credentialResolver,
    modelsResolver: provider.modelsResolver,
    configJson: '{"baseUrl":"https://example.invalid"}',
    cpaInstanceId: provider.cpaInstanceId,
    authMethod: "api-key",
  }, audit);
  await expectRelay("provider_binding_revision_conflict", () => commands.providers.beginProviderBindingTransition(provider.id, staleBegin));

  providerSnapshot = await queries.getProvider(provider.id);
  bindingSnapshot = await owner.prisma.provider_bindings.findUniqueOrThrow({ where: { provider_id: provider.id } });
  assert(providerSnapshot !== undefined, "provider_snapshot_after_change_exists");
  const activeTransition = await commands.providers.beginProviderBindingTransition(provider.id, {
    expectedRevision: bindingSnapshot.revision,
    expectedAuthMethod: bindingSnapshot.auth_method,
    expectedSyncStatus: bindingSnapshot.sync_status,
    expectedErrorCode: bindingSnapshot.error_code,
    expectedBindingUpdatedAt: bindingSnapshot.updated_at,
    expectedProviderUpdatedAt: providerSnapshot.updatedAt,
  });
  const reservedProvider = await queries.getProvider(provider.id);
  const reservedBinding = await owner.prisma.provider_bindings.findUniqueOrThrow({ where: { provider_id: provider.id } });
  assert(reservedProvider !== undefined, "provider_reserved_snapshot_exists");
  await expectRelay("provider_binding_transition_in_progress", () => commands.providers.beginProviderBindingTransition(provider.id, {
    expectedRevision: reservedBinding.revision,
    expectedAuthMethod: reservedBinding.auth_method,
    expectedSyncStatus: reservedBinding.sync_status,
    expectedErrorCode: reservedBinding.error_code,
    expectedBindingUpdatedAt: reservedBinding.updated_at,
    expectedProviderUpdatedAt: reservedProvider.updatedAt,
  }));
  await expectRelay("provider_binding_transition_in_progress", () => commands.providers.changeProvider(provider.id, {
    id: reservedProvider.id,
    ownerId: reservedProvider.ownerId,
    scopeRef: reservedProvider.scopeRef,
    name: `${reservedProvider.name} concurrent`,
    kind: reservedProvider.kind,
    status: "disabled",
    baseUrlResolver: reservedProvider.baseUrlResolver,
    credentialResolver: reservedProvider.credentialResolver,
    modelsResolver: reservedProvider.modelsResolver,
    configJson: reservedProvider.configJson,
    cpaInstanceId: reservedProvider.cpaInstanceId,
    authMethod: "api-key",
  }, audit));
  await owner.prisma.provider_bindings.update({ where: { provider_id: provider.id }, data: {
    revision: activeTransition.revision + 1,
    sync_status: "pending",
    error_code: null,
    updated_at: now,
  } });
  await expectRelay("provider_binding_revision_conflict", () => commands.providers.completeProviderBindingTransition(provider.id, activeTransition.revision, {
    credentialRefsJson: '["stale-ref"]',
    credentialPreview: "stale-preview",
    syncStatus: "ready",
  }));
  const resetBinding = await owner.prisma.provider_bindings.findUniqueOrThrow({ where: { provider_id: provider.id } });
  assert(resetBinding.revision > activeTransition.revision && resetBinding.credential_refs_json === "[]" && resetBinding.credential_preview === null, "provider_binding_stale_completion_fenced");
  await owner.prisma.provider_bindings.update({ where: { provider_id: provider.id }, data: { sync_status: "ready", error_code: null, updated_at: now } });
  await commands.providers.changeProviderStatus(provider.id, "enabled", audit);
  providerSnapshot = await queries.getProvider(provider.id);
  bindingSnapshot = await owner.prisma.provider_bindings.findUniqueOrThrow({ where: { provider_id: provider.id } });
  assert(providerSnapshot !== undefined, "provider_clear_snapshot_exists");
  const clearTransition = await commands.providers.beginProviderBindingTransition(provider.id, {
    expectedRevision: bindingSnapshot.revision,
    expectedAuthMethod: bindingSnapshot.auth_method,
    expectedSyncStatus: bindingSnapshot.sync_status,
    expectedErrorCode: bindingSnapshot.error_code,
    expectedBindingUpdatedAt: bindingSnapshot.updated_at,
    expectedProviderUpdatedAt: providerSnapshot.updatedAt,
    disableProvider: true,
    audit,
  });
  assert((await queries.getProvider(provider.id))?.status === "disabled", "provider_clear_disables_atomically");
  await expectRelay("cliproxy_provider_not_ready", () => commands.providers.changeProviderStatus(provider.id, "enabled", audit));
  await commands.providers.completeProviderBindingTransition(provider.id, clearTransition.revision, {
    credentialRefsJson: "[]",
    credentialPreview: null,
    syncStatus: "cleared",
    errorCode: null,
  });
  const auditFailureCommands = new ModelAccessCommandService(owner, {
    async append() {
      throw new Error("audit_persistence_unavailable");
    },
  });
  await expectFailure(() => auditFailureCommands.providers.removeProvider(provider.id, audit));
  assert(await queries.getProvider(provider.id) !== undefined, "provider_remove_audit_failure_rolls_back");
  assert(await owner.prisma.provider_bindings.findUnique({ where: { provider_id: provider.id } }) !== null, "provider_binding_audit_failure_rolls_back");
  const removed = await commands.providers.removeProvider(provider.id, audit);
  assert(removed.deleted && await queries.getProvider(provider.id) === undefined, "provider_remove");
  assert(await owner.prisma.audit_logs.count({ where: { action: "provider.delete", resource_id: provider.id } }) === 1, "provider_remove_atomic_audit");

  return {
    catalogNewDisabled: true,
    explicitModelEnable: true,
    catalogPreservesDesiredState: true,
    providerModelPageBounded: true,
    physicalIdentityUnique: true,
    providerEnableGate: true,
    bindingBeginSnapshotFenced: true,
    bindingOverlapRejected: true,
    bindingCompletionFenced: true,
    clearDisableAtomic: true,
    atomicDeleteAudit: true,
  };
}

async function seedOwner(owner: PostgresClientOwner): Promise<void> {
  await owner.prisma.user_controls.createMany({ data: [
    {
      id: "owner",
      team_id: null,
      email: "model-access-verifier@example.invalid",
      password_hash: "not-a-real-password-hash",
      status: "enabled",
      user_can_create_access_point: 1,
      created_at: now,
      updated_at: now,
    },
    {
      id: "other",
      team_id: null,
      email: "model-access-verifier-other@example.invalid",
      password_hash: "not-a-real-password-hash",
      status: "enabled",
      user_can_create_access_point: 1,
      created_at: now,
      updated_at: now,
    },
  ] });
}

async function seedProvider(owner: PostgresClientOwner): Promise<void> {
  await owner.prisma.providers.create({ data: {
    id: "provider_test", owner_id: "owner", scope_ref: "global:", name: "Verifier Provider", kind: "openai-compatible",
    status: "disabled", base_url_resolver: "fixed:https://example.invalid", credential_resolver: "api-key:verifier",
    models_resolver: "static:model-test", config_json: "{}", cpa_instance_id: "cpa_default", created_at: now, updated_at: now,
  } });
  await owner.prisma.provider_models.create({ data: {
    id: "provider_model_test", provider_id: "provider_test", provider_model_name: "model-test",
    display_name: "Model Test", status: "disabled", created_at: now, updated_at: now,
  } });
  await owner.prisma.provider_model_costs.create({ data: {
    id: "provider_cost_test", provider_id: "provider_test", provider_model_name: "model-test",
    input_per_1m: 2, cached_input_per_1m: 1, cache_write_per_1m: 2, output_per_1m: 8,
    input_price_units_per_1m: 2_000_000n, cached_input_price_units_per_1m: 1_000_000n,
    cache_write_price_units_per_1m: 2_000_000n, output_price_units_per_1m: 8_000_000n,
    source: "fixed-verifier", status: "enabled", created_at: now, updated_at: now,
  } });
}

async function expectRelay(code: string, callback: () => Promise<unknown>, status?: number): Promise<void> {
  try { await callback(); } catch (error) {
    if (error instanceof RelayError && error.code === code && (status === undefined || error.status === status)) return;
    throw error;
  }
  throw new Error(`expected_relay_error:${code}`);
}

async function expectFailure(callback: () => Promise<unknown>): Promise<void> {
  try { await callback(); } catch { return; }
  throw new Error("expected_database_failure");
}

function assert(condition: boolean, name: string): asserts condition {
  if (!condition) throw new Error(`model_access_assertion_failed:${name}`);
}

function run(
  command: string,
  args: string[],
  input?: string,
  env: NodeJS.ProcessEnv = process.env,
  runtime?: PostgresVerificationRuntime,
): string {
  const result = spawnSync(command, args, { cwd: packageRoot, env, input, encoding: "utf8", maxBuffer: maximumCommandOutputBytes });
  if (result.status !== 0) {
    const rawDetail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    const detail = runtime?.redact(rawDetail) ?? rawDetail;
    throw new Error(`${command}_failed:${result.status ?? "signal"}${detail ? `\n${detail}` : ""}`);
  }
  return result.stdout;
}

await main();
