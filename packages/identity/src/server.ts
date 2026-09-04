import { createHash } from "node:crypto";
import { createId, nowIso, RelayError } from "@frely/core";
import { PrismaAuditEventAppender, type AuditEventAppender } from "@frely/audit/application-internal";
import type { AuditMetadataValue, IdentityTenancyAuditAction, IdentityTenancyAuditEventDraft } from "@frely/audit";
import type { Prisma, PrismaTransactionOwner } from "@frely/postgres/server";
import {
  canonicalEmailFingerprint,
  decideCanonicalEmailUpgrade,
  EmailAddr,
  type ApiKeySnapshot,
  type IdentityMigrationCandidate,
  type IdentityMigrationConflict,
  type OidcAccessTokenSnapshot,
  type OidcAuthorizationCodeSnapshot,
  type OidcRefreshTokenSnapshot,
  type PasskeyCredentialSnapshot,
  type RefreshTokenSnapshot,
  type UserAccessDecision,
  type UserSnapshot,
  type WebAuthnCeremonySnapshot,
  type WebAuthnUserHandleSnapshot,
} from "./index.js";
import type {
  CanonicalEmailUpgradeGroup,
  CanonicalEmailUpgradePreflight,
  CanonicalEmailUpgradeResult,
  IdentityAuditInput,
  IdentityContextCommands,
  IdentityContextQueries,
} from "./contracts.js";

export * from "./index.js";
export type * from "./contracts.js";

type PrismaIdentityClient = Prisma.TransactionClient;
type RootIdentityClient = PrismaTransactionOwner & { prisma: PrismaIdentityClient };

abstract class IdentityInfrastructure {
  constructor(protected readonly root: RootIdentityClient, protected readonly transaction?: PrismaIdentityClient) {}

  protected client(): PrismaIdentityClient {
    return this.transaction ?? this.root.prisma;
  }
}

/** Identity-owned named Queries over the Prisma schema. */
export class IdentityQueries extends IdentityInfrastructure implements IdentityContextQueries {
  constructor(root: RootIdentityClient, transaction?: PrismaIdentityClient) {
    super(root, transaction);
  }

  async getUser(userId: string): Promise<UserSnapshot | undefined> {
    const row = await this.client().user_controls.findUnique({
      where: { id: userId },
      include: { identity: { include: { accounts: { where: { providerId: "credential", issuer: "local:credential" }, select: { password: true }, take: 1 } } } },
    });
    return row?.identity ? userSnapshot(row, row.identity.email, row.identity.accounts[0]?.password ?? "") : undefined;
  }

  async listUsers(): Promise<UserSnapshot[]> {
    const rows = await this.client().user_controls.findMany({
      orderBy: [{ created_at: "asc" }, { id: "asc" }],
      include: { identity: { include: { accounts: { where: { providerId: "credential", issuer: "local:credential" }, select: { password: true }, take: 1 } } } },
    });
    return rows.flatMap((row) => row.identity ? [userSnapshot(row, row.identity.email, row.identity.accounts[0]?.password ?? "")] : []);
  }

  async findUserByEmail(email: EmailAddr): Promise<UserSnapshot | undefined> {
    const row = await this.client().user.findUnique({
      where: { email: email.value },
      include: {
        controls: true,
        accounts: { where: { providerId: "credential", issuer: "local:credential" }, select: { password: true }, take: 1 },
      },
    });
    return row ? userSnapshot(row.controls, row.email, row.accounts[0]?.password ?? "") : undefined;
  }

  async decideUserAccess(userId: string): Promise<UserAccessDecision | undefined> {
    const row = await this.client().user_controls.findUnique({ where: { id: userId }, select: { id: true, status: true, auth_version: true } });
    return row ? { userRef: row.id, enabled: row.status === "enabled", authVersion: row.auth_version } : undefined;
  }

  async getApiKey(apiKeyId: string): Promise<ApiKeySnapshot | undefined> {
    const row = await this.client().api_keys.findUnique({ where: { id: apiKeyId } });
    return row ? apiKeySnapshot(row) : undefined;
  }

  async findApiKeyByHash(keyHash: string): Promise<ApiKeySnapshot | undefined> {
    const row = await this.client().api_keys.findUnique({ where: { key_hash: keyHash } });
    return row ? apiKeySnapshot(row) : undefined;
  }

  async listApiKeys(userId?: string): Promise<ApiKeySnapshot[]> {
    return (await this.client().api_keys.findMany({
      ...(userId === undefined ? {} : { where: { user_id: userId } }),
      orderBy: [{ created_at: "asc" }, { id: "asc" }],
    })).map(apiKeySnapshot);
  }

  async countEnabledApiKeysForUser(userId: string): Promise<number> {
    return this.client().api_keys.count({ where: { user_id: userId, status: "enabled", revoked_at: null } });
  }

  async findFirstEnabledApiKeyForUser(userId: string): Promise<ApiKeySnapshot | undefined> {
    const row = await this.client().api_keys.findFirst({
      where: { user_id: userId, status: "enabled", revoked_at: null },
      orderBy: [{ created_at: "asc" }, { id: "asc" }],
    });
    return row ? apiKeySnapshot(row) : undefined;
  }

  async getOidcAuthorizationCodeByHash(codeHash: string): Promise<OidcAuthorizationCodeSnapshot | undefined> {
    const row = await this.client().oidc_authorization_codes.findUnique({ where: { code_hash: codeHash } });
    return row ? oidcAuthorizationCodeSnapshot(row) : undefined;
  }

  async getOidcAccessTokenByHash(tokenHash: string): Promise<OidcAccessTokenSnapshot | undefined> {
    const row = await this.client().oidc_access_tokens.findUnique({ where: { token_hash: tokenHash } });
    return row ? oidcAccessTokenSnapshot(row) : undefined;
  }

  async getOidcRefreshTokenByHash(tokenHash: string): Promise<OidcRefreshTokenSnapshot | undefined> {
    const row = await this.client().oidc_refresh_tokens.findUnique({ where: { token_hash: tokenHash } });
    return row ? oidcRefreshTokenSnapshot(row) : undefined;
  }

  async getRefreshTokenByHash(tokenHash: string): Promise<RefreshTokenSnapshot | undefined> {
    const row = await this.client().refresh_tokens.findUnique({ where: { token_hash: tokenHash } });
    return row ? refreshTokenSnapshot(row) : undefined;
  }

  async getWebAuthnUserHandle(userId: string): Promise<WebAuthnUserHandleSnapshot | undefined> {
    const row = await this.client().webauthn_user_handles.findUnique({ where: { user_id: userId } });
    return row ? { userId: row.user_id, userHandle: row.user_handle, createdAt: row.created_at } : undefined;
  }

  async listPasskeyCredentials(userId: string, rpId?: string): Promise<PasskeyCredentialSnapshot[]> {
    return (await this.client().passkey_credentials.findMany({
      where: { user_id: userId, ...(rpId === undefined ? {} : { rp_id: rpId }) },
      orderBy: [{ created_at: "asc" }, { id: "asc" }],
    })).map(passkeySnapshot);
  }

  async findPasskeyByCredentialId(credentialId: string): Promise<PasskeyCredentialSnapshot | undefined> {
    const row = await this.client().passkey_credentials.findUnique({ where: { credential_id: credentialId } });
    return row ? passkeySnapshot(row) : undefined;
  }
}

/** Identity-owned named Commands. Every root operation owns its Prisma transaction. */
export class IdentityCommands extends IdentityInfrastructure implements IdentityContextCommands {
  private readonly queries: IdentityQueries;

  constructor(
    root: RootIdentityClient,
    transaction?: PrismaIdentityClient,
    private readonly auditAppender: AuditEventAppender = new PrismaAuditEventAppender(),
  ) {
    super(root, transaction);
    this.queries = new IdentityQueries(root, transaction);
  }

  private run<T>(callback: (commands: IdentityCommands) => Promise<T>, maxAttempts = 3): Promise<T> {
    if (this.transaction) return callback(this);
    return this.root.withPrismaTransaction(
      (transaction) => callback(new IdentityCommands(this.root, transaction, this.auditAppender)),
      maxAttempts,
    );
  }

  async createUser(input: {
    id?: string;
    teamId: string | null;
    email: EmailAddr;
    passwordHash: string;
    status?: string;
    authVersion?: number;
    adminNote?: string | null;
    apiKeyLimit?: number;
    userCanCreateCustomProvider?: number;
    userCanCreateAccessPoint?: number;
    createdAt?: string;
  }): Promise<UserSnapshot> {
    return this.run(async (commands) => {
      const now = nowIso();
      const userId = input.id ?? createId("user");
      try {
        const row = await commands.client().user_controls.create({ data: {
          id: userId,
          team_id: input.teamId,
          auth_version: input.authVersion ?? 1,
          status: input.status ?? "enabled",
          admin_note: input.adminNote ?? null,
          api_key_limit: input.apiKeyLimit ?? 3,
          user_can_create_custom_provider: input.userCanCreateCustomProvider ?? 0,
          user_can_create_access_point: input.userCanCreateAccessPoint ?? 0,
          created_at: input.createdAt ?? now,
          updated_at: now,
        } });
        const createdAt = new Date(input.createdAt ?? now);
        const updatedAt = new Date(now);
        await commands.client().user.create({
          data: {
            id: userId,
            name: `Friday User ${userId}`,
            email: input.email.value,
            emailVerified: false,
            image: null,
            createdAt,
            updatedAt,
          },
        });
        await commands.client().account.create({
          data: {
            id: `auth_account_${userId}`,
            accountId: userId,
            providerId: "credential",
            userId,
            issuer: "local:credential",
            password: input.passwordHash,
            createdAt,
            updatedAt,
          },
        });
        return (await commands.queries.getUser(userId))!;
      } catch (error) {
        if (isUniqueConstraint(error)) throw new RelayError("email_already_registered", "Email is already registered", 409);
        throw error;
      }
    });
  }

  async updateUserProfile(userId: string, input: { adminNote?: string | null; userCanCreateCustomProvider?: number; userCanCreateAccessPoint?: number }): Promise<UserSnapshot | undefined> {
    return this.run(async (commands) => {
      const exists = await commands.client().user_controls.findUnique({ where: { id: userId }, select: { id: true } });
      if (!exists) return undefined;
      await commands.client().user_controls.update({ where: { id: userId }, data: {
        ...(input.adminNote === undefined ? {} : { admin_note: input.adminNote }),
        ...(input.userCanCreateCustomProvider === undefined ? {} : { user_can_create_custom_provider: input.userCanCreateCustomProvider }),
        ...(input.userCanCreateAccessPoint === undefined ? {} : { user_can_create_access_point: input.userCanCreateAccessPoint }),
        updated_at: nowIso(),
      } });
      return (await commands.queries.getUser(userId))!;
    });
  }

  async updateUserApiKeyLimit(userId: string, apiKeyLimit: number): Promise<UserSnapshot | undefined> {
    return this.run(async (commands) => {
      const exists = await commands.client().user_controls.findUnique({ where: { id: userId }, select: { id: true } });
      if (!exists) return undefined;
      await commands.client().user_controls.update({ where: { id: userId }, data: { api_key_limit: apiKeyLimit, updated_at: nowIso() } });
      return (await commands.queries.getUser(userId))!;
    });
  }

  async createApiKey(input: { userId: string; name: string; keyHash: string; keyPrefix: string; keyValue: string; expiresAt?: string | null }): Promise<ApiKeySnapshot> {
    return this.run(async (commands) => {
      const now = nowIso();
      return apiKeySnapshot(await commands.client().api_keys.create({ data: {
        id: createId("key"), user_id: input.userId, name: input.name,
        key_hash: input.keyHash, key_prefix: input.keyPrefix, key_value: input.keyValue,
        status: "enabled", expires_at: input.expiresAt ?? null,
        revoked_at: null, created_at: now, updated_at: now,
      } }));
    });
  }

  async revokeApiKey(apiKeyId: string): Promise<ApiKeySnapshot | undefined> {
    return this.changeApiKey(apiKeyId, { status: "revoked", revoked_at: nowIso() });
  }

  async setApiKeyStatus(apiKeyId: string, status: "enabled" | "disabled"): Promise<ApiKeySnapshot | undefined> {
    return this.changeApiKey(apiKeyId, { status });
  }

  private async changeApiKey(apiKeyId: string, data: { status?: string; revoked_at?: string }): Promise<ApiKeySnapshot | undefined> {
    return this.run(async (commands) => {
      const exists = await commands.client().api_keys.findUnique({ where: { id: apiKeyId }, select: { id: true } });
      if (!exists) return undefined;
      return apiKeySnapshot(await commands.client().api_keys.update({ where: { id: apiKeyId }, data: { ...data, updated_at: nowIso() } }));
    });
  }

  async createRefreshTokenForAuthVersion(input: { userId: string; expectedAuthVersion: number; tokenHash: string; expiresAt: string }): Promise<RefreshTokenSnapshot> {
    void input;
    throw retiredAuthenticationMethod("Friday refresh-token authentication has been retired");
    return this.run(async (commands) => {
      await commands.assertEnabledAuthVersion(input.userId, input.expectedAuthVersion);
      return refreshTokenSnapshot(await commands.client().refresh_tokens.create({ data: {
        id: createId("rt"), user_id: input.userId, token_hash: input.tokenHash,
        expires_at: input.expiresAt, revoked_at: null, created_at: nowIso(),
      } }));
    });
  }

  async rotateRefreshToken(input: { tokenHash: string; userId: string; expectedAuthVersion: number; replacementTokenHash: string; replacementExpiresAt: string }): Promise<RefreshTokenSnapshot | undefined> {
    void input;
    throw retiredAuthenticationMethod("Friday refresh-token authentication has been retired");
    return this.run(async (commands) => {
      const now = nowIso();
      const user = await commands.client().user_controls.findUnique({ where: { id: input.userId }, select: { status: true, auth_version: true } });
      if (!user || user.status !== "enabled" || user.auth_version !== input.expectedAuthVersion) return undefined;
      const consumed = await commands.client().refresh_tokens.updateMany({
        where: { token_hash: input.tokenHash, user_id: input.userId, revoked_at: null, expires_at: { gt: now } },
        data: { revoked_at: now },
      });
      if (consumed.count !== 1) return undefined;
      return refreshTokenSnapshot(await commands.client().refresh_tokens.create({ data: {
        id: createId("rt"), user_id: input.userId, token_hash: input.replacementTokenHash,
        expires_at: input.replacementExpiresAt, revoked_at: null, created_at: now,
      } }));
    });
  }

  async revokeRefreshToken(tokenHash: string): Promise<void> {
    void tokenHash;
    throw retiredAuthenticationMethod("Friday refresh-token authentication has been retired");
    await this.run(async (commands) => {
      await commands.client().refresh_tokens.updateMany({ where: { token_hash: tokenHash, revoked_at: null }, data: { revoked_at: nowIso() } });
    });
  }

  async rotateOwnPassword(input: { userId: string; expectedPasswordHash: string; newPasswordHash: string; newRefreshTokenHash: string; newRefreshTokenExpiresAt: string; surface: "web" | "owner"; requestId?: string | null }): Promise<UserSnapshot> {
    void input;
    throw retiredAuthenticationMethod("Friday JWT password changes have been retired; use Better Auth");
    return this.run(async (commands) => {
      const now = nowIso();
      const updated = await commands.client().account.updateMany({
        where: {
          userId: input.userId,
          accountId: input.userId,
          providerId: "credential",
          issuer: "local:credential",
          password: input.expectedPasswordHash,
        },
        data: { password: input.newPasswordHash, updatedAt: new Date(now) },
      });
      if (updated.count !== 1) throw new RelayError("current_password_invalid", "Current password is invalid", 400);
      const controls = await commands.client().user_controls.updateMany({
        where: { id: input.userId, status: "enabled" },
        data: { auth_version: { increment: 1 }, updated_at: now },
      });
      if (controls.count !== 1) throw new RelayError("unauthorized", "Invalid or expired authentication state", 401);
      await commands.revokeAllUserSessions(input.userId, now);
      await commands.appendAudit({ actor: { actorType: "user", actorId: input.userId }, action: "auth.password_change", resource: { resourceType: "user", resourceId: input.userId }, result: "success", source: input.surface, requestId: input.requestId, metadata: { surface: input.surface, otherSessionsRevoked: true } });
      return (await commands.queries.getUser(input.userId))!;
    });
  }

  async changeCredentialPassword(input: { userId: string; expectedPasswordHash: string; newPasswordHash: string; surface: "web" | "owner"; requestId?: string | null }): Promise<UserSnapshot> {
    return this.run(async (commands) => {
      const now = nowIso();
      const account = await commands.client().account.updateMany({
        where: {
          userId: input.userId,
          accountId: input.userId,
          providerId: "credential",
          issuer: "local:credential",
          password: input.expectedPasswordHash,
        },
        data: { password: input.newPasswordHash, updatedAt: new Date(now) },
      });
      if (account.count !== 1) throw new RelayError("current_password_invalid", "Current password is invalid", 400);
      const controls = await commands.client().user_controls.updateMany({
        where: { id: input.userId, status: "enabled" },
        data: { auth_version: { increment: 1 }, updated_at: now },
      });
      if (controls.count !== 1) throw new RelayError("unauthorized", "Invalid or expired authentication state", 401);
      await commands.revokeAllUserSessions(input.userId, now);
      await commands.appendAudit({
        actor: { actorType: "user", actorId: input.userId },
        action: "auth.password_change",
        resource: { resourceType: "user", resourceId: input.userId },
        result: "success",
        source: input.surface,
        requestId: input.requestId,
        metadata: { surface: input.surface, otherSessionsRevoked: true },
      });
      return (await commands.queries.getUser(input.userId))!;
    });
  }

  async getOrCreateWebAuthnUserHandle(input: { userId: string; candidateHandle: string; additionalCandidateHandles?: string[] }): Promise<WebAuthnUserHandleSnapshot> {
    void input;
    throw retiredAuthenticationMethod("Passkey authentication is no longer available");
    return this.run(async (commands) => {
      const existing = await commands.queries.getWebAuthnUserHandle(input.userId);
      if (existing) return existing;
      if (!(await commands.queries.getUser(input.userId))) throw new RelayError("user_not_found", "User not found", 404);
      for (const candidate of [input.candidateHandle, ...(input.additionalCandidateHandles ?? [])]) {
        const createdAt = nowIso();
        const inserted = await commands.client().$queryRaw<Array<{ user_id: string; user_handle: string; created_at: string }>>`
          INSERT INTO "webauthn_user_handles" ("user_id", "user_handle", "created_at")
          VALUES (${input.userId}, ${candidate}, ${createdAt})
          ON CONFLICT DO NOTHING
          RETURNING "user_id", "user_handle", "created_at"`;
        if (inserted[0]) return { userId: inserted[0].user_id, userHandle: inserted[0].user_handle, createdAt: inserted[0].created_at };
        const concurrent = await commands.queries.getWebAuthnUserHandle(input.userId);
        if (concurrent) return concurrent;
      }
      throw new RelayError("passkey_user_handle_unavailable", "Unable to allocate a Passkey user handle", 500);
    });
  }

  async createWebAuthnCeremony(input: Omit<WebAuthnCeremonySnapshot, "createdAt"> & { createdAt?: string }, cleanupLimit = 100): Promise<WebAuthnCeremonySnapshot> {
    void input;
    void cleanupLimit;
    throw retiredAuthenticationMethod("Passkey authentication is no longer available");
    return this.run(async (commands) => {
      const createdAt = input.createdAt ?? nowIso();
      const expired = await commands.client().webauthn_ceremonies.findMany({ where: { expires_at: { lte: createdAt } }, orderBy: [{ expires_at: "asc" }, { session_hash: "asc" }], take: cleanupLimit, select: { session_hash: true } });
      if (expired.length > 0) await commands.client().webauthn_ceremonies.deleteMany({ where: { session_hash: { in: expired.map((row) => row.session_hash) } } });
      return ceremonySnapshot(await commands.client().webauthn_ceremonies.create({ data: {
        session_hash: input.sessionHash, challenge_hash: input.challengeHash, purpose: input.purpose,
        surface: input.surface, user_id: input.userId, expected_auth_version: input.expectedAuthVersion,
        rp_id: input.rpId, origin: input.origin, passkey_name: input.passkeyName,
        expires_at: input.expiresAt, created_at: createdAt,
      } }));
    });
  }

  async takeWebAuthnCeremony(input: { sessionHash: string; purpose: "authentication" | "registration"; surface: "admin" | "web"; now?: string }): Promise<WebAuthnCeremonySnapshot | undefined> {
    void input;
    throw retiredAuthenticationMethod("Passkey authentication is no longer available");
    return this.run(async (commands) => {
      const row = await commands.client().webauthn_ceremonies.findUnique({ where: { session_hash: input.sessionHash } });
      if (!row || row.purpose !== input.purpose || row.surface !== input.surface) return undefined;
      const deleted = await commands.client().webauthn_ceremonies.deleteMany({ where: { session_hash: row.session_hash, purpose: input.purpose, surface: input.surface } });
      if (deleted.count !== 1) return undefined;
      return row.expires_at > (input.now ?? nowIso()) ? ceremonySnapshot(row) : undefined;
    });
  }

  async registerUserPasskey(input: { userId: string; expectedAuthVersion: number; credentialId: string; publicKey: string; signCount: number; transportsJson: string; deviceType: "multiDevice" | "singleDevice"; backedUp: number; rpId: string; name: string; source: "web" | "owner"; requestId?: string | null }): Promise<PasskeyCredentialSnapshot> {
    void input;
    throw retiredAuthenticationMethod("Passkey authentication is no longer available");
    return this.run(async (commands) => {
      await commands.assertEnabledAuthVersion(input.userId, input.expectedAuthVersion);
      const [rpCount, totalCount] = await Promise.all([
        commands.client().passkey_credentials.count({ where: { user_id: input.userId, rp_id: input.rpId } }),
        commands.client().passkey_credentials.count({ where: { user_id: input.userId } }),
      ]);
      if (rpCount >= 10 || totalCount >= 20) throw new RelayError("passkey_limit_reached", "Passkey limit reached", 409);
      const now = nowIso();
      let row;
      try {
        row = await commands.client().passkey_credentials.create({ data: {
          id: createId("passkey"), user_id: input.userId, credential_id: input.credentialId,
          public_key: input.publicKey, sign_count: input.signCount, transports_json: input.transportsJson,
          device_type: input.deviceType, backed_up: input.backedUp, rp_id: input.rpId, name: input.name,
          created_at: now, last_used_at: null, updated_at: now,
        } });
      } catch (error) {
        if (isUniqueConstraint(error)) throw new RelayError("passkey_already_registered", "Passkey is already registered", 409);
        throw error;
      }
      await commands.appendAudit({ actor: { actorType: "user", actorId: input.userId }, action: "auth.passkey.register", resource: { resourceType: "passkey", resourceId: row.id }, result: "success", source: input.source, requestId: input.requestId, metadata: {} });
      return passkeySnapshot(row);
    });
  }

  async listUserPasskeysAudited(input: { userId: string; expectedAuthVersion: number; source: "web" | "owner"; requestId?: string | null }): Promise<PasskeyCredentialSnapshot[]> {
    void input;
    throw retiredAuthenticationMethod("Passkey authentication is no longer available");
    return this.run(async (commands) => {
      await commands.assertEnabledAuthVersion(input.userId, input.expectedAuthVersion);
      const rows = await commands.queries.listPasskeyCredentials(input.userId);
      await commands.appendAudit({ actor: { actorType: "user", actorId: input.userId }, action: "auth.passkey.list", resource: { resourceType: "user", resourceId: input.userId }, result: "success", source: input.source, requestId: input.requestId, metadata: { passkeyCount: rows.length } });
      return rows;
    });
  }

  async renameUserPasskey(input: { userId: string; expectedAuthVersion: number; passkeyId: string; name: string; source: "web" | "owner"; requestId?: string | null }): Promise<PasskeyCredentialSnapshot> {
    void input;
    throw retiredAuthenticationMethod("Passkey authentication is no longer available");
    return this.run(async (commands) => {
      await commands.assertEnabledAuthVersion(input.userId, input.expectedAuthVersion);
      const updated = await commands.client().passkey_credentials.updateMany({ where: { id: input.passkeyId, user_id: input.userId }, data: { name: input.name, updated_at: nowIso() } });
      if (updated.count !== 1) throw new RelayError("passkey_not_found", "Passkey not found", 404);
      const row = (await commands.client().passkey_credentials.findUnique({ where: { id: input.passkeyId } }))!;
      await commands.appendAudit({ actor: { actorType: "user", actorId: input.userId }, action: "auth.passkey.rename", resource: { resourceType: "passkey", resourceId: input.passkeyId }, result: "success", source: input.source, requestId: input.requestId, metadata: {} });
      return passkeySnapshot(row);
    });
  }

  async completePasskeyLogin(input: { userId: string; expectedAuthVersion: number; passkeyId: string; credentialId: string; rpId: string; expectedUpdatedAt: string; expectedSignCount: number; newSignCount: number; deviceType: "multiDevice" | "singleDevice"; backedUp: number; refreshTokenHash: string; refreshTokenExpiresAt: string; source: "web" | "owner"; requestId?: string | null; auditMetadata: Record<string, unknown> }): Promise<UserSnapshot> {
    void input;
    throw retiredAuthenticationMethod("Passkey authentication is no longer available");
    return this.run(async (commands) => {
      const user = await commands.assertEnabledAuthVersion(input.userId, input.expectedAuthVersion);
      const now = nowIso();
      const nextUpdatedAt = new Date(Math.max(Date.parse(now), Date.parse(input.expectedUpdatedAt) + 1)).toISOString();
      const updated = await commands.client().passkey_credentials.updateMany({
        where: { id: input.passkeyId, user_id: input.userId, credential_id: input.credentialId, rp_id: input.rpId, updated_at: input.expectedUpdatedAt, sign_count: input.expectedSignCount },
        data: { sign_count: input.newSignCount, device_type: input.deviceType, backed_up: input.backedUp, last_used_at: now, updated_at: nextUpdatedAt },
      });
      if (updated.count !== 1) throw new RelayError("invalid_credentials", "Invalid credentials", 401);
      await commands.appendAudit({ actor: { actorType: "user", actorId: user.id }, action: "auth.login", resource: { resourceType: "user", resourceId: user.id }, result: "success", source: input.source, requestId: input.requestId, metadata: { ...input.auditMetadata, method: "passkey" } });
      return user;
    });
  }

  async deleteUserPasskeyAndRotateSession(input: { userId: string; expectedAuthVersion: number; expectedPasswordHash: string; passkeyId: string; newRefreshTokenHash: string; newRefreshTokenExpiresAt: string; source: "web" | "owner"; requestId?: string | null }): Promise<UserSnapshot> {
    void input;
    throw retiredAuthenticationMethod("Passkey authentication is no longer available");
    return this.run(async (commands) => {
      await commands.assertEnabledAuthVersion(input.userId, input.expectedAuthVersion);
      const deleted = await commands.client().passkey_credentials.deleteMany({ where: { id: input.passkeyId, user_id: input.userId } });
      if (deleted.count !== 1) throw new RelayError("passkey_not_found", "Passkey not found", 404);
      const now = nowIso();
      const updated = await commands.client().user_controls.updateMany({ where: { id: input.userId, status: "enabled", auth_version: input.expectedAuthVersion }, data: { auth_version: { increment: 1 }, updated_at: now } });
      if (updated.count !== 1) throw new RelayError("current_password_invalid", "Current password is invalid", 400);
      await commands.revokeAllUserSessions(input.userId, now);
      await commands.client().refresh_tokens.create({ data: { id: createId("rt"), user_id: input.userId, token_hash: input.newRefreshTokenHash, expires_at: input.newRefreshTokenExpiresAt, revoked_at: null, created_at: now } });
      await commands.appendAudit({ actor: { actorType: "user", actorId: input.userId }, action: "auth.passkey.delete", resource: { resourceType: "passkey", resourceId: input.passkeyId }, result: "success", source: input.source, requestId: input.requestId, metadata: { otherSessionsRevoked: true } });
      return (await commands.queries.getUser(input.userId))!;
    });
  }

  async createOidcAuthorizationCode(
    input: { codeHash: string; userId: string; clientId: string; redirectUri: string; scope: string; codeChallenge: string; nonce: string; expiresAt: string },
    audit?: IdentityAuditInput,
  ): Promise<OidcAuthorizationCodeSnapshot> {
    void input;
    void audit;
    throw retiredAuthenticationMethod("OIDC authentication is no longer available");
    return this.run(async (commands) => {
      const code = oidcAuthorizationCodeSnapshot(await commands.client().oidc_authorization_codes.create({ data: { id: createId("oidc_code"), code_hash: input.codeHash, user_id: input.userId, client_id: input.clientId, redirect_uri: input.redirectUri, scope: input.scope, code_challenge: input.codeChallenge, nonce: input.nonce, created_at: nowIso(), expires_at: input.expiresAt, consumed_at: null } }));
      if (audit) await commands.appendAudit(audit);
      return code;
    });
  }

  async exchangeOidcAuthorizationCode(input: { codeHash: string; clientId: string; redirectUri: string; codeChallenge: string; accessTokenHash: string; accessTokenAudience: string; accessTokenExpiresAt: string; refreshToken?: { tokenHash: string; familyId: string; expiresAt: string }; now?: string }): Promise<{ authorizationCode: OidcAuthorizationCodeSnapshot; accessToken: OidcAccessTokenSnapshot; refreshToken: OidcRefreshTokenSnapshot | null; user: UserSnapshot }> {
    void input;
    throw retiredAuthenticationMethod("OIDC authentication is no longer available");
    return this.run(async (commands) => {
      const now = input.now ?? nowIso();
      const code = await commands.queries.getOidcAuthorizationCodeByHash(input.codeHash);
      if (!code || code.consumedAt || code.expiresAt <= now || code.clientId !== input.clientId || code.redirectUri !== input.redirectUri || code.codeChallenge !== input.codeChallenge) throw new RelayError("invalid_grant", "Invalid authorization grant", 400);
      const user = await commands.queries.getUser(code.userId);
      if (!user || user.status !== "enabled") throw new RelayError("invalid_grant", "Invalid authorization grant", 400);
      const consumed = await commands.client().oidc_authorization_codes.updateMany({ where: { id: code.id, consumed_at: null }, data: { consumed_at: now } });
      if (consumed.count !== 1) throw new RelayError("invalid_grant", "Invalid authorization grant", 400);
      const access = oidcAccessTokenSnapshot(await commands.client().oidc_access_tokens.create({ data: { id: createId("oidc_access"), token_hash: input.accessTokenHash, user_id: user.id, client_id: code.clientId, audience: input.accessTokenAudience, scope: code.scope, created_at: now, expires_at: input.accessTokenExpiresAt, revoked_at: null } }));
      const refresh = input.refreshToken ? oidcRefreshTokenSnapshot(await commands.client().oidc_refresh_tokens.create({ data: { id: createId("oidc_refresh"), token_hash: input.refreshToken.tokenHash, family_id: input.refreshToken.familyId, user_id: user.id, client_id: code.clientId, scope: code.scope, created_at: now, expires_at: input.refreshToken.expiresAt, consumed_at: null, revoked_at: null, replaced_by_id: null } })) : null;
      return { authorizationCode: { ...code, consumedAt: now }, accessToken: access, refreshToken: refresh, user };
    });
  }

  async rotateOidcRefreshToken(input: { tokenHash: string; clientId: string; newTokenHash: string; accessTokenHash: string; accessTokenAudience: string; accessTokenExpiresAt: string; refreshTokenExpiresAt: string; now?: string }): Promise<{ status: "rotated"; accessToken: OidcAccessTokenSnapshot; refreshToken: OidcRefreshTokenSnapshot; user: UserSnapshot } | { status: "invalid" | "replayed" }> {
    void input;
    throw retiredAuthenticationMethod("OIDC authentication is no longer available");
    return this.run(async (commands) => {
      const now = input.now ?? nowIso();
      const current = await commands.queries.getOidcRefreshTokenByHash(input.tokenHash);
      if (!current || current.clientId !== input.clientId) return { status: "invalid" as const };
      if (current.consumedAt) { await commands.client().oidc_refresh_tokens.updateMany({ where: { family_id: current.familyId, revoked_at: null }, data: { revoked_at: now } }); return { status: "replayed" as const }; }
      if (current.revokedAt || current.expiresAt <= now) return { status: "invalid" as const };
      const user = await commands.queries.getUser(current.userId);
      if (!user || user.status !== "enabled") return { status: "invalid" as const };
      const nextId = createId("oidc_refresh");
      const consumed = await commands.client().oidc_refresh_tokens.updateMany({ where: { id: current.id, consumed_at: null, revoked_at: null }, data: { consumed_at: now, replaced_by_id: nextId } });
      if (consumed.count !== 1) {
        await commands.client().oidc_refresh_tokens.updateMany({ where: { family_id: current.familyId, revoked_at: null }, data: { revoked_at: now } });
        return { status: "replayed" as const };
      }
      const accessToken = oidcAccessTokenSnapshot(await commands.client().oidc_access_tokens.create({ data: { id: createId("oidc_access"), token_hash: input.accessTokenHash, user_id: user.id, client_id: current.clientId, audience: input.accessTokenAudience, scope: current.scope, created_at: now, expires_at: input.accessTokenExpiresAt, revoked_at: null } }));
      const refreshToken = oidcRefreshTokenSnapshot(await commands.client().oidc_refresh_tokens.create({ data: { id: nextId, token_hash: input.newTokenHash, family_id: current.familyId, user_id: user.id, client_id: current.clientId, scope: current.scope, created_at: now, expires_at: input.refreshTokenExpiresAt, consumed_at: null, revoked_at: null, replaced_by_id: null } }));
      return { status: "rotated" as const, accessToken, refreshToken, user };
    });
  }

  async revokeOidcAccessToken(tokenHash: string, clientId: string): Promise<void> {
    void tokenHash;
    void clientId;
    throw retiredAuthenticationMethod("OIDC authentication is no longer available");
    await this.run(async (commands) => { await commands.client().oidc_access_tokens.updateMany({ where: { token_hash: tokenHash, client_id: clientId, revoked_at: null }, data: { revoked_at: nowIso() } }); });
  }

  async revokeOidcRefreshToken(tokenHash: string, clientId: string): Promise<void> {
    void tokenHash;
    void clientId;
    throw retiredAuthenticationMethod("OIDC authentication is no longer available");
    await this.run(async (commands) => {
      const token = await commands.queries.getOidcRefreshTokenByHash(tokenHash);
      if (token?.clientId === clientId) await commands.client().oidc_refresh_tokens.updateMany({ where: { family_id: token.familyId, revoked_at: null }, data: { revoked_at: nowIso() } });
    });
  }

  async deleteExpiredOidcState(now = nowIso()): Promise<{ authorizationCodes: number; accessTokens: number; refreshTokens: number }> {
    void now;
    throw retiredAuthenticationMethod("OIDC authentication is no longer available");
    return this.run(async (commands) => {
      const [authorizationCodes, accessTokens, refreshTokens] = await Promise.all([
        commands.client().oidc_authorization_codes.deleteMany({ where: { expires_at: { lte: now } } }),
        commands.client().oidc_access_tokens.deleteMany({ where: { expires_at: { lte: now } } }),
        commands.client().oidc_refresh_tokens.deleteMany({ where: { expires_at: { lte: now } } }),
      ]);
      return { authorizationCodes: authorizationCodes.count, accessTokens: accessTokens.count, refreshTokens: refreshTokens.count };
    });
  }

  async appendAudit(input: IdentityAuditInput): Promise<void> {
    await this.auditAppender.append(this.client(), {
      actor: input.actor,
      action: input.action,
      resourceType: input.resource.resourceType,
      resourceId: input.resource.resourceId,
      result: input.result,
      source: input.source,
      requestId: input.requestId ?? null,
      metadata: input.metadata ?? {},
    } satisfies IdentityTenancyAuditEventDraft);
  }

  private async assertEnabledAuthVersion(userId: string, expectedAuthVersion: number): Promise<UserSnapshot> {
    const user = await this.queries.getUser(userId);
    if (!user || user.status !== "enabled" || user.authVersion !== expectedAuthVersion) throw new RelayError("unauthorized", "Invalid or expired authentication state", 401);
    return user;
  }

  private async revokeAllUserSessions(userId: string, revokedAt: string): Promise<void> {
    void revokedAt;
    await this.client().session.deleteMany({ where: { userId } });
  }
}

type CanonicalEmailUserRow = {
  id: string;
  team_id: string | null;
  email: string;
  password_hash: string;
  auth_version: number;
  status: string;
  admin_note: string | null;
  api_key_limit: number;
  user_can_create_custom_provider: number;
  user_can_create_access_point: number;
  created_at: string;
};

type ClassifiedIdentity = IdentityMigrationCandidate & {
  passwordHash: string;
  rootFacts: string;
};

type PendingMigrationRecord = {
  emailFingerprint: string;
  sourceUserId: string;
  survivorUserId: string;
  outcome: "canonicalize_pending" | "merge_pending" | "freeze_pending";
  conflicts: IdentityMigrationConflict[];
};

export interface IdentityMigrationPeerClassification {
  activePlatformOwner: boolean;
  ownedTenantCount: number;
  unsafeReferenceCount: number;
  transferStateFingerprint: string;
}

export interface IdentityMigrationPeerContext {
  classifyUser(userId: string): Promise<IdentityMigrationPeerClassification>;
  transferMemberships(sourceUserId: string, survivorUserId: string): Promise<void>;
}

export interface IdentityMigrationPeerContextBinder {
  bind(transaction: PrismaIdentityClient): IdentityMigrationPeerContext;
}

/** Offline-only migration boundary. Construction does not execute a mutation. */
export class IdentityCanonicalEmailUpgrade {
  constructor(private readonly root: RootIdentityClient, private readonly peerContexts: IdentityMigrationPeerContextBinder) {}

  preflight(): Promise<CanonicalEmailUpgradePreflight> {
    return this.buildPreflight(this.root.prisma);
  }

  async recordPreflight(preflight: CanonicalEmailUpgradePreflight, batchId = createId("identity_migration")): Promise<string> {
    if (preflight.invalidUserIds.length > 0) {
      throw new RelayError("identity_email_preflight_invalid", "Canonical email preflight found invalid identities", 409, { invalidUserIds: preflight.invalidUserIds });
    }
    await this.root.withPrismaTransaction(async (transaction) => {
      await transaction.$queryRaw`SELECT "id" FROM "user_controls" ORDER BY "created_at", "id" FOR SHARE`;
      const current = await this.buildPreflight(transaction);
      assertMatchingPreflight(preflight, current, "identity_email_preflight_stale");
      const now = nowIso();
      await transaction.identity_migration_batches.create({ data: {
        id: batchId,
        migration_kind: "canonical_email_v1",
        rule_version: current.ruleVersion,
        snapshot_digest: current.snapshotDigest,
        observed_user_count: current.observedUserCount,
        status: "preflighted",
        created_at: now,
        started_at: null,
        completed_at: null,
      } });
      for (const item of expectedPendingRecords(current)) {
        await transaction.identity_migration_records.create({ data: {
          id: createId("identity_migration_record"),
          batch_id: batchId,
          email_fingerprint: item.emailFingerprint,
          source_user_id: item.sourceUserId,
          survivor_user_id: item.survivorUserId,
          outcome: item.outcome,
          conflict_types_json: JSON.stringify(item.conflicts),
          created_at: now,
        } });
      }
    }, 1, { isolationLevel: "Serializable" });
    return batchId;
  }

  async run(input: { batchId: string; execute: true; offlineConfirmed: true }): Promise<CanonicalEmailUpgradeResult> {
    if (input.execute !== true || input.offlineConfirmed !== true) {
      throw new RelayError("identity_email_upgrade_confirmation_required", "Canonical email upgrade requires explicit offline confirmation", 409);
    }
    return this.root.withPrismaTransaction(async (transaction) => {
      await transaction.$queryRaw`SELECT "id" FROM "identity_migration_batches" WHERE "id" = ${input.batchId} FOR UPDATE`;
      const batch = await transaction.identity_migration_batches.findUnique({ where: { id: input.batchId } });
      if (!batch || batch.migration_kind !== "canonical_email_v1" || batch.rule_version !== "canonical-email-v1") {
        throw new RelayError("identity_email_upgrade_batch_not_found", "Canonical email upgrade batch was not found", 404);
      }
      if (batch.status !== "preflighted") {
        throw new RelayError("identity_email_upgrade_batch_state_invalid", "Canonical email upgrade batch is not preflighted", 409);
      }
      await transaction.$queryRaw`SELECT "id" FROM "user_controls" ORDER BY "created_at", "id" FOR UPDATE`;
      const current = await this.buildPreflight(transaction);
      if (current.invalidUserIds.length > 0 || current.snapshotDigest !== batch.snapshot_digest || current.observedUserCount !== batch.observed_user_count) {
        throw new RelayError("identity_email_upgrade_snapshot_changed", "Canonical email upgrade data changed after recorded preflight", 409);
      }
      const storedRecords = await transaction.identity_migration_records.findMany({ where: { batch_id: input.batchId } });
      assertRecordedPendingSet(expectedPendingRecords(current), storedRecords);

      const startedAt = nowIso();
      await transaction.identity_migration_batches.update({ where: { id: input.batchId }, data: { status: "running", started_at: startedAt } });
      const identity = new IdentityCommands(this.root, transaction);
      const peerContexts = this.peerContexts.bind(transaction);
      let canonicalizedCount = 0;
      let mergedCount = 0;
      let frozenCount = 0;

      for (const item of [...current.singletonCanonicalizations].sort(compareCanonicalization)) {
        await transaction.user.update({ where: { id: item.userId }, data: { email: item.canonicalValue, updatedAt: new Date() } });
        await identity.appendAudit(migrationAudit(input.batchId, "identity.email_upgrade.canonicalize", item.userId, { batchId: input.batchId, ruleVersion: current.ruleVersion }));
        await appendTerminalRecord(transaction, input.batchId, {
          emailFingerprint: item.emailFingerprint,
          sourceUserId: item.userId,
          survivorUserId: item.userId,
          outcome: "canonicalize_pending",
          conflicts: [],
        }, "canonicalized");
        canonicalizedCount += 1;
      }

      for (const group of [...current.collisionGroups].sort((left, right) => left.canonicalValue.localeCompare(right.canonicalValue))) {
        // decideCanonicalEmailUpgrade already orders sources by createdAt then id.
        const decisions = [...group.decisions];
        for (const decision of decisions) {
          const displacedEmail = migrationDisplacementEmail(input.batchId, decision.sourceUserId);
          try {
            await transaction.user.update({ where: { id: decision.sourceUserId }, data: { email: displacedEmail, updatedAt: new Date() } });
          } catch (error) {
            if (isUniqueConstraint(error)) throw new RelayError("identity_email_upgrade_placeholder_conflict", "Canonical email upgrade placeholder collided", 409);
            throw error;
          }
        }
        const survivor = await transaction.user.findUnique({ where: { id: group.decisions[0]?.survivorUserId ?? group.candidates[0]!.id } });
        if (!survivor) throw new RelayError("identity_email_upgrade_snapshot_changed", "Canonical email survivor disappeared", 409);
        if (survivor.email !== group.canonicalValue) {
          await transaction.user.update({ where: { id: survivor.id }, data: { email: group.canonicalValue, updatedAt: new Date() } });
          await identity.appendAudit(migrationAudit(input.batchId, "identity.email_upgrade.canonicalize", survivor.id, { batchId: input.batchId, ruleVersion: current.ruleVersion }));
          canonicalizedCount += 1;
        }

        for (const decision of decisions) {
          const pending: PendingMigrationRecord = {
            emailFingerprint: group.emailFingerprint,
            sourceUserId: decision.sourceUserId,
            survivorUserId: decision.survivorUserId,
            outcome: decision.outcome === "merge" ? "merge_pending" : "freeze_pending",
            conflicts: decision.conflicts,
          };
          if (decision.outcome === "merge") {
            await peerContexts.transferMemberships(decision.sourceUserId, decision.survivorUserId);
            await transaction.session.deleteMany({ where: { userId: decision.sourceUserId } });
            await transaction.account.deleteMany({ where: { userId: decision.sourceUserId } });
            await transaction.user.delete({ where: { id: decision.sourceUserId } });
            await transaction.user_controls.delete({ where: { id: decision.sourceUserId } });
            await identity.appendAudit(migrationAudit(input.batchId, "identity.email_upgrade.merge", decision.sourceUserId, {
              batchId: input.batchId,
              survivorUserId: decision.survivorUserId,
              ruleVersion: current.ruleVersion,
            }));
            await appendTerminalRecord(transaction, input.batchId, pending, "merged");
            mergedCount += 1;
          } else {
            const frozenAt = nowIso();
            await transaction.user_controls.update({ where: { id: decision.sourceUserId }, data: {
              status: "disabled",
              auth_version: { increment: 1 },
              migration_frozen_at: frozenAt,
              migration_freeze_reason: decision.conflicts.join(","),
              updated_at: frozenAt,
            } });
            await revokeFrozenIdentitySessions(transaction, decision.sourceUserId, frozenAt);
            await identity.appendAudit(migrationAudit(input.batchId, "identity.email_upgrade.freeze", decision.sourceUserId, {
              batchId: input.batchId,
              survivorUserId: decision.survivorUserId,
              conflictTypes: decision.conflicts,
              ruleVersion: current.ruleVersion,
            }));
            await appendTerminalRecord(transaction, input.batchId, pending, "frozen");
            frozenCount += 1;
          }
        }
      }

      const status = frozenCount > 0 ? "completed_with_frozen" as const : "completed" as const;
      await transaction.identity_migration_batches.update({ where: { id: input.batchId }, data: { status, completed_at: nowIso() } });
      return { batchId: input.batchId, status, canonicalizedCount, mergedCount, frozenCount };
    }, 1, { isolationLevel: "Serializable" });
  }

  private async buildPreflight(client: PrismaIdentityClient): Promise<CanonicalEmailUpgradePreflight> {
    const users = await client.$queryRaw<CanonicalEmailUserRow[]>`
      SELECT controls."id", controls."team_id", identity."email", credential."password" AS "password_hash",
             controls."auth_version", controls."status", controls."admin_note", controls."api_key_limit",
             controls."user_can_create_custom_provider", controls."user_can_create_access_point", controls."created_at"
      FROM "user_controls" controls
      INNER JOIN "user" identity ON identity."id" = controls."id"
      LEFT JOIN "account" credential
        ON credential."user_id" = controls."id"
       AND credential."provider_id" = 'credential'
       AND credential."issuer" = 'local:credential'
      ORDER BY controls."created_at" ASC, controls."id" ASC
    `;
    const groups = new Map<string, CanonicalEmailUserRow[]>();
    const invalidUserIds: string[] = [];
    for (const user of users) {
      try {
        const canonical = EmailAddr.parse(user.email).value;
        const group = groups.get(canonical) ?? [];
        group.push(user);
        groups.set(canonical, group);
      } catch {
        invalidUserIds.push(user.id);
      }
    }
    const singletonCanonicalizations: CanonicalEmailUpgradePreflight["singletonCanonicalizations"] = [];
    const collisionGroups: CanonicalEmailUpgradeGroup[] = [];
    for (const [canonicalValue, groupedUsers] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const email = EmailAddr.restore(canonicalValue);
      if (groupedUsers.length === 1) {
        const candidate = groupedUsers[0]!;
        if (candidate.email !== canonicalValue) singletonCanonicalizations.push({ userId: candidate.id, canonicalValue, emailFingerprint: canonicalEmailFingerprint(email) });
        continue;
      }
      const classified = await Promise.all(groupedUsers.map((candidate) => this.classify(client, candidate)));
      const ordered = [...classified].sort(compareMigrationCandidate);
      const survivor = ordered[0]!;
      const candidates = ordered.map((candidate): IdentityMigrationCandidate => ({
        id: candidate.id,
        createdAt: candidate.createdAt,
        credentialConflict: candidate.id === survivor.id ? false : candidate.passwordHash !== survivor.passwordHash || candidate.credentialCount > 0,
        credentialCount: candidate.credentialCount,
        activePlatformOwner: candidate.activePlatformOwner,
        ownedTenantCount: candidate.ownedTenantCount,
        otherFactReferenceCount: candidate.otherFactReferenceCount + (candidate.id === survivor.id || candidate.rootFacts === survivor.rootFacts ? 0 : 1),
        transferStateFingerprint: candidate.transferStateFingerprint,
      }));
      collisionGroups.push({ emailFingerprint: canonicalEmailFingerprint(email), canonicalValue, candidates, decisions: decideCanonicalEmailUpgrade(candidates) });
    }
    singletonCanonicalizations.sort(compareCanonicalization);
    invalidUserIds.sort();
    const snapshotDigest = preflightSnapshotDigest(users, invalidUserIds, singletonCanonicalizations, collisionGroups);
    return { ruleVersion: "canonical-email-v1", snapshotDigest, observedUserCount: users.length, invalidUserIds, singletonCanonicalizations, collisionGroups };
  }

  private async classify(client: PrismaIdentityClient, user: CanonicalEmailUserRow): Promise<ClassifiedIdentity> {
    const [apiKeys, passkeys, refreshTokens, oidcCodes, oidcAccess, oidcRefresh, handle, ceremonies, peerFacts] = await Promise.all([
      client.api_keys.count({ where: { user_id: user.id } }),
      client.passkey_credentials.count({ where: { user_id: user.id } }),
      client.refresh_tokens.count({ where: { user_id: user.id } }),
      client.oidc_authorization_codes.count({ where: { user_id: user.id } }),
      client.oidc_access_tokens.count({ where: { user_id: user.id } }),
      client.oidc_refresh_tokens.count({ where: { user_id: user.id } }),
      client.webauthn_user_handles.count({ where: { user_id: user.id } }),
      client.webauthn_ceremonies.count({ where: { user_id: user.id } }),
      this.peerContexts.bind(client).classifyUser(user.id),
    ]);
    return {
      id: user.id,
      createdAt: user.created_at,
      passwordHash: user.password_hash,
      credentialConflict: false,
      credentialCount: apiKeys + passkeys + refreshTokens + oidcCodes + oidcAccess + oidcRefresh + handle + ceremonies,
      activePlatformOwner: peerFacts.activePlatformOwner,
      ownedTenantCount: peerFacts.ownedTenantCount,
      otherFactReferenceCount: peerFacts.unsafeReferenceCount,
      transferStateFingerprint: peerFacts.transferStateFingerprint,
      rootFacts: JSON.stringify({
        status: user.status,
        authVersion: user.auth_version,
        adminNote: user.admin_note,
        apiKeyLimit: user.api_key_limit,
        userCanCreateCustomProvider: user.user_can_create_custom_provider,
        userCanCreateAccessPoint: user.user_can_create_access_point,
      }),
    };
  }
}

function expectedPendingRecords(preflight: CanonicalEmailUpgradePreflight): PendingMigrationRecord[] {
  return [
    ...preflight.singletonCanonicalizations.map((item): PendingMigrationRecord => ({
      emailFingerprint: item.emailFingerprint,
      sourceUserId: item.userId,
      survivorUserId: item.userId,
      outcome: "canonicalize_pending",
      conflicts: [],
    })),
    ...preflight.collisionGroups.flatMap((group) => group.decisions.map((decision): PendingMigrationRecord => ({
      emailFingerprint: group.emailFingerprint,
      sourceUserId: decision.sourceUserId,
      survivorUserId: decision.survivorUserId,
      outcome: decision.outcome === "merge" ? "merge_pending" : "freeze_pending",
      conflicts: decision.conflicts,
    }))),
  ].sort(comparePendingRecord);
}

function assertMatchingPreflight(recorded: CanonicalEmailUpgradePreflight, current: CanonicalEmailUpgradePreflight, code: string): void {
  if (recorded.ruleVersion !== current.ruleVersion || recorded.snapshotDigest !== current.snapshotDigest || recorded.observedUserCount !== current.observedUserCount) {
    throw new RelayError(code, "Canonical email preflight no longer matches the database snapshot", 409);
  }
}

function assertRecordedPendingSet(expected: PendingMigrationRecord[], stored: Array<{ email_fingerprint: string; source_user_id: string; survivor_user_id: string; outcome: string; conflict_types_json: string }>): void {
  const actual = stored.map((record): PendingMigrationRecord => ({
    emailFingerprint: record.email_fingerprint,
    sourceUserId: record.source_user_id,
    survivorUserId: record.survivor_user_id,
    outcome: pendingOutcome(record.outcome),
    conflicts: parsedConflicts(record.conflict_types_json),
  })).sort(comparePendingRecord);
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new RelayError("identity_email_upgrade_recorded_batch_mismatch", "Canonical email upgrade records do not match the recorded data snapshot", 409);
  }
}

function pendingOutcome(value: string): PendingMigrationRecord["outcome"] {
  if (value === "canonicalize_pending" || value === "merge_pending" || value === "freeze_pending") return value;
  throw new RelayError("identity_email_upgrade_recorded_batch_mismatch", "Canonical email upgrade batch contains unexpected terminal records", 409);
}

function parsedConflicts(value: string): IdentityMigrationConflict[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.some((item) => !["credential_conflict", "platform_owner_conflict", "tenant_ownership_conflict", "identity_fact_conflict"].includes(String(item)))) throw new Error("invalid");
    return parsed as IdentityMigrationConflict[];
  } catch {
    throw new RelayError("identity_email_upgrade_recorded_batch_mismatch", "Canonical email upgrade conflict record is invalid", 409);
  }
}

async function appendTerminalRecord(
  transaction: PrismaIdentityClient,
  batchId: string,
  pending: PendingMigrationRecord,
  outcome: "canonicalized" | "merged" | "frozen",
): Promise<void> {
  await transaction.identity_migration_records.create({ data: {
    id: createId("identity_migration_record"),
    batch_id: batchId,
    email_fingerprint: pending.emailFingerprint,
    source_user_id: pending.sourceUserId,
    survivor_user_id: pending.survivorUserId,
    outcome,
    conflict_types_json: JSON.stringify(pending.conflicts),
    created_at: nowIso(),
  } });
}

async function revokeFrozenIdentitySessions(transaction: PrismaIdentityClient, userId: string, revokedAt: string): Promise<void> {
  void revokedAt;
  await transaction.session.deleteMany({ where: { userId } });
}

function migrationAudit(batchId: string, action: "identity.email_upgrade.canonicalize" | "identity.email_upgrade.freeze" | "identity.email_upgrade.merge", userId: string, metadata: Readonly<Record<string, AuditMetadataValue>>): IdentityAuditInput {
  return {
    actor: { actorType: "system", actorId: `identity_migration:${batchId}` },
    action,
    resource: { resourceType: "user", resourceId: userId },
    result: "success",
    source: "system",
    metadata,
  };
}

function migrationDisplacementEmail(batchId: string, userId: string): string {
  const suffix = createHash("sha256").update(`${batchId}\0${userId}`, "utf8").digest("hex").slice(0, 40);
  return EmailAddr.parse(`migration-${suffix}@identity-migration.invalid`).value;
}

function preflightSnapshotDigest(
  users: CanonicalEmailUserRow[],
  invalidUserIds: string[],
  singletonCanonicalizations: CanonicalEmailUpgradePreflight["singletonCanonicalizations"],
  collisionGroups: CanonicalEmailUpgradeGroup[],
): string {
  const snapshot = {
    users: users.map((user) => ({
      id: user.id,
      createdAt: user.created_at,
      emailFingerprint: createHash("sha256").update(user.email, "utf8").digest("hex"),
    })),
    invalidUserIds,
    singletonCanonicalizations,
    collisionGroups,
  };
  return createHash("sha256").update(JSON.stringify(snapshot), "utf8").digest("hex");
}

function compareMigrationCandidate(left: IdentityMigrationCandidate, right: IdentityMigrationCandidate): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function compareCanonicalization(left: { canonicalValue: string; userId: string }, right: { canonicalValue: string; userId: string }): number {
  return left.canonicalValue.localeCompare(right.canonicalValue) || left.userId.localeCompare(right.userId);
}

function comparePendingRecord(left: PendingMigrationRecord, right: PendingMigrationRecord): number {
  return left.emailFingerprint.localeCompare(right.emailFingerprint)
    || left.survivorUserId.localeCompare(right.survivorUserId)
    || left.sourceUserId.localeCompare(right.sourceUserId)
    || left.outcome.localeCompare(right.outcome);
}
function userSnapshot(row: {
  id: string; team_id: string | null; auth_version: number; status: string;
  admin_note: string | null; api_key_limit: number; user_can_create_custom_provider: number; user_can_create_access_point: number;
  created_at: string; updated_at: string; migration_frozen_at?: string | null; migration_freeze_reason?: string | null;
}, email: string, passwordHash: string): UserSnapshot {
  return { id: row.id, teamId: row.team_id, email, passwordHash, authVersion: row.auth_version, status: row.status, adminNote: row.admin_note, apiKeyLimit: row.api_key_limit, userCanCreateCustomProvider: row.user_can_create_custom_provider, userCanCreateAccessPoint: row.user_can_create_access_point, createdAt: row.created_at, updatedAt: row.updated_at, migrationFrozenAt: row.migration_frozen_at ?? null, migrationFreezeReason: row.migration_freeze_reason ?? null };
}

function apiKeySnapshot(row: { id: string; user_id: string; name: string; key_hash: string; key_prefix: string; key_value: string; status: string; expires_at: string | null; revoked_at: string | null; created_at: string; updated_at: string }): ApiKeySnapshot {
  return { id: row.id, userId: row.user_id, name: row.name, keyHash: row.key_hash, keyPrefix: row.key_prefix, keyValue: row.key_value, status: row.status, expiresAt: row.expires_at, revokedAt: row.revoked_at, createdAt: row.created_at, updatedAt: row.updated_at };
}

function refreshTokenSnapshot(row: { id: string; user_id: string; token_hash: string; expires_at: string; revoked_at: string | null; created_at: string }): RefreshTokenSnapshot {
  return { id: row.id, userId: row.user_id, tokenHash: row.token_hash, expiresAt: row.expires_at, revokedAt: row.revoked_at, createdAt: row.created_at };
}

function passkeySnapshot(row: { id: string; user_id: string; credential_id: string; public_key: string; sign_count: number; transports_json: string; device_type: string; backed_up: number; rp_id: string; name: string; created_at: string; last_used_at: string | null; updated_at: string }): PasskeyCredentialSnapshot {
  if (row.device_type !== "multiDevice" && row.device_type !== "singleDevice") throw new RelayError("passkey_device_type_invalid", "Stored Passkey device type is invalid", 500);
  return { id: row.id, userId: row.user_id, credentialId: row.credential_id, publicKey: row.public_key, signCount: row.sign_count, transportsJson: row.transports_json, deviceType: row.device_type, backedUp: row.backed_up, rpId: row.rp_id, name: row.name, createdAt: row.created_at, lastUsedAt: row.last_used_at, updatedAt: row.updated_at };
}

function oidcAuthorizationCodeSnapshot(row: { id: string; code_hash: string; user_id: string; client_id: string; redirect_uri: string; scope: string; code_challenge: string; nonce: string; created_at: string; expires_at: string; consumed_at: string | null }): OidcAuthorizationCodeSnapshot {
  return { id: row.id, codeHash: row.code_hash, userId: row.user_id, clientId: row.client_id, redirectUri: row.redirect_uri, scope: row.scope, codeChallenge: row.code_challenge, nonce: row.nonce, createdAt: row.created_at, expiresAt: row.expires_at, consumedAt: row.consumed_at };
}

function oidcAccessTokenSnapshot(row: { id: string; token_hash: string; user_id: string; client_id: string; audience: string; scope: string; created_at: string; expires_at: string; revoked_at: string | null }): OidcAccessTokenSnapshot {
  return { id: row.id, tokenHash: row.token_hash, userId: row.user_id, clientId: row.client_id, audience: row.audience, scope: row.scope, createdAt: row.created_at, expiresAt: row.expires_at, revokedAt: row.revoked_at };
}

function oidcRefreshTokenSnapshot(row: { id: string; token_hash: string; family_id: string; user_id: string; client_id: string; scope: string; created_at: string; expires_at: string; consumed_at: string | null; revoked_at: string | null; replaced_by_id: string | null }): OidcRefreshTokenSnapshot {
  return { id: row.id, tokenHash: row.token_hash, familyId: row.family_id, userId: row.user_id, clientId: row.client_id, scope: row.scope, createdAt: row.created_at, expiresAt: row.expires_at, consumedAt: row.consumed_at, revokedAt: row.revoked_at, replacedById: row.replaced_by_id };
}

function ceremonySnapshot(row: { session_hash: string; challenge_hash: string; purpose: string; surface: string; user_id: string | null; expected_auth_version: number | null; rp_id: string; origin: string; passkey_name: string | null; expires_at: string; created_at: string }): WebAuthnCeremonySnapshot {
  if ((row.purpose !== "authentication" && row.purpose !== "registration") || (row.surface !== "admin" && row.surface !== "web")) throw new RelayError("passkey_ceremony_state_invalid", "Stored Passkey ceremony is invalid", 500);
  return { sessionHash: row.session_hash, challengeHash: row.challenge_hash, purpose: row.purpose, surface: row.surface, userId: row.user_id, expectedAuthVersion: row.expected_auth_version, rpId: row.rp_id, origin: row.origin, passkeyName: row.passkey_name, expiresAt: row.expires_at, createdAt: row.created_at };
}

function isUniqueConstraint(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && String((error as { code?: unknown }).code) === "P2002");
}

function retiredAuthenticationMethod(message: string): RelayError {
  return new RelayError("auth_method_retired", message, 404);
}
