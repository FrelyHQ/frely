import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GatewayIdentityApplicationService, IdentityTenancyApplicationService } from "@frely/application/server";
import {
  createGatewayIdentityVerificationService,
  createIdentityTenancyApplicationVerificationService,
  createIdentityTenancyVerificationComposition,
  createIdentityVerificationContext,
  createOfflineIdentityCanonicalEmailUpgrade,
} from "../../application/verification/identity-tenancy-offline.js";
import { createPasswordHash, createValidatedAuthMutationRequest, sha256, verifyPassword, type ValidatedAuthMutationRequest } from "@frely/auth";
import type { AuditEventAppender } from "@frely/audit/application-internal";
import { parseConfig, type AppConfig } from "@frely/config";
import { EmailAddr } from "@frely/identity";
import { createBetterAuthRuntime } from "@frely/identity/application-internal";
import { PostgresClientOwner } from "@frely/postgres/server";
import {
  PostgresVerificationRuntime,
  verificationPostgresAdminUrlEnvironment,
  verificationPostgresDisposableUrlEnvironment,
  verificationPostgresNoDockerEnvironment,
} from "../src/postgres-verification-runtime.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const postgresPackageRoot = join(packageRoot, "..", "postgres");
const applicationPackageRoot = join(packageRoot, "..", "application");
const prismaConfigPath = join(postgresPackageRoot, "prisma.config.ts");
const prismaBinPath = join(postgresPackageRoot, "node_modules", ".bin", "prisma");
const migrationsRoot = join(postgresPackageRoot, "prisma", "migrations");
const identityTenancyMigration = "20260824003000_identity_tenancy_context_expand";
const postgresImage = "postgres:16-alpine";
const postgresUser = "friday_identity_tenancy";
const postgresPassword = "friday_identity_tenancy_local_only";
const freshDatabase = "identity_tenancy_fresh";
const takeoverDatabase = "identity_tenancy_takeover";
const maximumCommandOutputBytes = 32 * 1024 * 1024;
const sensitiveValues = new Set<string>();
let activeRuntime: PostgresVerificationRuntime | undefined;

function verificationAuthRequest(config: AppConfig, path: string, cookie?: string): ValidatedAuthMutationRequest {
  const origin = new URL(config.app.publicBaseUrl).origin;
  const url = new URL(path, `${origin}/`);
  const request = new Request(url, {
    method: "POST",
    headers: {
      host: url.host,
      origin,
      ...(cookie ? { cookie } : {}),
    },
  });
  return createValidatedAuthMutationRequest(request, origin);
}

type VerificationComposition = ReturnType<typeof createIdentityTenancyVerificationComposition>;
type IdentityVerificationContext = VerificationComposition["identity"];
type TenancyVerificationContext = VerificationComposition["tenancy"];
type IdentityUser = NonNullable<Awaited<ReturnType<IdentityVerificationContext["queries"]["getUser"]>>>;

interface Migration {
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

async function main(): Promise<void> {
  const source = sourceEvidence();
  await assertVerificationArtifactsExcluded();
  const migrations = await loadMigrations();
  const identityMigrationIndex = migrations.findIndex((migration) => migration.name === identityTenancyMigration);
  assert(identityMigrationIndex > 0, "identity_migration_prefix_missing");
  const prefix = migrations.slice(0, identityMigrationIndex);

  const runtime = await PostgresVerificationRuntime.start({
    verifier: "identity_tenancy",
    databases: [freshDatabase, takeoverDatabase],
    docker: {
      image: postgresImage,
      user: postgresUser,
      password: postgresPassword,
      containerPrefix: "friday-relay-identity-tenancy",
    },
    environment: dockerOnlyEnvironment(),
  });
  assert(runtime.mode === "docker", "identity_tenancy_verifier_not_docker");
  activeRuntime = runtime;
  let freshOwner: PostgresClientOwner | undefined;
  let takeoverOwner: PostgresClientOwner | undefined;
  let primaryFailure: unknown;
  try {
    deployPrisma(runtime, freshDatabase);
    assertExactMigrationHistory(runtime, freshDatabase, migrations);

    for (const migration of prefix) runtime.executeSql(takeoverDatabase, migration.sql);
    runtime.executeSql(takeoverDatabase, prismaHistoryTableSql());
    prefix.forEach((migration, index) => runtime.executeSql(takeoverDatabase, successfulHistorySql(migration, index)));
    assertExactMigrationHistory(runtime, takeoverDatabase, prefix);
    runtime.executeSql(takeoverDatabase, takeoverFixtureSql());
    const preUpgradeProjection = identityTenancySchemaProjection(runtime, takeoverDatabase);
    deployPrisma(runtime, takeoverDatabase);
    assertExactMigrationHistory(runtime, takeoverDatabase, migrations);
    assert(runtime.queryScalar(takeoverDatabase, `SELECT count(*)::text FROM "refresh_tokens"`) === "0", "legacy_refresh_tokens_not_deleted");
    assertAdditiveIdentityTenancyProjection(preUpgradeProjection, identityTenancySchemaProjection(runtime, takeoverDatabase));
    assertSchemaParity(runtime, freshDatabase, takeoverDatabase);

    freshOwner = new PostgresClientOwner({
      connectionString: runtime.connectionString(freshDatabase),
      max: 16,
      applicationName: "friday-relay-identity-tenancy-verification-fresh",
      transactionTimeoutMillis: 60_000,
    });
    takeoverOwner = new PostgresClientOwner({
      connectionString: runtime.connectionString(takeoverDatabase),
      max: 8,
      applicationName: "friday-relay-identity-tenancy-verification-takeover",
      transactionTimeoutMillis: 60_000,
    });
    await Promise.all([freshOwner.health(), takeoverOwner.health()]);

    await verifyFreshIdentityAndTenancy(freshOwner, verifierConfig());
    await verifyCanonicalEmailTakeover(takeoverOwner);

    const report = {
      sourceHead: source.head,
      sourceClean: source.clean,
      runtimeMode: runtime.mode,
      verificationArtifactsExcluded: true,
      migrationHead: migrations.at(-1)!.name,
      freshMigrationDeploy: true,
      pre03000Takeover: true,
      exactMigrationHistory: true,
      freshTakeoverSchemaParity: true,
      additiveTakeoverProjection: true,
      canonicalEmailPersistence: true,
      betterAuthSessionLifecycle: true,
      betterAuthPasswordCas: true,
      retiredAuthenticationWriters: true,
      teamMembershipInviteLifecycleAndConcurrency: true,
      deterministicPostgresLockOverlap: true,
      canonicalEmailUpgradeMergeAndFreeze: true,
      conflictNonTransfer: true,
      auditAtomicityAndSensitiveNonLeakage: true,
      stalePreflightAndRecordedSnapshotRejection: true,
      appendOnlyMigrationFacts: true,
    };

    await Promise.all([freshOwner.close(), takeoverOwner.close()]);
    freshOwner = undefined;
    takeoverOwner = undefined;
    await runtime.cleanup();
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    if (freshOwner) await freshOwner.close().catch((error: unknown) => cleanupFailures.push(error));
    if (takeoverOwner) await takeoverOwner.close().catch((error: unknown) => cleanupFailures.push(error));
    await runtime.cleanup().catch((error: unknown) => cleanupFailures.push(error));
    if (!primaryFailure && cleanupFailures[0]) throw cleanupFailures[0];
  }
}

async function verifyFreshIdentityAndTenancy(owner: PostgresClientOwner, config: AppConfig): Promise<void> {
  const { identity, tenancy, authority, application, gateway } = createIdentityTenancyVerificationComposition(owner, config);
  const ownerUserId = "user_identity_verifier_owner";
  const ownerPassword = sensitive("Identity-Owner-Password-41!");
  const ownerPasswordHash = sensitive(await createPasswordHash(ownerPassword));
  const ownerUser = await identity.commands.createUser({
    id: ownerUserId,
    teamId: null,
    email: EmailAddr.parse("identity-owner@example.invalid"),
    passwordHash: ownerPasswordHash,
  });
  await tenancy.commands.createTeamWithOwnerMembership({ id: "team_default", ownerUserId, name: "Default Team" });
  await authority.commands.ensureBootstrapOwner(ownerUserId);

  const actor = { actorType: "user" as const, actorId: ownerUserId };
  const team = await application.createTeam(
    { name: "Identity tenancy verification" },
    { actor, source: "owner", requestId: "req_identity_team_create" },
  );
  const currentPassword = sensitive("Identity-Current-Password-42!");
  const createdUser = await application.createUserWithPassword(
    {
      teamId: team.id,
      email: "  Canonical.User@Example.INVALID  ",
      password: currentPassword,
    },
    { actor, source: "owner", requestId: "req_identity_user_create" },
  );
  sensitive("canonical.user@example.invalid");
  const persistedUser = await identity.queries.getUser(createdUser.id);
  assert(persistedUser?.email === "canonical.user@example.invalid", "canonical_email_not_persisted");
  assert((await identity.queries.findUserByEmail(EmailAddr.parse(" CANONICAL.USER@EXAMPLE.INVALID ")))?.id === createdUser.id, "canonical_email_lookup_failed");
  EmailAddr.restore(persistedUser.email);
  assert(await owner.prisma.team_memberships.count({ where: { team_id: team.id, user_id: createdUser.id } }) === 1, "user_create_membership_missing");
  assert(await owner.prisma.audit_logs.count({ where: { request_id: "req_identity_user_create", action: "user.create", resource_id: createdUser.id } }) === 1, "user_create_audit_missing");

  const betterAuthLogin = await application.loginWithBetterAuth(
    " CANONICAL.USER@EXAMPLE.INVALID ",
    currentPassword,
    verificationAuthRequest(config, "/api/auth/login"),
    { source: "web", requestId: "req_identity_better_auth_login" },
  );
  assert(betterAuthLogin.user.id === createdUser.id, "better_auth_login_user_mismatch");
  assert(betterAuthLogin.setCookieHeaders.length === 1, "better_auth_login_cookie_count");
  const betterAuthCookieHeader = betterAuthLogin.setCookieHeaders[0]!;
  sensitive(betterAuthCookieHeader);
  assert(betterAuthCookieHeader.startsWith("friday_session_token="), "better_auth_cookie_name_invalid");
  const betterAuthCookie = betterAuthCookieHeader.split(";", 1)[0]!;
  sensitive(betterAuthCookie);
  const betterAuthRuntime = createBetterAuthRuntime(owner, config);
  const directBetterAuthSession = await betterAuthRuntime.getSession(new Headers({ cookie: betterAuthCookie }));
  assert(directBetterAuthSession?.user.id === createdUser.id, "better_auth_direct_session_lookup_failed");
  assert(Number.isFinite(directBetterAuthSession.session.createdAt.getTime()) && Number.isFinite(directBetterAuthSession.session.expiresAt.getTime()), "better_auth_direct_session_dates_invalid");
  const betterAuthIdentity = await identity.queries.getUser(createdUser.id);
  assert(betterAuthIdentity?.status === "enabled" && betterAuthIdentity.email === directBetterAuthSession.user.email, "better_auth_identity_projection_invalid");
  const betterAuthProfile = await application.publicUser(createdUser.id, "web");
  assert(betterAuthProfile.id === createdUser.id, "better_auth_public_profile_invalid");
  const betterAuthSession = await application.requireBetterAuthSession(new Headers({ cookie: betterAuthCookie }), "web");
  assert(betterAuthSession.sub === createdUser.id && betterAuthSession.type === "access", "better_auth_session_projection_invalid");
  const storedBetterAuthSessions = await owner.prisma.session.findMany({ where: { userId: createdUser.id }, select: { token: true } });
  assert(storedBetterAuthSessions.length === 1 && /^[0-9a-f]{64}$/u.test(storedBetterAuthSessions[0]!.token), "better_auth_session_hash_storage_invalid");
  assert(!betterAuthCookieHeader.includes(currentPassword), "better_auth_cookie_contains_password");
  const betterAuthLogoutCookies = await application.logoutWithBetterAuth(
    verificationAuthRequest(config, "/api/auth/logout", betterAuthCookie),
    { source: "web", requestId: "req_identity_better_auth_logout" },
  );
  assert(betterAuthLogoutCookies.some((header) => header.startsWith("friday_session_token=")), "better_auth_logout_cookie_missing");
  await expectRelay("unauthorized", () => application.requireBetterAuthSession(new Headers({ cookie: betterAuthCookie }), "web"));

  const collisionPassword = sensitive("Identity-Canonical-Collision-48!");
  const canonicalCollisionResults = await Promise.allSettled([
    application.createUserWithPassword(
      { teamId: team.id, email: "Canonical.Collision@Example.INVALID", password: collisionPassword },
      { actor, source: "owner", requestId: "req_identity_collision_a" },
    ),
    application.createUserWithPassword(
      { teamId: team.id, email: " canonical.collision@example.invalid ", password: collisionPassword },
      { actor, source: "owner", requestId: "req_identity_collision_b" },
    ),
  ]);
  assert(fulfilled(canonicalCollisionResults).length === 1, "canonical_email_collision_success_count");
  assertRejectedRelay(canonicalCollisionResults, "email_already_registered", 1);
  assert(await owner.prisma.user.count({ where: { email: "canonical.collision@example.invalid" } }) === 1, "canonical_email_collision_persistence_count");

  const createdKey = await application.createKey(
    { userId: createdUser.id, name: "Verifier API key" },
    { actor: { actorType: "user", actorId: createdUser.id }, source: "web", requestId: "req_identity_key_create" },
  );
  sensitive(createdKey.rawKey);
  sensitive(createdKey.rawKey.slice(0, 10));
  sensitive(sha256(createdKey.rawKey));
  const principal = await gateway.authenticateApiKey(new Headers({ authorization: `Bearer ${createdKey.rawKey}` }));
  assert(principal.user.id === createdUser.id && principal.apiKey.id === createdKey.apiKey.id, "api_key_authentication_failed");

  const legacyAuthStateBeforePasswordChange = await legacyAuthStateCounts(owner, createdUser.id);
  const betterAuthLoginA = await application.loginWithBetterAuth(
    " CANONICAL.USER@EXAMPLE.INVALID ",
    currentPassword,
    verificationAuthRequest(config, "/api/auth/login"),
    { source: "web", requestId: "req_identity_better_auth_password_login_a" },
  );
  const betterAuthLoginB = await application.loginWithBetterAuth(
    " CANONICAL.USER@EXAMPLE.INVALID ",
    currentPassword,
    verificationAuthRequest(config, "/api/auth/login"),
    { source: "web", requestId: "req_identity_better_auth_password_login_b" },
  );
  const passwordCookieA = cookieValue(betterAuthLoginA.setCookieHeaders, "friday_session_token");
  const passwordCookieB = cookieValue(betterAuthLoginB.setCookieHeaders, "friday_session_token");
  sensitive(passwordCookieA);
  sensitive(passwordCookieB);
  assert(await owner.prisma.session.count({ where: { userId: createdUser.id } }) === 2, "better_auth_password_session_setup_count");
  const beforePasswordChange = (await identity.queries.getUser(createdUser.id))!;
  const nextPasswordA = sensitive("Identity-Next-Password-A-43!");
  const nextPasswordB = sensitive("Identity-Next-Password-B-44!");
  const passwordResults = await Promise.allSettled([
    application.changeOwnPasswordWithBetterAuth({
      userId: createdUser.id,
      surface: "web",
      currentPassword,
      newPassword: nextPasswordA,
      request: verificationAuthRequest(config, "/api/user/security/password", passwordCookieA),
      requestId: "req_identity_password_a",
    }),
    application.changeOwnPasswordWithBetterAuth({
      userId: createdUser.id,
      surface: "web",
      currentPassword,
      newPassword: nextPasswordB,
      request: verificationAuthRequest(config, "/api/user/security/password", passwordCookieB),
      requestId: "req_identity_password_b",
    }),
  ]);
  const passwordSessions = fulfilled(passwordResults);
  assert(passwordSessions.length === 1, "password_cas_success_count");
  assertRejectedRelay(passwordResults, "current_password_invalid", 1);
  const winningPassword = passwordResults[0]?.status === "fulfilled" ? nextPasswordA : nextPasswordB;
  const afterPasswordChange = (await identity.queries.getUser(createdUser.id))!;
  sensitive(afterPasswordChange.passwordHash);
  assert(afterPasswordChange.authVersion === beforePasswordChange.authVersion + 1, "password_auth_version_not_advanced_once");
  assert(await verifyPassword(winningPassword, afterPasswordChange.passwordHash), "password_hash_does_not_match_winner");
  const changedPasswordCookie = cookieValue(passwordSessions[0]!.setCookieHeaders, "friday_session_token");
  sensitive(changedPasswordCookie);
  assert(await owner.prisma.session.count({ where: { userId: createdUser.id } }) === 1, "better_auth_password_did_not_reissue_current_session");
  assert(await legacyAuthStateCounts(owner, createdUser.id).then((after) => sameLegacyAuthStateCounts(after, legacyAuthStateBeforePasswordChange)), "password_changed_legacy_auth_state");
  await expectRelay("unauthorized", () => application.requireBetterAuthSession(new Headers({ cookie: passwordCookieA }), "web"));
  await expectRelay("unauthorized", () => application.requireBetterAuthSession(new Headers({ cookie: passwordCookieB }), "web"));
  assert((await application.requireBetterAuthSession(new Headers({ cookie: changedPasswordCookie }), "web")).sub === createdUser.id, "better_auth_current_password_session_failed");
  await application.logoutWithBetterAuth(
    verificationAuthRequest(config, "/api/auth/logout", changedPasswordCookie),
    { source: "web", requestId: "req_identity_better_auth_password_current_logout" },
  );
  const winningLogin = await application.loginWithBetterAuth(
    " CANONICAL.USER@EXAMPLE.INVALID ",
    winningPassword,
    verificationAuthRequest(config, "/api/auth/login"),
    { source: "web", requestId: "req_identity_better_auth_password_winner" },
  );
  const winningCookie = cookieValue(winningLogin.setCookieHeaders, "friday_session_token");
  sensitive(winningCookie);
  assert((await application.requireBetterAuthSession(new Headers({ cookie: winningCookie }), "web")).sub === createdUser.id, "better_auth_winning_password_login_failed");
  await application.logoutWithBetterAuth(
    verificationAuthRequest(config, "/api/auth/logout", winningCookie),
    { source: "web", requestId: "req_identity_better_auth_password_winner_logout" },
  );
  await expectRelay("auth_method_retired", () => application.requireJwt(new Headers({ authorization: "Bearer retired" }), "web"));
  assert((await gateway.authenticateApiKey(new Headers({ authorization: `Bearer ${createdKey.rawKey}` }))).user.id === createdUser.id, "password_change_mutated_api_key_state");

  await verifyIdentityTransactionRollbacks(owner, application, identity, team.id, ownerUserId, createdUser.id, afterPasswordChange);
  await verifyRetiredAuthenticationWriters(owner, identity, createdUser.id, team.id, afterPasswordChange);
  await verifyApiKeyLifecycle(owner, application, gateway, createdKey.apiKey.id, createdKey.rawKey, createdUser.id);
  await verifyTeamAndInviteConcurrency(owner, application, identity, tenancy, team.id, ownerUser);
  await verifyAuditMutationAtomicity(owner, team.id, ownerUserId, createdUser.id);
  await verifyAuditFacts(owner, [
    "auth.login",
    "auth.logout",
    "auth.password_change",
    "api_key.create",
    "api_key.revoke",
    "team.create",
    "team_member.remove",
    "team_invite_link.accept",
    "team.owner.transfer",
  ]);
}

async function verifyIdentityTransactionRollbacks(
  owner: PostgresClientOwner,
  application: IdentityTenancyApplicationService,
  identity: IdentityVerificationContext,
  teamId: string,
  actorUserId: string,
  userId: string,
  currentUser: IdentityUser,
): Promise<void> {
  const failingAppender: AuditEventAppender = {
    async append() {
      throw new Error("verification_audit_persistence_unavailable");
    },
  };
  const failedPasswordHash = sensitive(await createPasswordHash(sensitive("Identity-Rollback-Password-46!")));
  const failedPasswordRefresh = sensitive(`identity-password-rollback-refresh-${randomUUID()}`);
  const beforePasswordAuditCount = await owner.prisma.audit_logs.count({ where: { request_id: "req_identity_password_rollback" } });
  const failingIdentity = createIdentityVerificationContext(owner, failingAppender).commands;
  await expectFailure(() => failingIdentity.rotateOwnPassword({
    userId,
    expectedPasswordHash: currentUser.passwordHash,
    newPasswordHash: failedPasswordHash,
    newRefreshTokenHash: failedPasswordRefresh,
    newRefreshTokenExpiresAt: futureIso(7_200),
    surface: "web",
    requestId: "req_identity_password_rollback",
  }));
  await expectFailure(() => failingIdentity.changeCredentialPassword({
    userId,
    expectedPasswordHash: currentUser.passwordHash,
    newPasswordHash: failedPasswordHash,
    surface: "web",
    requestId: "req_identity_password_rollback_better_auth",
  }));
  const afterFailedPassword = await identity.queries.getUser(userId);
  assert(afterFailedPassword?.passwordHash === currentUser.passwordHash && afterFailedPassword.authVersion === currentUser.authVersion, "password_audit_failure_did_not_rollback_user");
  assert(await owner.prisma.session.count({ where: { userId } }) === 0, "password_audit_failure_created_session");
  assert(await owner.prisma.audit_logs.count({ where: { request_id: "req_identity_password_rollback" } }) === beforePasswordAuditCount, "password_audit_failure_persisted_event");
  await expectRelay("auth_method_retired", () => application.refresh("retired", { source: "web", requestId: "req_identity_refresh_rollback" }));

  const rollbackEmail = sensitive("rollback.user@example.invalid");
  const beforeUserCount = await owner.prisma.user_controls.count();
  const beforeMembershipCount = await owner.prisma.team_memberships.count({ where: { team_id: teamId } });
  await installAuditRejectionTrigger(owner, "user.create", null);
  try {
    await expectFailure(() => application.createUserWithPassword(
      { teamId, email: rollbackEmail, password: sensitive("Identity-Rollback-Create-47!") },
      { actor: { actorType: "user", actorId: actorUserId }, source: "owner", requestId: "req_identity_user_create_rollback" },
    ));
  } finally {
    await removeAuditRejectionTrigger(owner);
  }
  assert(await owner.prisma.user_controls.count() === beforeUserCount, "user_create_audit_failure_persisted_user");
  assert(await owner.prisma.user.count({ where: { email: rollbackEmail } }) === 0, "user_create_audit_failure_persisted_email");
  assert(await owner.prisma.team_memberships.count({ where: { team_id: teamId } }) === beforeMembershipCount, "user_create_audit_failure_persisted_membership");
  assert(await owner.prisma.audit_logs.count({ where: { request_id: "req_identity_user_create_rollback" } }) === 0, "user_create_audit_failure_persisted_event");
}

async function verifyRetiredAuthenticationWriters(
  owner: PostgresClientOwner,
  identity: IdentityVerificationContext,
  userId: string,
  teamId: string,
  userBeforePasskey: IdentityUser,
): Promise<void> {
  void teamId;
  void userBeforePasskey;
  const before = await legacyAuthStateCounts(owner, userId);
  const retiredCalls = [
    () => identity.commands.createRefreshTokenForAuthVersion({ userId, expectedAuthVersion: 1, tokenHash: sensitive(`retired-refresh-${randomUUID()}`), expiresAt: futureIso(3_600) }),
    () => identity.commands.registerUserPasskey({ userId, expectedAuthVersion: userBeforePasskey.authVersion, credentialId: sensitive(`retired-passkey-${randomUUID()}`), publicKey: sensitive(`retired-key-${randomUUID()}`), signCount: 0, transportsJson: "[]", deviceType: "singleDevice", backedUp: 0, rpId: "example.invalid", name: "retired", source: "web" }),
    () => identity.commands.createWebAuthnCeremony({ sessionHash: sensitive(`retired-ceremony-${randomUUID()}`), challengeHash: sensitive(`retired-challenge-${randomUUID()}`), purpose: "authentication", surface: "web", userId: null, expectedAuthVersion: null, rpId: "example.invalid", origin: "https://example.invalid", passkeyName: null, expiresAt: futureIso(3_600) }),
    () => identity.commands.createOidcAuthorizationCode({ codeHash: sensitive(`retired-oidc-${randomUUID()}`), userId, clientId: "retired", redirectUri: "https://example.invalid/callback", scope: "openid", codeChallenge: "retired", nonce: "retired", expiresAt: futureIso(3_600) }),
  ];
  for (const call of retiredCalls) await expectRelay("auth_method_retired", call);
  assert(await legacyAuthStateCounts(owner, userId).then((after) => sameLegacyAuthStateCounts(after, before)), "retired_auth_writer_mutated_legacy_state");
}

async function verifyApiKeyLifecycle(
  owner: PostgresClientOwner,
  application: IdentityTenancyApplicationService,
  gateway: GatewayIdentityApplicationService,
  apiKeyId: string,
  rawKey: string,
  userId: string,
): Promise<void> {
  const beforeFailedCreateCount = await owner.prisma.api_keys.count({ where: { user_id: userId } });
  await installAuditRejectionTrigger(owner, "api_key.create", null);
  try {
    await expectFailure(() => application.createKey(
      { userId, name: "Rollback verifier API key" },
      { actor: { actorType: "user", actorId: userId }, source: "web", requestId: "req_identity_key_create_rollback" },
    ));
  } finally {
    await removeAuditRejectionTrigger(owner);
  }
  assert(await owner.prisma.api_keys.count({ where: { user_id: userId } }) === beforeFailedCreateCount, "api_key_create_audit_failure_persisted_key");
  assert(await owner.prisma.audit_logs.count({ where: { request_id: "req_identity_key_create_rollback" } }) === 0, "api_key_create_audit_failure_persisted_event");

  const beforeFailedDisable = await owner.prisma.api_keys.findUniqueOrThrow({ where: { id: apiKeyId } });
  const failedDisableAuditCount = await owner.prisma.audit_logs.count({ where: { request_id: "req_identity_key_disable_rollback" } });
  await installAuditRejectionTrigger(owner, "api_key.disable", apiKeyId);
  try {
    await expectFailure(() => application.disableKey(apiKeyId, {
      actor: { actorType: "user", actorId: userId },
      source: "web",
      requestId: "req_identity_key_disable_rollback",
    }));
  } finally {
    await removeAuditRejectionTrigger(owner);
  }
  const afterFailedDisable = await owner.prisma.api_keys.findUniqueOrThrow({ where: { id: apiKeyId } });
  assert(afterFailedDisable.status === beforeFailedDisable.status && afterFailedDisable.updated_at === beforeFailedDisable.updated_at, "api_key_audit_failure_did_not_rollback");
  assert(await owner.prisma.audit_logs.count({ where: { request_id: "req_identity_key_disable_rollback" } }) === failedDisableAuditCount, "api_key_audit_failure_persisted_event");

  await application.disableKey(apiKeyId, {
    actor: { actorType: "user", actorId: userId },
    source: "web",
    requestId: "req_identity_key_disable",
  });
  await expectRelay("api_key_disabled", () => gateway.authenticateApiKey(new Headers({ authorization: `Bearer ${rawKey}` })));
  await application.enableKey(apiKeyId, {
    actor: { actorType: "user", actorId: userId },
    source: "web",
    requestId: "req_identity_key_enable",
  });
  assert((await gateway.authenticateApiKey(new Headers({ authorization: `Bearer ${rawKey}` }))).user.id === userId, "api_key_reenable_failed");

  const beforeFailedRevoke = await owner.prisma.api_keys.findUniqueOrThrow({ where: { id: apiKeyId } });
  await installAuditRejectionTrigger(owner, "api_key.revoke", apiKeyId);
  try {
    await expectFailure(() => application.revokeKey(apiKeyId, {
      actor: { actorType: "user", actorId: userId },
      source: "web",
      requestId: "req_identity_key_revoke_rollback",
    }));
  } finally {
    await removeAuditRejectionTrigger(owner);
  }
  const afterFailedRevoke = await owner.prisma.api_keys.findUniqueOrThrow({ where: { id: apiKeyId } });
  assert(afterFailedRevoke.status === beforeFailedRevoke.status && afterFailedRevoke.revoked_at === beforeFailedRevoke.revoked_at && afterFailedRevoke.updated_at === beforeFailedRevoke.updated_at, "api_key_revoke_audit_failure_did_not_rollback");
  assert(await owner.prisma.audit_logs.count({ where: { request_id: "req_identity_key_revoke_rollback" } }) === 0, "api_key_revoke_audit_failure_persisted_event");

  await application.revokeKey(apiKeyId, {
    actor: { actorType: "user", actorId: userId },
    source: "web",
    requestId: "req_identity_key_revoke",
  });
  await expectRelay("api_key_disabled", () => gateway.authenticateApiKey(new Headers({ authorization: `Bearer ${rawKey}` })));
  await expectRelay("api_key_revoked", () => application.enableKey(apiKeyId, {
    actor: { actorType: "user", actorId: userId },
    source: "web",
    requestId: "req_identity_key_reenable_rejected",
  }));
}

async function verifyTeamAndInviteConcurrency(
  owner: PostgresClientOwner,
  application: IdentityTenancyApplicationService,
  identity: IdentityVerificationContext,
  tenancy: TenancyVerificationContext,
  teamId: string,
  ownerUser: IdentityUser,
): Promise<void> {
  const memberPasswordHash = sensitive(await createPasswordHash(sensitive("Identity-Member-Password-45!")));
  const memberA = await identity.commands.createUser({
    id: "user_identity_member_a",
    teamId: null,
    email: EmailAddr.parse("identity-member-a@example.invalid"),
    passwordHash: memberPasswordHash,
  });
  const audit = { actor: { actorType: "user" as const, actorId: ownerUser.id }, source: "owner" as const };
  const firstMembership = await application.addTeamMember(teamId, memberA.id, { ...audit, requestId: "req_identity_member_add" });
  const changedMembership = await application.updateTeamMemberRoles(teamId, memberA.id, ["viewer", "manager"], { ...audit, requestId: "req_identity_member_roles" });
  assert(JSON.parse(changedMembership.rolesJson).join(",") === "viewer,manager", "team_membership_roles");
  const removedMembership = await application.removeTeamMember(teamId, memberA.id, { ...audit, requestId: "req_identity_member_remove" });
  assert(removedMembership.id === firstMembership.id, "team_membership_remove_identity");
  const rejoinedMembership = await application.addTeamMember(teamId, memberA.id, { ...audit, requestId: "req_identity_member_rejoin" });
  assert(rejoinedMembership.id !== firstMembership.id, "team_membership_rejoin_identity_not_new");

  const memberB = await identity.commands.createUser({
    id: "user_identity_member_b",
    teamId: null,
    email: EmailAddr.parse("identity-member-b@example.invalid"),
    passwordHash: memberPasswordHash,
  });
  const concurrentMemberships = fulfilled(await runLockCoordinatedSettledRace(owner, {
    name: "membership_grant",
    relation: "teams",
    lockSql: `SELECT "id" FROM "teams" WHERE "id" = $1 FOR UPDATE`,
    lockValues: [teamId],
    participants: [
      () => tenancy.commands.grantMembership(teamId, memberB.id),
      () => tenancy.commands.grantMembership(teamId, memberB.id),
    ],
  }));
  assert(concurrentMemberships[0]!.id === concurrentMemberships[1]!.id, "team_membership_concurrent_identity");
  assert(await owner.prisma.team_memberships.count({ where: { team_id: teamId, user_id: memberB.id } }) === 1, "team_membership_concurrent_count");

  await application.updateTeamInviteSettings(
    teamId,
    { memberInvitesEnabled: true, inviteEmailDomainPattern: "example.invalid" },
    { ...audit, requestId: "req_identity_invite_settings" },
  );
  const memberAudit = { actor: { actorType: "user" as const, actorId: memberA.id }, source: "web" as const };
  const linkResults = fulfilled(await runLockCoordinatedSettledRace(owner, {
    name: "invite_create",
    relation: "teams",
    lockSql: `SELECT "id" FROM "teams" WHERE "id" = $1 FOR UPDATE`,
    lockValues: [teamId],
    participants: [
      () => application.createTeamInviteLink(teamId, { ...memberAudit, requestId: "req_identity_invite_link_a" }, 1),
      () => application.createTeamInviteLink(teamId, { ...memberAudit, requestId: "req_identity_invite_link_b" }, 1),
    ],
  }));
  assert(linkResults[0]!.inviteLink.id === linkResults[1]!.inviteLink.id, "team_invite_concurrent_identity");
  assert(linkResults.map((result) => result.outcome).sort().join(",") === "already_active,created", "team_invite_concurrent_outcomes");
  const inviteLink = linkResults[0]!.inviteLink;

  const joinerA = await identity.commands.createUser({
    id: "user_identity_joiner_a",
    teamId: null,
    email: EmailAddr.parse("identity-joiner-a@example.invalid"),
    passwordHash: memberPasswordHash,
  });
  const joinerB = await identity.commands.createUser({
    id: "user_identity_joiner_b",
    teamId: null,
    email: EmailAddr.parse("identity-joiner-b@example.invalid"),
    passwordHash: memberPasswordHash,
  });
  const acceptResults = await runLockCoordinatedSettledRace(owner, {
    name: "invite_consume",
    relation: "team_invite_links",
    lockSql: `SELECT "id" FROM "team_invite_links" WHERE "id" = $1 FOR UPDATE`,
    lockValues: [inviteLink.id],
    participants: [
      () => application.acceptTeamInviteLink(inviteLink.id, { userId: joinerA.id }, {
        actor: { actorType: "user", actorId: joinerA.id }, source: "web", requestId: "req_identity_invite_accept_a",
      }),
      () => application.acceptTeamInviteLink(inviteLink.id, { userId: joinerB.id }, {
        actor: { actorType: "user", actorId: joinerB.id }, source: "web", requestId: "req_identity_invite_accept_b",
      }),
    ],
  });
  assert(fulfilled(acceptResults).length === 1, "team_invite_capacity_concurrent_success_count");
  assertRejectedRelay(acceptResults, "team_invite_link_not_found", 1);
  assert(await owner.prisma.team_memberships.count({ where: { team_id: teamId, user_id: { in: [joinerA.id, joinerB.id] } } }) === 1, "team_invite_capacity_membership_count");
  const consumedLink = await tenancy.queries.getInviteLink(inviteLink.id);
  assert(consumedLink?.usedCount === 1 && consumedLink.status === "disabled", "team_invite_capacity_state");

  await installAuditRejectionTrigger(owner, "team.owner.transfer", teamId);
  const ownershipAuditCount = await owner.prisma.audit_logs.count({ where: { action: "team.owner.transfer", resource_id: teamId } });
  try {
    await expectFailure(() => application.transferTeamOwnership({ teamId, nextOwnerUserId: memberA.id, actorUserId: ownerUser.id }));
  } finally {
    await removeAuditRejectionTrigger(owner);
  }
  assert((await tenancy.queries.getTeam(teamId))?.ownerId === ownerUser.id, "team_owner_audit_failure_did_not_rollback");
  assert(await owner.prisma.audit_logs.count({ where: { action: "team.owner.transfer", resource_id: teamId } }) === ownershipAuditCount, "team_owner_audit_failure_persisted_event");
  await application.transferTeamOwnership({ teamId, nextOwnerUserId: memberA.id, actorUserId: ownerUser.id });
  await application.transferTeamOwnership({ teamId, nextOwnerUserId: ownerUser.id, actorUserId: memberA.id });
  assert((await tenancy.queries.getTeam(teamId))?.ownerId === ownerUser.id, "team_owner_transfer_round_trip");

  const ownerLink = await application.createTeamInviteLink(teamId, { ...audit, requestId: "req_identity_owner_invite" }, 2);
  const membershipCountBeforeDeletion = await owner.prisma.team_memberships.count({ where: { team_id: teamId } });
  await application.requestTeamDeletion(teamId, { ...audit, requestId: "req_identity_team_delete" });
  assert(!(await tenancy.queries.isTeamAvailable(teamId)), "team_deletion_availability");
  assert((await tenancy.queries.getInviteLink(ownerLink.inviteLink.id))?.status === "disabled", "team_deletion_invite_disable");
  assert(await owner.prisma.team_memberships.count({ where: { team_id: teamId } }) === membershipCountBeforeDeletion, "team_deletion_membership_preservation");
  await application.cancelTeamDeletion(teamId, { ...audit, requestId: "req_identity_team_restore" });
  assert(await tenancy.queries.isTeamAvailable(teamId), "team_restore_availability");
  assert((await tenancy.queries.getTeam(teamId))?.id === teamId, "team_restore_identity");
  assert(await owner.prisma.team_memberships.count({ where: { team_id: teamId } }) === membershipCountBeforeDeletion, "team_restore_membership_preservation");
  await expectRelay("default_team_protected", () => application.requestTeamDeletion("team_default", { ...audit, requestId: "req_identity_default_team_delete" }));
}

async function verifyAuditMutationAtomicity(owner: PostgresClientOwner, teamId: string, ownerUserId: string, userId: string): Promise<void> {
  const application = createIdentityTenancyApplicationVerificationService(owner, verifierConfig());
  const before = await owner.prisma.teams.findUniqueOrThrow({ where: { id: teamId } });
  const beforeAuditCount = await owner.prisma.audit_logs.count({ where: { request_id: "req_identity_audit_atomicity" } });
  await installAuditRejectionTrigger(owner, "team.update", teamId);
  try {
    await expectFailure(() => application.updateTeam(
      teamId,
      { name: "Atomicity must roll back" },
      {
        actor: { actorType: "user", actorId: ownerUserId },
        source: "owner",
        requestId: "req_identity_audit_atomicity",
      },
    ));
  } finally {
    await removeAuditRejectionTrigger(owner);
  }
  const after = await owner.prisma.teams.findUniqueOrThrow({ where: { id: teamId } });
  assert(after.name === before.name && after.updated_at === before.updated_at, "audit_failure_did_not_rollback_team_mutation");
  assert(await owner.prisma.audit_logs.count({ where: { request_id: "req_identity_audit_atomicity" } }) === beforeAuditCount, "audit_failure_persisted_audit");
  assert((await owner.prisma.user_controls.findUniqueOrThrow({ where: { id: userId } })).status === "enabled", "audit_atomicity_changed_unrelated_user");
}

async function seedTakeoverOpaqueConflicts(owner: PostgresClientOwner): Promise<void> {
  const passwordHash = sensitiveFixture("takeover-password-hash");
  const providerCredentialRefs = sensitive(`["verification-provider-ref-${randomUUID()}"]`);
  const providerCredentialPreview = sensitive(`verification-provider-preview-${randomUUID()}`);
  const now = "2020-01-06T00:00:00.000Z";
  const users = [
    ["user_takeover_permission", "UpGrade@example.invalid", "2020-01-06T00:00:00.000Z"],
    ["user_takeover_provider", "uPgrade@example.invalid", "2020-01-07T00:00:00.000Z"],
    ["user_takeover_access_point", "upGrade@example.invalid", "2020-01-08T00:00:00.000Z"],
    ["user_takeover_plan", "upgRade@example.invalid", "2020-01-09T00:00:00.000Z"],
    ["user_takeover_billing", "upgrAde@example.invalid", "2020-01-10T00:00:00.000Z"],
    ["user_takeover_application_scope", "upgraDe@example.invalid", "2020-01-11T00:00:00.000Z"],
    ["user_takeover_member_move_acl", "upgradE@example.invalid", "2020-01-12T00:00:00.000Z"],
    ["user_takeover_member_collapse_acl", "Upgrade@example.invalid", "2020-01-13T00:00:00.000Z"],
  ] as const;
  users.forEach(([, email]) => sensitive(email));
  await owner.withPrismaTransaction(async (transaction) => {
    await transaction.user_controls.createMany({ data: users.map(([id, email, createdAt]) => ({
      id,
      team_id: null,
      email,
      password_hash: passwordHash,
      auth_version: 1,
      status: "enabled",
      admin_note: null,
      api_key_limit: 3,
      user_can_create_custom_provider: 0,
      user_can_create_access_point: 0,
      migration_frozen_at: null,
      migration_freeze_reason: null,
      created_at: createdAt,
      updated_at: createdAt,
    })) });
    await transaction.user.createMany({ data: users.map(([id, email, createdAt]) => ({
      id,
      name: `Friday User ${id}`,
      email,
      emailVerified: false,
      image: null,
      createdAt: new Date(createdAt),
      updatedAt: new Date(createdAt),
    })) });
    await transaction.account.createMany({ data: users.map(([id, , createdAt]) => ({
      id: `auth_account_${id}`,
      accountId: id,
      providerId: "credential",
      userId: id,
      issuer: "local:credential",
      password: passwordHash,
      createdAt: new Date(createdAt),
      updatedAt: new Date(createdAt),
    })) });
    await transaction.team_memberships.createMany({ data: [
      {
        id: "membership_takeover_member_move_acl",
        team_id: "team_takeover_transfer",
        user_id: "user_takeover_member_move_acl",
        roles_json: "[\"viewer\"]",
        by_invite_link: null,
        created_at: now,
        updated_at: now,
      },
      {
        id: "membership_takeover_member_collapse_acl",
        team_id: "team_takeover_shared",
        user_id: "user_takeover_member_collapse_acl",
        roles_json: "[\"viewer\"]",
        by_invite_link: null,
        created_at: now,
        updated_at: now,
      },
    ] });
    await transaction.resource_permissions.createMany({ data: [{
      id: "permission_takeover_isolated",
      resource_type: "team",
      resource_id: "team_takeover_shared",
      action: "team.invite_link.create",
      subject_type: "user",
      subject_ref: "user_takeover_permission",
      subject_role: null,
      status: "enabled",
      created_at: now,
      updated_at: now,
    }, {
      id: "permission_takeover_member_move_acl",
      resource_type: "team",
      resource_id: "team_takeover_transfer",
      action: "team.invite_link.create",
      subject_type: "member",
      subject_ref: "membership_takeover_member_move_acl",
      subject_role: null,
      status: "enabled",
      created_at: now,
      updated_at: now,
    }, {
      id: "permission_takeover_member_collapse_acl",
      resource_type: "team",
      resource_id: "team_takeover_shared",
      action: "team.invite_link.create",
      subject_type: "member",
      subject_ref: "membership_takeover_member_collapse_acl",
      subject_role: null,
      status: "enabled",
      created_at: now,
      updated_at: now,
    }] });
    await transaction.providers.create({ data: {
      id: "provider_takeover_isolated",
      owner_id: "user_takeover_provider",
      scope_ref: "user:user_takeover_provider",
      name: "Takeover Provider",
      kind: "openai-compatible",
      status: "disabled",
      base_url_resolver: "static",
      credential_resolver: "cpa",
      models_resolver: "static",
      config_json: "{}",
      cpa_instance_id: "cpa_default",
      created_at: now,
      updated_at: now,
      provider_bindings: { create: {
        auth_method: "api-key",
        credential_ownership: "cpa-managed",
        credential_refs_json: providerCredentialRefs,
        credential_preview: providerCredentialPreview,
        revision: 1,
        sync_status: "ready",
        error_code: null,
        created_at: now,
        updated_at: now,
      } },
    } });
    await transaction.accessPoint.create({ data: {
      id: "access_point_takeover_isolated",
      ownerId: "user_takeover_access_point",
      scopeRef: "user:user_takeover_access_point",
      name: "Takeover AccessPoint",
      description: null,
      apiFamily: "openai",
      exposedModel: "takeover-model",
      targetModel: "takeover-model",
      routingRuleId: "direct",
      routingRuleBehaviorVersion: 1,
      routingRuleConfigJson: "{}",
      requestOverridesJson: "{}",
      routingRevision: 1,
      legacyTargetType: "provider",
      legacyTargetId: null,
      legacyTargetProviderId: "provider_takeover_isolated",
      legacyTargetProviderModelName: "takeover-model",
      priority: 100,
      weight: 1,
      fallbackOrder: 100,
      status: "disabled",
      removedAt: null,
      createIdempotencyKeyHash: null,
      createRequestHash: null,
      createdAt: now,
      updatedAt: now,
    } });
    await transaction.plans.create({ data: {
      id: "plan_takeover_isolated",
      owner_id: "user_takeover_plan",
      scope_ref: "user:user_takeover_plan",
      name: "Takeover isolated Plan",
      version: 1,
      description: null,
      admin_note: null,
      billing_mode: "prepaid",
      purchase_amount: 0,
      purchase_amount_units: 0n,
      duration_seconds: 3600,
      plan_status: "disabled",
      catalog_status: "unlisted",
      created_at: now,
      updated_at: now,
    } });
    await transaction.credit_accounts.create({ data: {
      id: "credit_account_takeover_isolated",
      scope_ref: "user:user_takeover_billing",
      status: "enabled",
      balance_snap_units: 0n,
      balance_snap_ledger_event_id: null,
      balance_snap_updated_at: null,
      created_at: now,
      updated_at: now,
    } });
    await transaction.ingress_plugin_settings.create({ data: {
      id: "ingress_setting_takeover_isolated",
      plugin_id: "takeover-verification",
      scope_ref: "user:user_takeover_application_scope",
      enabled: 1,
      config_json: "{}",
      updated_by_user_id: null,
      created_at: now,
      updated_at: now,
    } });
  });
}

async function verifyCanonicalEmailTakeover(owner: PostgresClientOwner): Promise<void> {
  await seedTakeoverOpaqueConflicts(owner);
  const upgrade = createOfflineIdentityCanonicalEmailUpgrade(owner);
  const beforeUserCount = await owner.prisma.user_controls.count();
  const beforeReferenceDigest = await migrationReferenceDigest(owner);
  const preflight = await upgrade.preflight();
  assert(preflight.invalidUserIds.length === 0, "canonical_upgrade_invalid_fixture");
  assert(preflight.observedUserCount === beforeUserCount, "canonical_upgrade_observed_user_count");
  assert(preflight.singletonCanonicalizations.length === 1, "canonical_upgrade_singleton_count");
  assert(preflight.collisionGroups.length === 1, "canonical_upgrade_collision_group_count");
  const group = preflight.collisionGroups[0]!;
  const actualDecisions = group.decisions.map((decision) => `${decision.sourceUserId}:${decision.outcome}`).join(",");
  assert(actualDecisions === [
    "user_takeover_merge_unique:merge",
    "user_takeover_merge_duplicate:merge",
    "user_takeover_frozen:freeze",
    "user_takeover_permission:freeze",
    "user_takeover_provider:freeze",
    "user_takeover_access_point:freeze",
    "user_takeover_plan:freeze",
    "user_takeover_billing:freeze",
    "user_takeover_application_scope:freeze",
    "user_takeover_member_move_acl:freeze",
    "user_takeover_member_collapse_acl:freeze",
  ].join(","), "canonical_upgrade_decisions");
  const frozenDecision = group.decisions.find((decision) => decision.sourceUserId === "user_takeover_frozen");
  assert(frozenDecision?.conflicts.join(",") === "credential_conflict,platform_owner_conflict,tenant_ownership_conflict,identity_fact_conflict", "canonical_upgrade_conflicts");
  for (const sourceUserId of [
    "user_takeover_permission",
    "user_takeover_provider",
    "user_takeover_access_point",
    "user_takeover_plan",
    "user_takeover_billing",
    "user_takeover_application_scope",
    "user_takeover_member_move_acl",
    "user_takeover_member_collapse_acl",
  ]) {
    assert(group.decisions.find((decision) => decision.sourceUserId === sourceUserId)?.conflicts.join(",") === "identity_fact_conflict", `canonical_upgrade_opaque_conflict:${sourceUserId}`);
  }
  assert(await owner.prisma.identity_migration_batches.count() === 0, "canonical_preflight_wrote_batch");
  assert(await owner.prisma.identity_migration_records.count() === 0, "canonical_preflight_wrote_record");

  const originalSingletonEmail = " Single@Example.INVALID ";
  await owner.prisma.user.update({ where: { id: "user_takeover_singleton" }, data: { email: "Single@Example.INVALID" } });
  await expectRelay("identity_email_preflight_stale", () => upgrade.recordPreflight(preflight, "identity_migration_stale_preflight"));
  assert(await owner.prisma.identity_migration_batches.count() === 0, "stale_preflight_persisted_batch");
  assert(await owner.prisma.identity_migration_records.count() === 0, "stale_preflight_persisted_records");
  await owner.prisma.user.update({ where: { id: "user_takeover_singleton" }, data: { email: originalSingletonEmail } });

  const batchId = "identity_migration_verification";
  const currentPreflight = await upgrade.preflight();
  await upgrade.recordPreflight(currentPreflight, batchId);
  const recordedBatch = await owner.prisma.identity_migration_batches.findUniqueOrThrow({ where: { id: batchId } });
  assert(recordedBatch.status === "preflighted" && recordedBatch.snapshot_digest === currentPreflight.snapshotDigest, "canonical_recorded_preflight_batch");
  assert(await owner.prisma.identity_migration_records.count({ where: { batch_id: batchId } }) === 12, "canonical_recorded_preflight_records");
  const recordedProjection = JSON.stringify(await owner.prisma.identity_migration_records.findMany({ where: { batch_id: batchId } }));
  for (const marker of sensitiveValues) assert(!recordedProjection.includes(marker), "sensitive_marker_present_in_migration_record");

  const transferMembership = await owner.prisma.team_memberships.findUniqueOrThrow({ where: { id: "membership_takeover_transfer" } });
  await owner.prisma.team_memberships.update({ where: { id: transferMembership.id }, data: { roles_json: "[\"manager\"]" } });
  await expectRelay("identity_email_upgrade_snapshot_changed", () => upgrade.run({ batchId, execute: true, offlineConfirmed: true }));
  assert((await owner.prisma.identity_migration_batches.findUniqueOrThrow({ where: { id: batchId } })).status === "preflighted", "stale_membership_role_advanced_batch");
  await owner.prisma.team_memberships.update({ where: { id: transferMembership.id }, data: { roles_json: transferMembership.roles_json, updated_at: transferMembership.updated_at } });

  await owner.prisma.team_memberships.create({ data: {
    id: "membership_takeover_stale_addition",
    team_id: "team_takeover_shared",
    user_id: "user_takeover_merge_unique",
    roles_json: "[\"viewer\"]",
    by_invite_link: null,
    created_at: "2020-01-14T00:00:00.000Z",
    updated_at: "2020-01-14T00:00:00.000Z",
  } });
  await expectRelay("identity_email_upgrade_snapshot_changed", () => upgrade.run({ batchId, execute: true, offlineConfirmed: true }));
  assert((await owner.prisma.identity_migration_batches.findUniqueOrThrow({ where: { id: batchId } })).status === "preflighted", "stale_membership_addition_advanced_batch");
  await owner.prisma.team_memberships.delete({ where: { id: "membership_takeover_stale_addition" } });

  await owner.prisma.user.update({ where: { id: "user_takeover_singleton" }, data: { email: "Single@Example.INVALID" } });
  await expectRelay("identity_email_upgrade_snapshot_changed", () => upgrade.run({ batchId, execute: true, offlineConfirmed: true }));
  assert((await owner.prisma.identity_migration_batches.findUniqueOrThrow({ where: { id: batchId } })).status === "preflighted", "stale_recorded_run_advanced_batch");
  assert(await owner.prisma.identity_migration_records.count({ where: { batch_id: batchId } }) === 12, "stale_recorded_run_appended_terminal_records");
  await owner.prisma.user.update({ where: { id: "user_takeover_singleton" }, data: { email: originalSingletonEmail } });

  const result = await upgrade.run({ batchId, execute: true, offlineConfirmed: true });
  assert(result.status === "completed_with_frozen", "canonical_upgrade_status");
  assert(result.canonicalizedCount === 2 && result.mergedCount === 2 && result.frozenCount === 9, "canonical_upgrade_counts");
  assert(await owner.prisma.user_controls.count() === beforeUserCount - 2, "canonical_upgrade_user_count");
  const survivor = await owner.prisma.user.findUniqueOrThrow({ where: { id: "user_takeover_survivor" } });
  assert(survivor.email === "upgrade@example.invalid", "canonical_upgrade_survivor_email");
  assert((await owner.prisma.user.findUniqueOrThrow({ where: { id: "user_takeover_singleton" } })).email === "single@example.invalid", "canonical_upgrade_singleton_email");
  assert(await owner.prisma.user.findUnique({ where: { id: "user_takeover_merge_unique" } }) === null, "canonical_upgrade_merge_unique_source_present");
  assert(await owner.prisma.user.findUnique({ where: { id: "user_takeover_merge_duplicate" } }) === null, "canonical_upgrade_merge_duplicate_source_present");
  const frozen = await owner.prisma.user_controls.findUniqueOrThrow({ where: { id: "user_takeover_frozen" } });
  assert(frozen.status === "disabled" && frozen.auth_version === 2 && frozen.migration_frozen_at !== null, "canonical_upgrade_frozen_state");
  assert(frozen.migration_freeze_reason === "credential_conflict,platform_owner_conflict,tenant_ownership_conflict,identity_fact_conflict", "canonical_upgrade_freeze_reason");

  const transferredMembership = await owner.prisma.team_memberships.findUniqueOrThrow({ where: { id: "membership_takeover_transfer" } });
  assert(transferredMembership.user_id === survivor.id, "canonical_upgrade_membership_not_transferred");
  assert(await owner.prisma.team_memberships.count({ where: { team_id: "team_takeover_shared", user_id: survivor.id } }) === 1, "canonical_upgrade_duplicate_membership_not_collapsed");
  assert(await owner.prisma.team_memberships.findUnique({ where: { id: "membership_takeover_duplicate" } }) === null, "canonical_upgrade_duplicate_membership_source_present");

  assert((await owner.prisma.api_keys.findUniqueOrThrow({ where: { id: "key_takeover_frozen" } })).user_id === frozen.id, "canonical_upgrade_transferred_credential");
  assert((await owner.prisma.authority_grants.findUniqueOrThrow({ where: { id: "grant_takeover_frozen" } })).beneficiary_user_id === frozen.id, "canonical_upgrade_transferred_authority_grant");
  assert((await owner.prisma.teams.findUniqueOrThrow({ where: { id: "team_takeover_conflict" } })).owner_id === frozen.id, "canonical_upgrade_transferred_team_ownership");
  assert((await owner.prisma.resource_permissions.findUniqueOrThrow({ where: { id: "permission_takeover_frozen" } })).subject_ref === frozen.id, "canonical_upgrade_transferred_permission");
  for (const sourceUserId of [
    "user_takeover_permission",
    "user_takeover_provider",
    "user_takeover_access_point",
    "user_takeover_plan",
    "user_takeover_billing",
    "user_takeover_application_scope",
    "user_takeover_member_move_acl",
    "user_takeover_member_collapse_acl",
  ]) {
    const source = await owner.prisma.user_controls.findUniqueOrThrow({ where: { id: sourceUserId } });
    assert(source.status === "disabled" && source.auth_version === 2 && source.migration_freeze_reason === "identity_fact_conflict", `canonical_upgrade_opaque_source_not_frozen:${sourceUserId}`);
  }
  assert((await owner.prisma.team_memberships.findUniqueOrThrow({ where: { id: "membership_takeover_member_move_acl" } })).user_id === "user_takeover_member_move_acl", "canonical_upgrade_transferred_member_acl_membership");
  assert((await owner.prisma.team_memberships.findUniqueOrThrow({ where: { id: "membership_takeover_member_collapse_acl" } })).user_id === "user_takeover_member_collapse_acl", "canonical_upgrade_collapsed_member_acl_membership");
  assert(await migrationReferenceDigest(owner) === beforeReferenceDigest, "canonical_upgrade_changed_nontransferable_references");
  const takeoverGateway = createGatewayIdentityVerificationService(owner);
  await expectRelay("user_disabled", () => takeoverGateway.authenticateApiKey(new Headers({ authorization: `Bearer ${sensitiveFixture("takeover-api-key-value")}` })));
  assert(await owner.prisma.refresh_tokens.count({ where: { user_id: "user_takeover_frozen" } }) === 0, "canonical_upgrade_recreated_legacy_refresh");
  assert((await owner.prisma.oidc_access_tokens.findUniqueOrThrow({ where: { token_hash: sensitiveFixture("takeover-oidc-access-hash") } })).revoked_at === null, "canonical_upgrade_changed_legacy_oidc_access");
  assert((await owner.prisma.oidc_refresh_tokens.findUniqueOrThrow({ where: { token_hash: sensitiveFixture("takeover-oidc-refresh-hash") } })).revoked_at === null, "canonical_upgrade_changed_legacy_oidc_refresh");
  const legacyAuthorizationCode = await owner.prisma.oidc_authorization_codes.findUniqueOrThrow({ where: { code_hash: sensitiveFixture("takeover-oidc-code-hash") } });
  assert(legacyAuthorizationCode.consumed_at === null, "canonical_upgrade_changed_legacy_oidc_code");
  assert(await owner.prisma.webauthn_ceremonies.findUnique({ where: { session_hash: sensitiveFixture("takeover-ceremony-session-hash") } }) !== null, "canonical_upgrade_changed_legacy_ceremony");

  const terminalRecords = await owner.prisma.identity_migration_records.findMany({ where: { batch_id: batchId } });
  assert(terminalRecords.length === 24, "canonical_upgrade_append_record_count");
  assert(terminalRecords.filter((record) => record.outcome === "merged").length === 2, "canonical_upgrade_merged_record_count");
  assert(terminalRecords.filter((record) => record.outcome === "frozen").length === 9, "canonical_upgrade_frozen_record_count");
  assert(terminalRecords.filter((record) => record.outcome === "canonicalized").length === 1, "canonical_upgrade_canonicalized_record_count");
  const completedBatch = await owner.prisma.identity_migration_batches.findUniqueOrThrow({ where: { id: batchId } });
  assert(completedBatch.status === "completed_with_frozen" && completedBatch.started_at !== null && completedBatch.completed_at !== null, "canonical_upgrade_completed_batch");

  await verifyAppendOnlyMigrationFacts(owner, batchId);
  await verifyAuditFacts(owner, [
    "identity.email_upgrade.canonicalize",
    "identity.email_upgrade.merge",
    "identity.email_upgrade.freeze",
  ]);
}

async function verifyAppendOnlyMigrationFacts(owner: PostgresClientOwner, batchId: string): Promise<void> {
  const before = await migrationFactDigest(owner, batchId);
  const record = await owner.prisma.identity_migration_records.findFirstOrThrow({ where: { batch_id: batchId }, orderBy: { id: "asc" } });
  await expectPostgresCode(
    () => owner.query(`UPDATE "identity_migration_records" SET "outcome" = 'frozen' WHERE "id" = $1`, [record.id]),
    "55000",
  );
  await expectPostgresCode(
    () => owner.query(`DELETE FROM "identity_migration_records" WHERE "id" = $1`, [record.id]),
    "55000",
  );
  await expectPostgresCode(
    () => owner.query(`UPDATE "identity_migration_batches" SET "completed_at" = '2099-01-01T00:00:00.000Z' WHERE "id" = $1`, [batchId]),
    "55000",
  );
  await expectPostgresCode(
    () => owner.query(`DELETE FROM "identity_migration_batches" WHERE "id" = $1`, [batchId]),
    "55000",
  );
  assert(await migrationFactDigest(owner, batchId) === before, "identity_migration_append_only_digest_changed");

  const audit = await owner.prisma.audit_logs.findFirstOrThrow({ orderBy: { id: "asc" } });
  await expectPostgresCode(
    () => owner.query(`UPDATE "audit_logs" SET "result" = 'failure' WHERE "id" = $1`, [audit.id]),
    "55000",
  );
  await expectPostgresCode(
    () => owner.query(`DELETE FROM "audit_logs" WHERE "id" = $1`, [audit.id]),
    "55000",
  );
}

async function verifyAuditFacts(owner: PostgresClientOwner, requiredActions: readonly string[]): Promise<void> {
  const rows = await owner.prisma.audit_logs.findMany({ orderBy: [{ created_at: "asc" }, { id: "asc" }] });
  for (const action of requiredActions) assert(rows.some((row) => row.action === action), `audit_action_missing:${action}`);
  const serialized = JSON.stringify(rows);
  for (const marker of sensitiveValues) assert(!serialized.includes(marker), "sensitive_marker_present_in_audit");
  assert(!serialized.toLowerCase().includes("@example.invalid"), "email_present_in_audit");
}

async function installAuditRejectionTrigger(owner: PostgresClientOwner, action: string, resourceId: string | null): Promise<void> {
  const resourcePredicate = resourceId === null ? "TRUE" : `NEW.\"resource_id\" = ${sqlLiteral(resourceId)}`;
  await owner.query(`
    CREATE OR REPLACE FUNCTION "identity_tenancy_verification_reject_audit"() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW."action" = ${sqlLiteral(action)} AND ${resourcePredicate} THEN
        RAISE EXCEPTION 'verification audit persistence unavailable' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS "identity_tenancy_verification_reject_audit" ON "audit_logs";
    CREATE TRIGGER "identity_tenancy_verification_reject_audit"
      BEFORE INSERT ON "audit_logs" FOR EACH ROW
      EXECUTE FUNCTION "identity_tenancy_verification_reject_audit"();
  `);
}

async function removeAuditRejectionTrigger(owner: PostgresClientOwner): Promise<void> {
  await owner.query(`
    DROP TRIGGER IF EXISTS "identity_tenancy_verification_reject_audit" ON "audit_logs";
    DROP FUNCTION IF EXISTS "identity_tenancy_verification_reject_audit"();
  `);
}

function sourceEvidence(): { head: string; clean: boolean } {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: join(packageRoot, "../.."), encoding: "utf8" });
  const status = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: join(packageRoot, "../.."), encoding: "utf8" });
  assert(head.status === 0 && /^[0-9a-f]{40}$/u.test(head.stdout.trim()), "source_head_unavailable");
  assert(status.status === 0, "source_status_unavailable");
  return { head: head.stdout.trim(), clean: status.stdout.length === 0 };
}

async function assertVerificationArtifactsExcluded(): Promise<void> {
  for (const path of [
    join(applicationPackageRoot, "dist", "identity-tenancy-offline.js"),
    join(applicationPackageRoot, "dist", "identity-tenancy-offline.d.ts"),
    join(packageRoot, "dist", "identity-tenancy-verification.js"),
    join(packageRoot, "dist", "identity-tenancy-verification.d.ts"),
  ]) {
    try {
      await access(path);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    throw new Error("verification_only_artifact_present");
  }
}

async function loadMigrations(): Promise<Migration[]> {
  const names = (await readdir(migrationsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert(names.length > 0, "migration_set_empty");
  return Promise.all(names.map(async (name) => {
    assert(/^\d{14}_[a-z0-9_]+$/u.test(name), "migration_name_invalid");
    const sql = await readFile(join(migrationsRoot, name, "migration.sql"), "utf8");
    return { name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
  }));
}

function deployPrisma(runtime: PostgresVerificationRuntime, database: string): void {
  const connectionString = runtime.connectionString(database);
  run("bun", [prismaBinPath, "migrate", "deploy", "--config", prismaConfigPath], {
    ...process.env,
    FRIDAY_RELAY_PG_CONNECTION_STRING: connectionString,
  }, runtime);
  run("bun", [prismaBinPath, "migrate", "status", "--config", prismaConfigPath], {
    ...process.env,
    FRIDAY_RELAY_PG_CONNECTION_STRING: connectionString,
  }, runtime);
}

function assertExactMigrationHistory(runtime: PostgresVerificationRuntime, database: string, expected: readonly Migration[]): void {
  const actual = runtime.queryScalar(database, `
    SELECT string_agg("migration_name" || ':' || "checksum", E'\\n' ORDER BY "migration_name")
    FROM "_prisma_migrations"
    WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL
  `);
  const expectedValue = expected.map((migration) => `${migration.name}:${migration.checksum}`).join("\n");
  assert(actual === expectedValue, "exact_migration_history_invalid");
  assert(runtime.queryScalar(database, `SELECT count(*)::text FROM "_prisma_migrations" WHERE "finished_at" IS NULL AND "rolled_back_at" IS NULL`) === "0", "failed_migration_history_present");
}

function assertSchemaParity(runtime: PostgresVerificationRuntime, leftDatabase: string, rightDatabase: string): void {
  const left = normalizedSchemaDump(runtime, leftDatabase);
  const right = normalizedSchemaDump(runtime, rightDatabase);
  if (left !== right) {
    throw new Error(`identity_tenancy_schema_parity_mismatch:left=${sha256Text(left)}:right=${sha256Text(right)}`);
  }
}

function normalizedSchemaDump(runtime: PostgresVerificationRuntime, database: string): string {
  return runtime.schemaDump(database)
    .split("\n")
    .filter((line) => !line.startsWith("\\restrict ") && !line.startsWith("\\unrestrict "))
    .join("\n");
}

function identityTenancySchemaProjection(runtime: PostgresVerificationRuntime, database: string): Array<Record<string, unknown>> {
  const value = runtime.queryScalar(database, `
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'table', table_name,
      'column', column_name,
      'type', data_type,
      'nullable', is_nullable,
      'default', column_default
    ) ORDER BY table_name, ordinal_position), '[]'::jsonb)::text
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN (
        'users', 'user_controls', 'user', 'account', 'session', 'verification', 'api_keys', 'refresh_tokens', 'oidc_authorization_codes', 'oidc_access_tokens',
        'oidc_refresh_tokens', 'passkey_credentials', 'webauthn_user_handles', 'webauthn_ceremonies',
        'teams', 'team_memberships', 'team_invite_links', 'resource_permissions'
      )
  `);
  const parsed = JSON.parse(value) as unknown;
  assert(Array.isArray(parsed), "identity_tenancy_schema_projection_invalid");
  return parsed as Array<Record<string, unknown>>;
}

function assertAdditiveIdentityTenancyProjection(before: Array<Record<string, unknown>>, after: Array<Record<string, unknown>>): void {
  const projectionKey = (row: Record<string, unknown>): string => {
    const table = row.table === "users" ? "user_controls" : row.table;
    return JSON.stringify({ table, column: row.column, type: row.type });
  };
  const afterRows = new Set(after.map(projectionKey));
  for (const row of before) assert(afterRows.has(projectionKey(row)), "identity_tenancy_takeover_not_additive");
  assert(after.length > before.length, "identity_tenancy_takeover_projection_not_expanded");
}

function dockerOnlyEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    [verificationPostgresAdminUrlEnvironment]: "",
    [verificationPostgresDisposableUrlEnvironment]: "",
    [verificationPostgresNoDockerEnvironment]: "",
  };
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function prismaHistoryTableSql(): string {
  return `CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
    "id" varchar(36) PRIMARY KEY NOT NULL,
    "checksum" varchar(64) NOT NULL,
    "finished_at" timestamptz,
    "migration_name" varchar(255) NOT NULL,
    "logs" text,
    "rolled_back_at" timestamptz,
    "started_at" timestamptz NOT NULL DEFAULT now(),
    "applied_steps_count" integer NOT NULL DEFAULT 0
  );`;
}

function successfulHistorySql(migration: Migration, index: number): string {
  assert(/^[0-9a-f]{64}$/u.test(migration.checksum), "migration_checksum_invalid");
  const timestamp = new Date(Date.UTC(2020, 0, 1, 0, index)).toISOString();
  return `INSERT INTO "_prisma_migrations"
    ("id", "checksum", "finished_at", "migration_name", "logs", "rolled_back_at", "started_at", "applied_steps_count")
    VALUES (${sqlLiteral(randomUUID())}, ${sqlLiteral(migration.checksum)}, ${sqlLiteral(timestamp)}, ${sqlLiteral(migration.name)}, NULL, NULL, ${sqlLiteral(timestamp)}, 1);`;
}

function takeoverFixtureSql(): string {
  const passwordHash = sensitiveFixture("takeover-password-hash");
  const keyValue = sensitiveFixture("takeover-api-key-value");
  const keyHash = sensitive(sha256(keyValue));
  const oidcCodeHash = sensitiveFixture("takeover-oidc-code-hash");
  const oidcAccessHash = sensitiveFixture("takeover-oidc-access-hash");
  const oidcRefreshHash = sensitiveFixture("takeover-oidc-refresh-hash");
  const ceremonySession = sensitiveFixture("takeover-ceremony-session-hash");
  const ceremonyChallenge = sensitiveFixture("takeover-ceremony-challenge-hash");
  for (const email of [
    " Upgrade@Example.INVALID ",
    "upgrade@example.invalid",
    "UPGRADE@example.invalid",
    "UpGrade@Example.Invalid",
    " Single@Example.INVALID ",
  ]) sensitive(email);
  return `
    INSERT INTO "users" (
      "id", "team_id", "email", "password_hash", "auth_version", "status", "admin_note", "api_key_limit",
      "user_can_create_custom_provider", "user_can_create_access_point", "created_at", "updated_at"
    ) VALUES
      ('user_takeover_survivor', NULL, ' Upgrade@Example.INVALID ', ${sqlLiteral(passwordHash)}, 1, 'enabled', NULL, 3, 0, 0, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z'),
      ('user_takeover_merge_unique', NULL, 'upgrade@example.invalid', ${sqlLiteral(passwordHash)}, 1, 'enabled', NULL, 3, 0, 0, '2020-01-02T00:00:00.000Z', '2020-01-02T00:00:00.000Z'),
      ('user_takeover_merge_duplicate', NULL, 'UPGRADE@example.invalid', ${sqlLiteral(passwordHash)}, 1, 'enabled', NULL, 3, 0, 0, '2020-01-03T00:00:00.000Z', '2020-01-03T00:00:00.000Z'),
      ('user_takeover_frozen', NULL, 'UpGrade@Example.Invalid', ${sqlLiteral(passwordHash)}, 1, 'enabled', NULL, 3, 0, 0, '2020-01-04T00:00:00.000Z', '2020-01-04T00:00:00.000Z'),
      ('user_takeover_singleton', NULL, ' Single@Example.INVALID ', ${sqlLiteral(passwordHash)}, 1, 'enabled', NULL, 3, 0, 0, '2020-01-05T00:00:00.000Z', '2020-01-05T00:00:00.000Z');

    INSERT INTO "teams" (
      "id", "owner_id", "name", "status", "team_owner_can_manage_member_api_key_limit", "team_owner_can_manage_member_credit",
      "team_owner_can_create_custom_provider", "team_owner_can_create_access_point", "invite_email_domain_pattern", "created_at", "updated_at"
    ) VALUES
      ('team_takeover_shared', 'user_takeover_survivor', 'Shared takeover Team', 'enabled', 0, 0, 0, 0, NULL, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z'),
      ('team_takeover_transfer', 'user_takeover_survivor', 'Transfer takeover Team', 'enabled', 0, 0, 0, 0, NULL, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z'),
      ('team_takeover_conflict', 'user_takeover_frozen', 'Conflict takeover Team', 'enabled', 0, 0, 0, 0, NULL, '2020-01-04T00:00:00.000Z', '2020-01-04T00:00:00.000Z');

    INSERT INTO "team_memberships" ("id", "team_id", "user_id", "roles_json", "by_invite_link", "created_at", "updated_at") VALUES
      ('membership_takeover_survivor', 'team_takeover_shared', 'user_takeover_survivor', '["viewer"]', NULL, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z'),
      ('membership_takeover_duplicate', 'team_takeover_shared', 'user_takeover_merge_duplicate', '["viewer"]', NULL, '2020-01-03T00:00:00.000Z', '2020-01-03T00:00:00.000Z'),
      ('membership_takeover_transfer', 'team_takeover_transfer', 'user_takeover_merge_unique', '["viewer"]', NULL, '2020-01-02T00:00:00.000Z', '2020-01-02T00:00:00.000Z'),
      ('membership_takeover_frozen', 'team_takeover_conflict', 'user_takeover_frozen', '["viewer"]', NULL, '2020-01-04T00:00:00.000Z', '2020-01-04T00:00:00.000Z');

    INSERT INTO "api_keys" ("id", "user_id", "name", "key_hash", "key_prefix", "key_value", "status", "expires_at", "revoked_at", "created_at", "updated_at")
    VALUES ('key_takeover_frozen', 'user_takeover_frozen', 'Frozen takeover key', ${sqlLiteral(keyHash)}, 'takeover-k', ${sqlLiteral(keyValue)}, 'enabled', NULL, NULL, '2020-01-04T00:00:00.000Z', '2020-01-04T00:00:00.000Z');

    INSERT INTO "authority_grants" (
      "id", "beneficiary_user_id", "role_domain", "role_code", "role_scope_id", "source_kind", "source_purchase_id",
      "source_product_code_snapshot", "source_product_version_snapshot", "source_origin_id_snapshot", "max_current_owned_teams_snapshot",
      "max_lifetime_created_teams_snapshot", "issued_by_user_id", "effective_start", "effective_end", "lifecycle", "canceled_at",
      "canceled_by_user_id", "cancel_reason_code", "created_at"
    ) VALUES (
      'grant_takeover_frozen', 'user_takeover_frozen', 'platform', 'owner', NULL, 'system_bootstrap', NULL,
      NULL, NULL, NULL, NULL, NULL, NULL, '2000-01-01T00:00:00.000Z', NULL, 'active', NULL, NULL, NULL, '2020-01-04T00:00:00.000Z'
    );

    INSERT INTO "resource_permissions" ("id", "resource_type", "resource_id", "action", "subject_type", "subject_ref", "subject_role", "status", "created_at", "updated_at")
    VALUES ('permission_takeover_frozen', 'team', 'team_takeover_conflict', 'team.read', 'user', 'user_takeover_frozen', NULL, 'enabled', '2020-01-04T00:00:00.000Z', '2020-01-04T00:00:00.000Z');

    INSERT INTO "oidc_authorization_codes" ("id", "code_hash", "user_id", "client_id", "redirect_uri", "scope", "code_challenge", "nonce", "created_at", "expires_at", "consumed_at")
    VALUES ('oidc_code_takeover_frozen', ${sqlLiteral(oidcCodeHash)}, 'user_takeover_frozen', 'takeover-client', 'https://client.example.invalid/callback', 'openid', 'takeover-challenge', 'takeover-nonce', '2020-01-04T00:00:00.000Z', '2099-01-01T00:00:00.000Z', NULL);
    INSERT INTO "oidc_access_tokens" ("id", "token_hash", "user_id", "client_id", "audience", "scope", "created_at", "expires_at", "revoked_at")
    VALUES ('oidc_access_takeover_frozen', ${sqlLiteral(oidcAccessHash)}, 'user_takeover_frozen', 'takeover-client', 'takeover-client', 'openid', '2020-01-04T00:00:00.000Z', '2099-01-01T00:00:00.000Z', NULL);
    INSERT INTO "oidc_refresh_tokens" ("id", "token_hash", "family_id", "user_id", "client_id", "scope", "created_at", "expires_at", "consumed_at", "revoked_at", "replaced_by_id")
    VALUES ('oidc_refresh_takeover_frozen', ${sqlLiteral(oidcRefreshHash)}, 'takeover-family', 'user_takeover_frozen', 'takeover-client', 'openid', '2020-01-04T00:00:00.000Z', '2099-01-01T00:00:00.000Z', NULL, NULL, NULL);
    INSERT INTO "webauthn_ceremonies" ("session_hash", "challenge_hash", "purpose", "surface", "user_id", "expected_auth_version", "rp_id", "origin", "passkey_name", "expires_at", "created_at")
    VALUES (${sqlLiteral(ceremonySession)}, ${sqlLiteral(ceremonyChallenge)}, 'registration', 'web', 'user_takeover_frozen', 1, 'example.invalid', 'https://example.invalid', 'Takeover Passkey', '2099-01-01T00:00:00.000Z', '2020-01-04T00:00:00.000Z');
  `;
}

function verifierConfig(): AppConfig {
  const jwtSecret = sensitive("identity-verification-jwt-secret-46");
  return parseConfig({
    app: { name: "Frely", environment: "test", publicBaseUrl: "http://localhost:43001", reservedHostnames: [] },
    database: { backend: "postgres" },
    archive: { directory: "/tmp/friday-relay-identity-verification", requireColdMount: true, history: { enabled: false, autoPurge: false } },
    requestCapture: {
      hotDays: 90,
      archive: { enabled: false, autoPurge: false, purgeBatchSize: 200, zstdLevel: 6, frameUncompressedBytes: 67_108_864 },
      download: { maxFiles: 10_000, maxCompressedBytes: 1_073_741_824 },
    },
    requestExecution: { leaseTtlSeconds: 1_800 },
    security: { abuseRateLimit: {} },
    auth: {
      accessTokenTtlSeconds: 900,
      refreshTokenTtlSeconds: 2_592_000,
      jwtSecret,
      cookieSecure: false,
      passkey: { enabled: false },
    },
    web: { host: "127.0.0.1", port: 43_001 },
    admin: { host: "127.0.0.1", port: 43_002 },
    gateway: { host: "127.0.0.1", port: 43_000, maxRequestBodyBytes: 16_777_216, ingressRouteAttestationMode: "observe" },
    providers: [],
    logging: { level: "error", redactKeys: [] },
    bootstrap: { enabled: true, ownerEmail: "identity-owner@example.invalid" },
  });
}

async function migrationReferenceDigest(owner: PostgresClientOwner): Promise<string> {
  const projection = await Promise.all([
    owner.prisma.api_keys.findMany({ orderBy: { id: "asc" }, select: { id: true, user_id: true, status: true, revoked_at: true } }),
    owner.prisma.authority_grants.findMany({ orderBy: { id: "asc" }, select: { id: true, beneficiary_user_id: true, lifecycle: true, role_domain: true, role_code: true } }),
    owner.prisma.teams.findMany({ orderBy: { id: "asc" }, select: { id: true, owner_id: true, status: true } }),
    owner.prisma.resource_permissions.findMany({ orderBy: { id: "asc" }, select: { id: true, resource_type: true, resource_id: true, subject_type: true, subject_ref: true, subject_role: true, status: true } }),
    owner.prisma.providers.findMany({ orderBy: { id: "asc" }, select: {
      id: true,
      owner_id: true,
      scope_ref: true,
      provider_bindings: { select: { credential_ownership: true, credential_refs_json: true, credential_preview: true, revision: true } },
    } }),
    owner.prisma.accessPoint.findMany({ orderBy: { id: "asc" }, select: { id: true, ownerId: true, scopeRef: true, status: true, removedAt: true } }),
    owner.prisma.plans.findMany({ orderBy: { id: "asc" }, select: { id: true, owner_id: true, scope_ref: true, plan_status: true } }),
    owner.prisma.credit_accounts.findMany({ orderBy: { id: "asc" }, select: { id: true, scope_ref: true, status: true } }),
    owner.prisma.ingress_plugin_settings.findMany({ orderBy: { id: "asc" }, select: { id: true, scope_ref: true, enabled: true } }),
  ]);
  return createHash("sha256").update(JSON.stringify(projection)).digest("hex");
}

async function migrationFactDigest(owner: PostgresClientOwner, batchId: string): Promise<string> {
  const result = await owner.query<{ digest: string }>(`
    SELECT md5(string_agg(to_jsonb(record_row)::text, '' ORDER BY record_row."id")) AS digest
    FROM "identity_migration_records" record_row WHERE record_row."batch_id" = $1
  `, [batchId]);
  return result.rows[0]?.digest ?? "";
}

function sensitiveFixture(label: string): string {
  return sensitive(`identity-verification-${label}`);
}

function sensitive(value: string): string {
  sensitiveValues.add(value);
  return value;
}

type LegacyAuthStateCounts = Readonly<{
  refreshTokens: number;
  oidcAuthorizationCodes: number;
  oidcAccessTokens: number;
  oidcRefreshTokens: number;
  passkeys: number;
  webauthnHandles: number;
  webauthnCeremonies: number;
}>;

async function legacyAuthStateCounts(owner: PostgresClientOwner, userId: string): Promise<LegacyAuthStateCounts> {
  const [refreshTokens, oidcAuthorizationCodes, oidcAccessTokens, oidcRefreshTokens, passkeys, webauthnHandles, webauthnCeremonies] = await Promise.all([
    owner.prisma.refresh_tokens.count({ where: { user_id: userId } }),
    owner.prisma.oidc_authorization_codes.count({ where: { user_id: userId } }),
    owner.prisma.oidc_access_tokens.count({ where: { user_id: userId } }),
    owner.prisma.oidc_refresh_tokens.count({ where: { user_id: userId } }),
    owner.prisma.passkey_credentials.count({ where: { user_id: userId } }),
    owner.prisma.webauthn_user_handles.count({ where: { user_id: userId } }),
    owner.prisma.webauthn_ceremonies.count({ where: { user_id: userId } }),
  ]);
  return { refreshTokens, oidcAuthorizationCodes, oidcAccessTokens, oidcRefreshTokens, passkeys, webauthnHandles, webauthnCeremonies };
}

function sameLegacyAuthStateCounts(left: LegacyAuthStateCounts, right: LegacyAuthStateCounts): boolean {
  return left.refreshTokens === right.refreshTokens
    && left.oidcAuthorizationCodes === right.oidcAuthorizationCodes
    && left.oidcAccessTokens === right.oidcAccessTokens
    && left.oidcRefreshTokens === right.oidcRefreshTokens
    && left.passkeys === right.passkeys
    && left.webauthnHandles === right.webauthnHandles
    && left.webauthnCeremonies === right.webauthnCeremonies;
}

function cookieValue(setCookieHeaders: readonly string[], name: string): string {
  const header = setCookieHeaders.find((value) => value.startsWith(`${name}=`));
  if (!header) throw new Error(`identity_tenancy_cookie_missing:${name}`);
  return header.split(";", 1)[0]!;
}

function sensitiveSession(session: { accessToken: string; refreshToken: string }): void {
  sensitive(session.accessToken);
  sensitive(session.refreshToken);
  sensitive(sha256(session.refreshToken));
}

function futureIso(seconds: number): string {
  return new Date(Date.now() + seconds * 1_000).toISOString();
}

async function runLockCoordinatedSettledRace<T>(
  owner: PostgresClientOwner,
  input: {
    name: string;
    relation: string;
    lockSql: string;
    lockValues: readonly unknown[];
    participants: readonly (() => Promise<T>)[];
  },
): Promise<PromiseSettledResult<T>[]> {
  assert(input.participants.length >= 2, "postgres_race_participants_invalid");
  let pending: Promise<PromiseSettledResult<T>[]> | undefined;
  try {
    await owner.withTransaction(async (blocker) => {
      const locked = await blocker.query(input.lockSql, input.lockValues);
      assert(locked.rowCount === 1, "postgres_race_lock_target_missing");
      pending = Promise.allSettled(input.participants.map((participant) => participant()));
      const deadline = Date.now() + 2_000;
      let maximumWaiting = 0;
      while (Date.now() < deadline) {
        const waiting = await blocker.query<{ count: number }>(`
          SELECT COUNT(*)::int AS "count"
          FROM pg_stat_activity AS activity
          WHERE activity."datname" = current_database()
            AND activity."pid" <> pg_backend_pid()
            AND activity."wait_event_type" = 'Lock'
            AND activity."application_name" = 'friday-relay-identity-tenancy-verification-fresh'
        `);
        maximumWaiting = Math.max(maximumWaiting, waiting.rows[0]?.count ?? 0);
        if (maximumWaiting >= input.participants.length) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`postgres_race_overlap_not_observed:${input.name}:maximum_waiting=${maximumWaiting}`);
    });
  } catch (error) {
    if (pending) await pending;
    throw error;
  }
  assert(pending !== undefined, "postgres_race_not_started");
  return pending;
}

function fulfilled<T>(results: readonly PromiseSettledResult<T>[]): T[] {
  return results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
}

function assertRejectedRelay<T>(results: readonly PromiseSettledResult<T>[], code: string, count: number): void {
  const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  assert(rejected.length === count, `relay_rejection_count:${code}`);
  assert(rejected.every((result) => relayErrorCode(result.reason) === code), `relay_rejection_code:${code}`);
}

async function expectRelay(code: string, callback: () => Promise<unknown>): Promise<void> {
  try {
    await callback();
  } catch (error) {
    const actualCode = relayErrorCode(error);
    if (actualCode === code) return;
    throw new Error(`identity_tenancy_unexpected_relay_error:${code}:${actualCode ?? "missing"}`);
  }
  throw new Error(`identity_tenancy_expected_relay_error:${code}`);
}

function relayErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

async function expectFailure(callback: () => Promise<unknown>): Promise<void> {
  try {
    await callback();
  } catch {
    return;
  }
  throw new Error("identity_tenancy_expected_failure");
}

async function expectPostgresCode(callback: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await callback();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && String(error.code) === code) return;
    throw error;
  }
  throw new Error(`identity_tenancy_expected_postgres_error:${code}`);
}

function assert(condition: boolean, name: string): asserts condition {
  if (!condition) throw new Error(`identity_tenancy_assertion_failed:${name}`);
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function run(command: string, args: string[], environment: NodeJS.ProcessEnv, runtime: PostgresVerificationRuntime): void {
  const result = spawnSync(command, args, {
    cwd: packageRoot,
    env: environment,
    encoding: "utf8",
    maxBuffer: maximumCommandOutputBytes,
  });
  if (result.status !== 0) {
    const detail = runtime.redact([result.stdout, result.stderr].filter(Boolean).join("\n").trim());
    throw new Error(`identity_tenancy_${command}_failed:${result.status ?? "signal"}${detail ? `\n${detail}` : ""}`);
  }
}

function redactFailure(error: unknown): string {
  let detail = error instanceof Error ? error.message : String(error);
  detail = activeRuntime?.redact(detail) ?? detail;
  for (const marker of [...sensitiveValues].sort((left, right) => right.length - left.length)) {
    if (marker) detail = detail.replaceAll(marker, "[REDACTED]");
  }
  return detail
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[REDACTED_EMAIL]")
    .replace(/sk-[A-Za-z0-9_-]+/gu, "[REDACTED]")
    .replace(/scrypt:[A-Fa-f0-9:]+/gu, "[REDACTED]");
}

try {
  await main();
} catch (error) {
  process.stderr.write(`identity_tenancy_verification_failed:${redactFailure(error)}\n`);
  process.exitCode = 1;
}
