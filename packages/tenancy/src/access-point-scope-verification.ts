import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthorityQueries } from "@frely/authority/application-internal";
import { parseScopeRef, type ScopeRef } from "@frely/core";
import { createTenancyAccessPointVerificationQueries, type TenancyAccessPointVerificationQueries } from "@frely/application/internal/verification";
import { PostgresClientOwner } from "@frely/postgres/server";
import type { AsyncControlPlaneTenancyService } from "@frely/application/server";
import { createIdentityTenancyApplicationService } from "@frely/application/application-internal";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const postgresPackageRoot = join(packageRoot, "..", "postgres");
const prismaConfigPath = join(postgresPackageRoot, "prisma.config.ts");
const prismaBinPath = join(postgresPackageRoot, "node_modules", ".bin", "prisma");
const postgresImage = process.env.FRIDAY_RELAY_TENANCY_POSTGRES_IMAGE ?? "postgres:16-alpine";
const postgresUser = "friday_tenancy";
const postgresPassword = "friday_tenancy_local_only";
const database = "friday_tenancy";
const containerName = `friday-relay-tenancy-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const maximumCommandOutputBytes = 32 * 1024 * 1024;
const evaluatedAt = new Date().toISOString();

type AccessPointScopeDecision =
  | { kind: "allowed"; scopeRef: ScopeRef }
  | {
      kind: "denied";
      scopeRef: ScopeRef;
      reason:
        | "access_point_scope_not_supported"
        | "access_point_scope_not_found"
        | "access_point_scope_disabled"
        | "access_point_scope_deleting"
        | "access_point_actor_not_found"
        | "access_point_actor_disabled"
        | "access_point_scope_permission_required";
    };

async function main(): Promise<void> {
  run("docker", [
    "run", "--detach", "--rm", "--name", containerName,
    "-e", `POSTGRES_USER=${postgresUser}`,
    "-e", `POSTGRES_PASSWORD=${postgresPassword}`,
    "-e", `POSTGRES_DB=${database}`,
    "-p", "127.0.0.1::5432",
    postgresImage,
  ]);
  let owner: PostgresClientOwner | undefined;
  try {
    await waitForPostgres();
    const portOutput = run("docker", ["port", containerName, "5432/tcp"]).trim();
    const port = portOutput.slice(portOutput.lastIndexOf(":") + 1);
    if (!/^\d+$/u.test(port)) throw new Error("tenancy_postgres_port_invalid");
    const connectionString = `postgresql://${postgresUser}:${postgresPassword}@127.0.0.1:${port}/${database}`;
    run("bun", [prismaBinPath, "migrate", "deploy", "--config", prismaConfigPath], undefined, {
      ...process.env,
      FRIDAY_RELAY_PG_CONNECTION_STRING: connectionString,
    });
    owner = new PostgresClientOwner({ connectionString, max: 4 });
    await seed(owner);
    const queries = createTenancyAccessPointVerificationQueries(owner);
    const authority = new AuthorityQueries(owner);
    const tenancy: AsyncControlPlaneTenancyService = createIdentityTenancyApplicationService(owner, undefined as never);

    await expectAllowed(queries, authority, tenancy, "global:", "platform_owner");
    await expectDenied(queries, authority, tenancy, "global:", "member", "access_point_scope_permission_required");
    await expectDenied(queries, authority, tenancy, "key:key_test", "platform_owner", "access_point_scope_not_supported");
    await expectAllowed(queries, authority, tenancy, "user:self", "self");
    await expectDenied(queries, authority, tenancy, "user:self", "member", "access_point_scope_permission_required");
    await owner.prisma.user_controls.update({ where: { id: "self" }, data: { user_can_create_access_point: 0, updated_at: evaluatedAt } });
    await expectDenied(queries, authority, tenancy, "user:self", "self", "access_point_scope_permission_required");
    await expectAllowed(queries, authority, tenancy, "user:self", "platform_owner");
    await expectDenied(queries, authority, tenancy, "user:disabled", "disabled", "access_point_scope_disabled");
    await expectAllowed(queries, authority, tenancy, "team:team_active", "member");
    await expectAllowed(queries, authority, tenancy, "team:team_active", "platform_owner");

    await owner.prisma.teams.update({ where: { id: "team_active" }, data: { team_owner_can_create_access_point: 0, updated_at: evaluatedAt } });
    await expectDenied(queries, authority, tenancy, "team:team_active", "member", "access_point_scope_permission_required");
    await owner.prisma.teams.update({ where: { id: "team_active" }, data: { team_owner_can_create_access_point: 1, updated_at: evaluatedAt } });
    await owner.prisma.team_deletion_lifecycles.create({ data: {
      id: "team_deletion_active",
      team_id: "team_active",
      requested_at: evaluatedAt,
      requested_by_user_id: "team_owner",
      purge_not_before: new Date(Date.parse(evaluatedAt) + 86_400_000).toISOString(),
    } });
    await expectDenied(queries, authority, tenancy, "team:team_active", "member", "access_point_scope_deleting");

    process.stdout.write(`${JSON.stringify({
      globalOwnerAllowed: true,
      globalNonOwnerDenied: true,
      keyScopeDenied: true,
      userSelfDelegationAllowed: true,
      userDelegationGateDenied: true,
      userPlatformOwnerAllowed: true,
      disabledUserDenied: true,
      teamRolePermissionAllowed: true,
      teamPlatformOwnerAllowed: true,
      teamDelegatedGateDenied: true,
      deletingTeamDenied: true,
    })}\n`);
  } finally {
    await owner?.close().catch(() => undefined);
    spawnSync("docker", ["rm", "--force", "--volumes", containerName], {
      encoding: "utf8",
      maxBuffer: maximumCommandOutputBytes,
    });
  }
}

async function expectAllowed(
  queries: TenancyAccessPointVerificationQueries,
  authority: AuthorityQueries,
  tenancy: AsyncControlPlaneTenancyService,
  scopeRef: ScopeRef,
  actorUserId: string,
): Promise<void> {
  const decision = await decideCompatibilityScope(queries, authority, tenancy, scopeRef, actorUserId);
  assert(decision.kind === "allowed", `expected_allowed:${scopeRef}:${actorUserId}`);
}

async function expectDenied(
  queries: TenancyAccessPointVerificationQueries,
  authority: AuthorityQueries,
  tenancy: AsyncControlPlaneTenancyService,
  scopeRef: ScopeRef,
  actorUserId: string,
  reason: Extract<AccessPointScopeDecision, { kind: "denied" }>["reason"],
): Promise<void> {
  const decision = await decideCompatibilityScope(queries, authority, tenancy, scopeRef, actorUserId);
  assert(decision.kind === "denied" && decision.reason === reason, `expected_denied:${scopeRef}:${actorUserId}:${reason}`);
}

// The final compatibility path keeps scope authorization at the tenancy/API
// boundary. It does not consult or enforce an AccessPoint-count allowance.
async function decideCompatibilityScope(
  queries: TenancyAccessPointVerificationQueries,
  authority: AuthorityQueries,
  tenancy: AsyncControlPlaneTenancyService,
  scopeRef: ScopeRef,
  actorUserId: string,
): Promise<AccessPointScopeDecision> {
  const scope = parseScopeRef(scopeRef);
  if (scope.scopeType === "key") return denied(scopeRef, "access_point_scope_not_supported");

  if (scope.scopeType === "global") {
    const actor = await queries.getUser(actorUserId);
    if (!actor) return denied(scopeRef, "access_point_actor_not_found");
    if (actor.status !== "enabled") return denied(scopeRef, "access_point_actor_disabled");
    return (await authority.platformRolesForUser(actorUserId)).includes("owner")
      ? { kind: "allowed", scopeRef }
      : denied(scopeRef, "access_point_scope_permission_required");
  }

  if (scope.scopeType === "user") {
    const target = await queries.getUser(scope.scopeId);
    if (!target) return denied(scopeRef, "access_point_scope_not_found");
    if (target.status !== "enabled") return denied(scopeRef, "access_point_scope_disabled");
    const actor = target.id === actorUserId ? target : await queries.getUser(actorUserId);
    if (!actor) return denied(scopeRef, "access_point_actor_not_found");
    if (actor.status !== "enabled") return denied(scopeRef, "access_point_actor_disabled");
    const platformOwner = (await authority.platformRolesForUser(actorUserId)).includes("owner");
    return platformOwner || (target.id === actorUserId && target.userCanCreateAccessPoint !== 0)
      ? { kind: "allowed", scopeRef }
      : denied(scopeRef, "access_point_scope_permission_required");
  }

  const team = await queries.getTeam(scope.scopeId);
  if (!team) return denied(scopeRef, "access_point_scope_not_found");
  if (team.status !== "enabled") return denied(scopeRef, "access_point_scope_disabled");
  if (await queries.getActiveTeamDeletion(team.id)) return denied(scopeRef, "access_point_scope_deleting");
  const actor = await queries.getUser(actorUserId);
  if (!actor) return denied(scopeRef, "access_point_actor_not_found");
  if (actor.status !== "enabled") return denied(scopeRef, "access_point_actor_disabled");
  if ((await authority.platformRolesForUser(actorUserId)).includes("owner")) return { kind: "allowed", scopeRef };
  if (team.teamOwnerCanCreateAccessPoint === 0) return denied(scopeRef, "access_point_scope_permission_required");
  return await tenancy.hasPermission(actorUserId, {
    resourceType: "team",
    resourceId: team.id,
    action: "team.access_point.create",
  })
    ? { kind: "allowed", scopeRef }
    : denied(scopeRef, "access_point_scope_permission_required");
}

async function seed(owner: PostgresClientOwner): Promise<void> {
  const user = (id: string, status = "enabled", canCreate = 1) => ({
    id,
    team_id: null,
    email: `${id}@tenancy-verifier.example.invalid`,
    password_hash: "not-a-real-password-hash",
    status,
    user_can_create_access_point: canCreate,
    created_at: evaluatedAt,
    updated_at: evaluatedAt,
  });
  await owner.prisma.user_controls.createMany({ data: [
    user("platform_owner"),
    user("self"),
    user("team_owner"),
    user("member"),
    user("disabled", "disabled"),
  ] });
  await owner.prisma.authority_grants.create({ data: {
    id: "platform_owner_grant",
    beneficiary_user_id: "platform_owner",
    role_domain: "platform",
    role_code: "owner",
    role_scope_id: null,
    source_kind: "system_bootstrap",
    effective_start: new Date(Date.parse(evaluatedAt) - 60_000).toISOString(),
    effective_end: null,
    lifecycle: "active",
    created_at: evaluatedAt,
  } });
  await owner.prisma.teams.create({ data: {
    id: "team_active",
    owner_id: "team_owner",
    name: "Tenancy verifier Team",
    status: "enabled",
    team_owner_can_create_access_point: 1,
    created_at: evaluatedAt,
    updated_at: evaluatedAt,
  } });
  await owner.prisma.team_memberships.create({ data: {
    id: "membership_member",
    team_id: "team_active",
    user_id: "member",
    roles_json: '["manager"]',
    created_at: evaluatedAt,
    updated_at: evaluatedAt,
  } });
  await owner.prisma.resource_permissions.create({ data: {
    id: "permission_team_manager_create_ap",
    resource_type: "team",
    resource_id: "team_active",
    action: "team.access_point.create",
    subject_type: "team_role",
    subject_ref: "team_active",
    subject_role: "manager",
    status: "enabled",
    created_at: evaluatedAt,
    updated_at: evaluatedAt,
  } });
}

function denied(
  scopeRef: ScopeRef,
  reason: Extract<AccessPointScopeDecision, { kind: "denied" }>["reason"],
): AccessPointScopeDecision {
  return { kind: "denied", scopeRef, reason };
}

async function waitForPostgres(): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = spawnSync("docker", ["exec", containerName, "psql", "-At", "-U", postgresUser, "-d", database, "-c", "SELECT 1"], {
      encoding: "utf8",
      maxBuffer: maximumCommandOutputBytes,
    });
    if (result.status === 0 && result.stdout.trim() === "1") return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("tenancy_postgres_not_ready");
}

function run(command: string, args: string[], input?: string, env: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync(command, args, { cwd: packageRoot, env, input, encoding: "utf8", maxBuffer: maximumCommandOutputBytes });
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command}_failed:${result.status ?? "signal"}${detail ? `\n${detail}` : ""}`);
  }
  return result.stdout;
}

function assert(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

await main();
