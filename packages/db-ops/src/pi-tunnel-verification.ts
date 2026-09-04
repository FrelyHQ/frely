import { generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveNodeIdentity, PiTunnelDeviceService, PostgresPiTunnelDeviceRepository } from "@frely/pi-tunnel";
import { PostgresClientOwner } from "@frely/postgres/server";
import { PostgresVerificationRuntime } from "./postgres-verification-runtime.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const postgresPackageRoot = join(packageRoot, "..", "postgres");
const prismaConfigPath = join(postgresPackageRoot, "prisma.config.ts");
const prismaBinPath = join(postgresPackageRoot, "node_modules", ".bin", "prisma");
const piTunnelCliPath = join(packageRoot, "..", "..", "scripts", "pi-tunnel-device.mjs");
const image = process.env.FRIDAY_RELAY_PI_TUNNEL_POSTGRES_IMAGE ?? "postgres:16-alpine";
const database = "friday_pi_tunnel";

async function main(): Promise<void> {
  const runtime = await PostgresVerificationRuntime.start({
    verifier: "pi_tunnel",
    databases: [database],
    docker: {
      image,
      user: "friday_pi_tunnel",
      password: "friday_pi_tunnel_local_only",
      containerPrefix: "friday-relay-pi-tunnel",
    },
    allowSuppliedDisposableDatabase: true,
  });
  let owner: PostgresClientOwner | undefined;
  try {
    const connectionString = runtime.connectionString(database);
    run("bun", [prismaBinPath, "migrate", "deploy", "--config", prismaConfigPath], {
      ...process.env,
      FRIDAY_RELAY_PG_CONNECTION_STRING: connectionString,
    }, runtime);
    const cliEnvironment = { ...process.env, FRIDAY_RELAY_PG_CONNECTION_STRING: connectionString };
    const cliCreated = parseJsonObject(runCapture("bun", [piTunnelCliPath, "activation-create", "--ttl-seconds", "600", "--attempts", "3"], cliEnvironment, runtime));
    assert(typeof cliCreated.id === "string" && typeof cliCreated.activationCode === "string", "cli_activation_create_output");
    const cliInspectedRaw = runCapture("bun", [piTunnelCliPath, "device-inspect", "--id", cliCreated.id], cliEnvironment, runtime);
    const cliInspected = parseJsonObject(cliInspectedRaw);
    assert(cliInspected.lifecycle === "pending" && !cliInspectedRaw.includes(cliCreated.activationCode), "cli_inspect_redacts_activation_code");
    const cliRevoked = parseJsonObject(runCapture("bun", [piTunnelCliPath, "device-revoke", "--id", cliCreated.id, "--reason", "operator_revoked"], cliEnvironment, runtime));
    assert(cliRevoked.lifecycle === "revoked", "cli_revoke_output");

    owner = new PostgresClientOwner({ connectionString, max: 8, applicationName: "friday-relay-pi-tunnel-verification" });
    const repository = new PostgresPiTunnelDeviceRepository(owner);
    const service = new PiTunnelDeviceService(repository);
    const now = new Date("2026-08-25T00:00:00.000Z");

    const wrong = await service.createActivationSlot({ ttlSeconds: 600, attempts: 3, now });
    await expectRejected(() => service.activate({
      activationId: wrong.device.id,
      activationCode: "A".repeat(43),
      identity: identity(),
      now: new Date("2026-08-25T00:00:01.000Z"),
    }));
    assert((await service.inspect(wrong.device.id))?.activationAttemptsRemaining === 2, "wrong_code_attempt_persisted");

    const expired = await service.createActivationSlot({ ttlSeconds: 60, attempts: 2, now });
    await expectRejected(() => service.activate({
      activationId: expired.device.id,
      activationCode: expired.activationCode,
      identity: identity(),
      now: new Date("2026-08-25T00:01:00.000Z"),
    }));
    assert((await service.inspect(expired.device.id))?.lifecycle === "pending", "expired_slot_not_consumed");

    const revoked = await service.createActivationSlot({ ttlSeconds: 600, attempts: 2, now });
    await service.revoke({ id: revoked.device.id, reason: "operator_revoked", now: new Date("2026-08-25T00:00:02.000Z") });
    await expectRejected(() => service.activate({
      activationId: revoked.device.id,
      activationCode: revoked.activationCode,
      identity: identity(),
      now: new Date("2026-08-25T00:00:03.000Z"),
    }));

    const identityRaceA = await service.createActivationSlot({ ttlSeconds: 600, attempts: 3, now });
    const identityRaceB = await service.createActivationSlot({ ttlSeconds: 600, attempts: 3, now });
    const sharedIdentity = identity();
    const identityRaceResults = await Promise.allSettled([
      service.activate({ activationId: identityRaceA.device.id, activationCode: identityRaceA.activationCode, identity: sharedIdentity, now: new Date("2026-08-25T00:00:04.000Z") }),
      service.activate({ activationId: identityRaceB.device.id, activationCode: identityRaceB.activationCode, identity: sharedIdentity, now: new Date("2026-08-25T00:00:04.000Z") }),
    ]);
    assert(identityRaceResults.filter((result) => result.status === "fulfilled").length === 1, "concurrent_identity_binding_single_success");
    assert(identityRaceResults.filter((result) => result.status === "rejected").length === 1, "concurrent_identity_binding_single_rejection");
    assert((await owner.prisma.pi_tunnel_devices.count({ where: { node_id: sharedIdentity.nodeId } })) === 1, "concurrent_identity_binding_transaction_usable");

    const raced = await service.createActivationSlot({ ttlSeconds: 600, attempts: 3, now });
    const racedIdentity = identity();
    const results = await Promise.allSettled([
      service.activate({ activationId: raced.device.id, activationCode: raced.activationCode, identity: racedIdentity, now: new Date("2026-08-25T00:00:04.000Z") }),
      service.activate({ activationId: raced.device.id, activationCode: raced.activationCode, identity: racedIdentity, now: new Date("2026-08-25T00:00:04.000Z") }),
    ]);
    assert(results.filter((result) => result.status === "fulfilled").length === 1, "concurrent_activation_single_success");
    assert(results.filter((result) => result.status === "rejected").length === 1, "concurrent_activation_single_rejection");
    assert((await owner.prisma.pi_tunnel_devices.count({ where: { node_id: racedIdentity.nodeId, lifecycle: "active" } })) === 1, "concurrent_activation_single_active_row");

    await service.revoke({ id: raced.device.id, reason: "security_response", now: new Date("2026-08-25T00:00:05.000Z") });
    assert(!(await repository.findActiveNodeIds([racedIdentity.nodeId])).has(racedIdentity.nodeId), "revocation_rejects_node_readback");
    await expectFailure(() => owner!.prisma.pi_tunnel_devices.update({ where: { id: raced.device.id }, data: { lifecycle: "active", revoked_at: null, revocation_reason: null } }));

    const guardedPending = await service.createActivationSlot({ ttlSeconds: 600, attempts: 2, now });
    const forgedIdentity = identity();
    await expectFailure(() => owner!.prisma.pi_tunnel_devices.update({
      where: { id: guardedPending.device.id },
      data: {
        lifecycle: "revoked",
        node_id: forgedIdentity.nodeId,
        node_public_key_spki: forgedIdentity.publicKeySpki,
        node_key_thumbprint: forgedIdentity.keyThumbprint,
        activated_at: "2026-08-25T00:00:06.000Z",
        revoked_at: "2026-08-25T00:00:06.000Z",
        revocation_reason: "security_response",
      },
    }));
    const guardedPendingReadback = await service.inspect(guardedPending.device.id);
    assert(guardedPendingReadback?.lifecycle === "pending" && guardedPendingReadback.nodeId === null, "pending_revocation_identity_injection_rejected");

    await expectFailure(() => owner!.prisma.pi_tunnel_devices.create({
      data: {
        id: `pi_device_${"f".repeat(32)}`,
        lifecycle: "active",
        activation_code_hash: `sha256:${"A".repeat(43)}`,
        activation_expires_at: "2026-08-25T01:00:00.000Z",
        activation_attempts_remaining: 1,
        node_id: null,
        node_public_key_spki: null,
        node_key_thumbprint: null,
        activated_at: null,
        revoked_at: null,
        revocation_reason: null,
        created_at: "2026-08-25T00:00:00.000Z",
      },
    }));

    const columns = await owner.prisma.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'pi_tunnel_devices'
      ORDER BY ordinal_position
    `;
    const names = columns.map((column) => column.column_name);
    assert(!names.some((name) => /payload|frame|client|prompt|message|content/iu.test(name)), "payload_columns_absent");

    process.stdout.write(`${JSON.stringify({
      verifier: "pi_tunnel",
      runtimeMode: runtime.mode,
      migration: "deployed",
      checks: [
        "cli_activation_create_output",
        "cli_inspect_redacts_activation_code",
        "cli_revoke_output",
        "wrong_code_attempt_persisted",
        "expired_slot_not_consumed",
        "pending_revocation_rejected",
        "concurrent_identity_binding_single_success",
        "concurrent_identity_binding_transaction_usable",
        "concurrent_activation_single_success",
        "concurrent_activation_single_active_row",
        "revocation_rejects_node_readback",
        "revoked_transition_terminal",
        "pending_revocation_identity_injection_rejected",
        "database_shape_check_enforced",
        "payload_columns_absent",
      ],
    })}\n`);
  } finally {
    await owner?.close().catch(() => undefined);
    await runtime.cleanup();
  }
}

function identity() {
  const pair = generateKeyPairSync("ed25519");
  return deriveNodeIdentity(pair.publicKey.export({ format: "der", type: "spki" }).toString("base64url"));
}

async function expectRejected(work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (error) {
    if (error instanceof Error && error.message === "activation_rejected") return;
    throw error;
  }
  throw new Error("expected_activation_rejection");
}

async function expectFailure(work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch {
    return;
  }
  throw new Error("expected_database_failure");
}

function run(command: string, args: string[], environment: NodeJS.ProcessEnv, runtime: PostgresVerificationRuntime): void {
  runCapture(command, args, environment, runtime);
}

function runCapture(command: string, args: string[], environment: NodeJS.ProcessEnv, runtime: PostgresVerificationRuntime): string {
  const result = spawnSync(command, args, { encoding: "utf8", env: environment, maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`pi_tunnel_verification_command_failed:${runtime.redact(`${result.stdout}\n${result.stderr}`)}`);
  }
  return result.stdout.trim();
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("pi_tunnel_verification_invalid_cli_json");
  return parsed as Record<string, unknown>;
}

function assert(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(`pi_tunnel_verification_failed:${code}`);
}

await main();
