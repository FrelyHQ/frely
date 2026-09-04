import type { AuditCommands, AuditMetadataValue } from "@frely/audit";
import {
  accessTokenFromCookie,
  accessTokenFromHeaders,
  bearerToken,
  createApiKey,
  createPasswordHash,
  constantTimeUserHandleEqual,
  createWebAuthnUserHandle,
  createRefreshToken,
  refreshTokenExpiresAt,
  hashPasskeySecret,
  normalizePasskeyName,
  normalizePasskeyTransports,
  passkeyAuthenticationIdentity,
  passkeyAuthenticationOptions,
  passkeyCeremonyExpiresAt,
  passkeyRegistrationOptions,
  passkeySurfaceConfig,
  sha256,
  signAccessToken,
  verifyAccessToken,
  verifyPasskeyAuthentication,
  verifyPasskeyRegistration,
  verifyPassword,
  validatePasswordPolicy,
  type AccessTokenClaims,
  type PasskeySurface,
  type ValidatedAuthMutationRequest
} from "@frely/auth";
import type { AppConfig } from "@frely/config";
import type { AuthorityQueries } from "@frely/authority/server";
import {
  EmailAddr,
  type ApiKeySnapshot as ApiKey,
  type PasskeyCredentialSnapshot as PasskeyCredential,
  type UserSnapshot as User,
  type WebAuthnCeremonySnapshot as WebAuthnCeremony,
} from "@frely/identity";
import type { IdentityCommands, IdentityQueries } from "@frely/identity/server";
import type { BetterAuthRuntime } from "@frely/identity/server";
import { assertEnabled, createId, nowIso, RelayError, type PlatformRole, type TeamRole } from "@frely/core";
import type {
  TeamSnapshot as Team,
  TeamInviteLinkSnapshot as TeamInviteLink,
  TeamInviteLinkCreateResult,
  TeamMembershipSnapshot as TeamMembership,
  IdentityTenancyAuditInput,
  TenancyCommands,
  TenancyQueries,
} from "@frely/tenancy-context/server";
import { inviteEmailDomainAllowed, normalizeInviteEmailDomainPattern } from "@frely/tenancy-context";
import { publicUser, type ApiKeyPrincipal, type AuthSession, type PublicPasskeyCredential, type PublicUser } from "./session.js";

export type AuditActor = { actorType: "user" | "api_key" | "system"; actorId: string };
export type AuditSource = "owner" | "web" | "gateway" | "system";
export type ResourcePermissionSubjectType = "user" | "team" | "team_role" | "member";

export type GatewayIdentityContext = Pick<IdentityQueries, "findApiKeyByHash" | "getUser">;
export type GatewayTenancyContext = Pick<TenancyQueries, "listEffectiveSubscriptionScopesForUser">;

/** Capability-scoped typed Context adapters for Gateway authentication. */
export interface AsyncGatewayTenancyQueries {
  identity: GatewayIdentityContext;
  tenancy: GatewayTenancyContext;
}

export type ControlPlaneIdentityQueries = Pick<IdentityQueries,
  | "getUser" | "listUsers" | "findUserByEmail" | "getApiKey" | "findApiKeyByHash" | "listApiKeys" | "findFirstEnabledApiKeyForUser" | "countEnabledApiKeysForUser"
  | "getWebAuthnUserHandle" | "listPasskeyCredentials" | "findPasskeyByCredentialId" | "getRefreshTokenByHash"
>;
export type ControlPlaneIdentityCommands = Pick<IdentityCommands,
  | "createApiKey" | "revokeApiKey" | "setApiKeyStatus" | "getOrCreateWebAuthnUserHandle"
  | "createWebAuthnCeremony" | "takeWebAuthnCeremony" | "registerUserPasskey" | "listUserPasskeysAudited"
  | "renameUserPasskey" | "completePasskeyLogin" | "deleteUserPasskeyAndRotateSession"
  | "createRefreshTokenForAuthVersion" | "rotateOwnPassword" | "rotateRefreshToken" | "revokeRefreshToken"
  | "changeCredentialPassword"
  | "updateUserApiKeyLimit" | "createUser" | "updateUserProfile"
>;
export type ControlPlaneAuthorityContext = Pick<AuthorityQueries, "platformRolesForUser" | "activeBootstrapPlatformOwnerUserId">;
export type ControlPlaneTenancyQueries = Pick<TenancyQueries,
  | "getTeam" | "listTeams" | "getInviteLink" | "getMembership" | "listAvailableMembershipsForUser" | "listInviteLinks"
  | "getActiveInviteLinkForCreator" | "listEnabledInviteLinksByCreator" | "listEnabledNonOwnerInviteLinks"
  | "listResourcePermissions" | "listEffectiveSubscriptionScopesForUser" | "isTeamAvailable"
  | "isTeamMemberInvitesEnabled" | "teamRolesForUser"
>;
export type ControlPlaneTenancyCommands = Pick<TenancyCommands,
  | "createInviteLink" | "getOrCreateActiveInviteLink" | "disableInviteLink" | "consumeInviteLink"
  | "grantMembership" | "ensureFallbackMembership" | "removeMembership" | "changeMembershipRoles" | "upsertResourcePermission"
  | "updateInviteEmailDomain" | "createTeamWithOwnerMembership" | "updateTeamManagementSettings"
  | "requestTeamDeletion" | "cancelTeamDeletion"
>;

export interface AsyncControlPlaneTenancyQueries {
  identity: ControlPlaneIdentityQueries;
  authority: ControlPlaneAuthorityContext;
  tenancy: ControlPlaneTenancyQueries;
}

export interface AsyncControlPlaneTenancyCommands {
  identityCommands: ControlPlaneIdentityCommands;
  tenancyCommands: ControlPlaneTenancyCommands;
  ensureFallbackTeamMembership(userId: string, audit: {
    actor: AuditActor;
    source: AuditSource;
    requestId?: string | null;
  }): Promise<{ membership: TeamMembership; created: boolean }>;
  readonly auditCommands: Pick<AuditCommands, "record">;
}

export interface IdentityTenancyBoundContext extends AsyncControlPlaneTenancyQueries {
  readonly commands: Pick<AsyncControlPlaneTenancyCommands, "identityCommands" | "tenancyCommands" | "auditCommands">;
}

export interface IdentityTenancyUnitOfWorkRunner {
  run<T>(callback: (contexts: IdentityTenancyBoundContext) => Promise<T>): Promise<T>;
}

export class AsyncGatewayTenancyService {
  constructor(readonly contexts: AsyncGatewayTenancyQueries) {}

  async authenticateApiKey(headers: Headers): Promise<ApiKeyPrincipal> {
    const apiKey = await this.contexts.identity.findApiKeyByHash(sha256(bearerToken(headers)));
    if (!apiKey) throw new RelayError("invalid_api_key", "Invalid API key", 401);
    if (apiKey.status !== "enabled") throw new RelayError("api_key_disabled", "API key is disabled", 401);
    if (apiKey.revokedAt) throw new RelayError("api_key_revoked", "API key has been revoked", 401);
    if (apiKey.expiresAt && apiKey.expiresAt <= nowIso()) throw new RelayError("api_key_expired", "API key has expired", 401);
    const user = await this.contexts.identity.getUser(apiKey.userId);
    if (!user) throw new RelayError("principal_not_found", "API key principal not found", 401);
    if (user.status !== "enabled") throw new RelayError("user_disabled", "User is disabled", 401);
    return { apiKey, user, effectiveScopes: await this.contexts.tenancy.listEffectiveSubscriptionScopesForUser(user.id) };
  }
}

export type AsyncControlPlaneSessionAudit = {
  source: Extract<AuditSource, "owner" | "web">;
  requestId?: string | null;
};

export interface BetterAuthLoginResult {
  readonly user: PublicUser;
  readonly setCookieHeaders: string[];
}

export class AsyncControlPlaneTenancyService {
  protected readonly contexts: AsyncControlPlaneTenancyQueries;
  protected readonly commandContexts: AsyncControlPlaneTenancyCommands;
  private readonly unitOfWorkRunner: IdentityTenancyUnitOfWorkRunner;
  protected readonly betterAuthRuntime: BetterAuthRuntime | undefined;

  protected constructor(
    queries: AsyncControlPlaneTenancyQueries,
    commands: AsyncControlPlaneTenancyCommands,
    unitOfWorkRunner: IdentityTenancyUnitOfWorkRunner,
    readonly config: AppConfig,
    betterAuthRuntime?: BetterAuthRuntime,
  ) {
    if ((queries as object) === (commands as object)
      || (queries as object) === (unitOfWorkRunner as object)
      || (commands as object) === (unitOfWorkRunner as object)) {
      throw new Error("identity_tenancy_capability_identity_reused");
    }
    this.contexts = queries;
    this.commandContexts = commands;
    this.unitOfWorkRunner = unitOfWorkRunner;
    this.betterAuthRuntime = betterAuthRuntime;
  }

  async loginWithBetterAuth(email: string, password: string, request: ValidatedAuthMutationRequest, audit?: AsyncControlPlaneSessionAudit): Promise<BetterAuthLoginResult> {
    const runtime = this.requireBetterAuthRuntime();
    const normalizedEmail = EmailAddr.parse(email);
    const surface = audit?.source === "owner" ? "owner" : "web";
    const candidate = await this.contexts.identity.findUserByEmail(normalizedEmail);
    if (candidate) {
      assertEnabled(candidate.status, "user");
      await this.assertSessionSurfaceAllowed(candidate, surface);
    }
    const authenticated = await runtime.signInEmail(request, normalizedEmail.value, password);
    const user = candidate ?? await this.contexts.identity.getUser(authenticated.user.id);
    if (!user || user.id !== authenticated.user.id || user.email !== authenticated.user.email) {
      await runtime.revokeUserSessions(authenticated.user.id);
      throw new RelayError("invalid_credentials", "Invalid email or password", 401);
    }
    assertEnabled(user.status, "user");
    if (surface === "web") {
      try {
        await this.commandContexts.ensureFallbackTeamMembership(user.id, {
          actor: actorFromClaims({ sub: user.id }),
          source: audit?.source ?? "web",
          ...(audit?.requestId === undefined ? {} : { requestId: audit.requestId }),
        });
      } catch (error) {
        await runtime.revokeUserSessions(user.id);
        if (audit) {
          await auditFailureAsync(this.commandContexts, {
            actor: actorFromClaims({ sub: user.id }),
            source: audit.source,
            requestId: audit.requestId,
            action: "auth.login",
            resource: { resourceType: "user", resourceId: user.id },
            metadata: {},
            error,
          });
        }
        throw error;
      }
    }
    const publicProfile = await this.publicUserFor(user, surface);
    if (audit) {
      await auditSuccessAsync(this.commandContexts, {
        actor: actorFromClaims({ sub: user.id }),
        source: audit.source,
        requestId: audit.requestId,
        action: "auth.login",
        resource: { resourceType: "user", resourceId: user.id },
        metadata: { teamIds: publicProfile.teamIds, platformRoles: publicProfile.platformRoles, teamRoles: publicProfile.teamRoles },
      });
    }
    return { user: publicProfile, setCookieHeaders: authenticated.setCookieHeaders };
  }

  async logoutWithBetterAuth(request: ValidatedAuthMutationRequest, audit?: AsyncControlPlaneSessionAudit): Promise<string[]> {
    const runtime = this.requireBetterAuthRuntime();
    const session = await runtime.getSession(request.headers());
    const setCookieHeaders = await runtime.signOut(request);
    if (audit && session) {
      await auditSuccessAsync(this.commandContexts, {
        actor: actorFromClaims({ sub: session.user.id }),
        source: audit.source,
        requestId: audit.requestId,
        action: "auth.logout",
        resource: { resourceType: "user", resourceId: session.user.id },
        metadata: { sessionId: session.session.id },
      });
    }
    return setCookieHeaders;
  }

  async requireBetterAuthSession(headers: Headers, surface: "owner" | "web"): Promise<AccessTokenClaims> {
    const session = await this.requireBetterAuthRuntime().getSession(headers);
    if (!session) throw new RelayError("unauthorized", "Invalid or expired authentication state", 401);
    const user = await this.contexts.identity.getUser(session.user.id);
    if (!user || user.status !== "enabled") throw new RelayError("unauthorized", "Invalid or expired authentication state", 401);
    if (user.email !== session.user.email) throw new RelayError("unauthorized", "Invalid or expired authentication state", 401);
    const publicProfile = await this.publicUserFor(user, surface);
    if (surface === "owner" && !publicProfile.platformRoles.includes("owner")) {
      throw new RelayError("forbidden", "Platform Owner role is required", 403);
    }
    const iat = Math.floor(session.session.createdAt.getTime() / 1000);
    const exp = Math.floor(session.session.expiresAt.getTime() / 1000);
    if (!Number.isSafeInteger(iat) || !Number.isSafeInteger(exp) || exp <= iat) {
      throw new RelayError("unauthorized", "Invalid or expired authentication state", 401);
    }
    return {
      sub: user.id,
      email: session.user.email,
      authVersion: user.authVersion,
      platformRoles: surface === "owner" ? publicProfile.platformRoles : [],
      teamRoles: publicProfile.teamRoles,
      type: "access",
      iat,
      exp,
    };
  }

  async login(email: string, password: string, audit?: AsyncControlPlaneSessionAudit): Promise<AuthSession> {
    void email;
    void password;
    void audit;
    throw retiredAuthenticationMethod("Friday JWT authentication has been retired; use Better Auth");
  }

  async refresh(rawRefreshToken: string, audit?: AsyncControlPlaneSessionAudit): Promise<AuthSession> {
    void rawRefreshToken;
    void audit;
    throw retiredAuthenticationMethod("Friday refresh-token authentication has been retired");
  }

  async logout(rawRefreshToken: string, audit?: AsyncControlPlaneSessionAudit): Promise<void> {
    void rawRefreshToken;
    void audit;
    throw retiredAuthenticationMethod("Friday refresh-token authentication has been retired");
  }

  async changeOwnPassword(input: {
    userId: string;
    surface: "owner" | "web";
    currentPassword: string;
    newPassword: string;
    requestId?: string | null;
  }): Promise<AuthSession> {
    void input;
    throw retiredAuthenticationMethod("Friday JWT password changes have been retired; use Better Auth");
  }

  async changeOwnPasswordWithBetterAuth(input: {
    userId: string;
    surface: "owner" | "web";
    currentPassword: string;
    newPassword: string;
    request: ValidatedAuthMutationRequest;
    requestId?: string | null;
  }): Promise<{ setCookieHeaders: string[] }> {
    const runtime = this.requireBetterAuthRuntime();
    const user = await this.contexts.identity.getUser(input.userId);
    if (!user || user.status !== "enabled") throw new RelayError("unauthorized", "Invalid or expired authentication state", 401);
    await this.assertSessionSurfaceAllowed(user, input.surface);
    const currentHash = await runtime.findCredentialPassword(user.id);
    if (!currentHash || !(await verifyPassword(input.currentPassword, currentHash))) {
      throw new RelayError("current_password_invalid", "Current password is invalid", 400);
    }
    const newPassword = requiredNewPassword(input.newPassword);
    if (newPassword === input.currentPassword) throw new RelayError("password_unchanged", "New password must be different from the current password", 400);
    await this.unitOfWorkRunner.run(async (contexts) => {
      await contexts.commands.identityCommands.changeCredentialPassword({
        userId: user.id,
        expectedPasswordHash: currentHash,
        newPasswordHash: await createPasswordHash(newPassword),
        surface: input.surface,
        ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      });
    });
    const session = await runtime.signInEmail(input.request, user.email, newPassword);
    if (session.user.id !== user.id || session.user.email !== user.email) {
      await runtime.revokeUserSessions(user.id);
      throw new RelayError("auth_session_invalid", "Authentication session is invalid", 500);
    }
    return { setCookieHeaders: session.setCookieHeaders };
  }

  async requireJwt(headers: Headers, surface: "owner" | "web" = "web"): Promise<AccessTokenClaims> {
    void headers;
    void surface;
    throw retiredAuthenticationMethod("Friday JWT authentication has been retired; use Better Auth");
  }

  async requireCookieJwt(headers: Headers, surface: "owner" | "web"): Promise<AccessTokenClaims> {
    void headers;
    void surface;
    throw retiredAuthenticationMethod("Friday JWT authentication has been retired; use Better Auth");
  }

  async requireCookieOwner(headers: Headers): Promise<AccessTokenClaims> {
    return this.requireBetterAuthSession(headers, "owner");
  }

  async requireCookieUser(headers: Headers): Promise<AccessTokenClaims> {
    return this.requireBetterAuthSession(headers, "web");
  }

  async requireOwner(headers: Headers): Promise<AccessTokenClaims> {
    return this.requireBetterAuthSession(headers, "owner");
  }

  async requireUser(headers: Headers): Promise<AccessTokenClaims> {
    return this.requireBetterAuthSession(headers, "web");
  }

  async authenticateApiKey(headers: Headers): Promise<ApiKeyPrincipal> {
    const apiKey = await this.contexts.identity.findApiKeyByHash(sha256(bearerToken(headers)));
    if (!apiKey) throw new RelayError("invalid_api_key", "Invalid API key", 401);
    if (apiKey.status !== "enabled") throw new RelayError("api_key_disabled", "API key is disabled", 401);
    if (apiKey.revokedAt) throw new RelayError("api_key_revoked", "API key has been revoked", 401);
    if (apiKey.expiresAt && apiKey.expiresAt <= nowIso()) throw new RelayError("api_key_expired", "API key has expired", 401);
    const user = await this.contexts.identity.getUser(apiKey.userId);
    if (!user) throw new RelayError("principal_not_found", "API key principal not found", 401);
    if (user.status !== "enabled") throw new RelayError("user_disabled", "User is disabled", 401);
    return { apiKey, user, effectiveScopes: await this.contexts.tenancy.listEffectiveSubscriptionScopesForUser(user.id) };
  }

  async createKey(
    input: { userId: string; name: string; expiresAt?: string | null },
    audit?: AsyncControlPlaneSessionAudit & { actor?: ReturnType<typeof actorFromClaims> },
  ): Promise<{ apiKey: ReturnType<typeof redactAsyncApiKey>; rawKey: string }> {
    const generated = createApiKey();
    const name = input.name.trim() || `Key ${createId("key").slice(-6)}`;
    return this.unitOfWorkRunner.run(async (contexts) => {
      const user = await contexts.identity.getUser(input.userId);
      if (!user) throw new RelayError("user_not_found", "User not found", 404);
      if (await contexts.identity.countEnabledApiKeysForUser(input.userId) >= user.apiKeyLimit) {
        throw new RelayError("api_key_limit_exceeded", "User API key limit has been reached", 403);
      }
      const key = await contexts.commands.identityCommands.createApiKey({
        userId: input.userId,
        name,
        expiresAt: input.expiresAt ?? null,
        keyHash: generated.hash,
        keyPrefix: generated.prefix,
        keyValue: generated.raw,
      });
      await auditSuccessAsync(contexts.commands, {
        actor: audit?.actor ?? actorFromClaims({ sub: input.userId }),
        source: audit?.source ?? "web",
        requestId: audit?.requestId,
        action: "api_key.create",
        resource: { resourceType: "api_key", resourceId: key.id },
        metadata: { userId: key.userId, name: key.name, expiresAt: key.expiresAt },
      });
      return { apiKey: redactAsyncApiKey(key), rawKey: generated.raw };
    });
  }

  async copyKeyValueForUser(
    id: string,
    userId: string,
    audit?: AsyncControlPlaneSessionAudit & { actor?: ReturnType<typeof actorFromClaims> },
  ): Promise<string> {
    const key = await this.contexts.identity.getApiKey(id);
    const actor = audit?.actor ?? actorFromClaims({ sub: userId });
    const source = audit?.source ?? "web";
    if (!key || key.userId !== userId) {
      const error = new RelayError("api_key_not_found", "API key not found", 404);
      await auditDeniedAsync(this.commandContexts, {
        actor,
        source,
        requestId: audit?.requestId,
        action: "api_key.copy",
        resource: { resourceType: "api_key", resourceId: id },
        metadata: { userId },
        error,
      });
      throw error;
    }
    if (key.status !== "enabled" || key.revokedAt || (key.expiresAt && key.expiresAt <= nowIso())) {
      const error = new RelayError("api_key_copy_unavailable", "Only an enabled, unexpired API key can be copied", 409);
      await auditFailureAsync(this.commandContexts, {
        actor,
        source,
        requestId: audit?.requestId,
        action: "api_key.copy",
        resource: { resourceType: "api_key", resourceId: key.id },
        metadata: { userId: key.userId, status: key.status },
        error,
      });
      throw error;
    }
    await auditSuccessAsync(this.commandContexts, {
      actor,
      source,
      requestId: audit?.requestId,
      action: "api_key.copy",
      resource: { resourceType: "api_key", resourceId: key.id },
      metadata: { userId: key.userId, status: key.status },
    });
    return key.keyValue;
  }

  async revokeKey(
    id: string,
    audit?: AsyncControlPlaneSessionAudit & { actor?: ReturnType<typeof actorFromClaims> },
  ) {
    return this.unitOfWorkRunner.run(async (contexts) => {
      const key = await contexts.commands.identityCommands.revokeApiKey(id);
      if (!key) throw new RelayError("api_key_not_found", "API key not found", 404);
      await auditSuccessAsync(contexts.commands, {
        actor: audit?.actor ?? actorFromClaims({ sub: key.userId }),
        source: audit?.source ?? "web",
        requestId: audit?.requestId,
        action: "api_key.revoke",
        resource: { resourceType: "api_key", resourceId: key.id },
        metadata: { userId: key.userId, name: key.name },
      });
      return redactAsyncApiKey(key);
    });
  }

  async disableKey(
    id: string,
    audit?: AsyncControlPlaneSessionAudit & { actor?: ReturnType<typeof actorFromClaims> },
  ) {
    return this.unitOfWorkRunner.run(async (contexts) => {
      const existing = await contexts.identity.getApiKey(id);
      if (!existing) throw new RelayError("api_key_not_found", "API key not found", 404);
      if (existing.status === "revoked" || existing.revokedAt) throw new RelayError("api_key_revoked", "Revoked API keys cannot be disabled", 400);
      const key = await contexts.commands.identityCommands.setApiKeyStatus(id, "disabled");
      if (!key) throw new RelayError("api_key_not_found", "API key not found", 404);
      await auditSuccessAsync(contexts.commands, {
        actor: audit?.actor ?? actorFromClaims({ sub: key.userId }),
        source: audit?.source ?? "web",
        requestId: audit?.requestId,
        action: "api_key.disable",
        resource: { resourceType: "api_key", resourceId: key.id },
        metadata: { userId: key.userId, name: key.name },
      });
      return redactAsyncApiKey(key);
    });
  }

  async enableKey(
    id: string,
    audit?: AsyncControlPlaneSessionAudit & { actor?: ReturnType<typeof actorFromClaims> },
  ) {
    return this.unitOfWorkRunner.run(async (contexts) => {
      const existing = await contexts.identity.getApiKey(id);
      if (!existing) throw new RelayError("api_key_not_found", "API key not found", 404);
      if (existing.status === "revoked" || existing.revokedAt) throw new RelayError("api_key_revoked", "Revoked API keys cannot be enabled", 400);
      const key = await contexts.commands.identityCommands.setApiKeyStatus(id, "enabled");
      if (!key) throw new RelayError("api_key_not_found", "API key not found", 404);
      await auditSuccessAsync(contexts.commands, {
        actor: audit?.actor ?? actorFromClaims({ sub: key.userId }),
        source: audit?.source ?? "web",
        requestId: audit?.requestId,
        action: "api_key.enable",
        resource: { resourceType: "api_key", resourceId: key.id },
        metadata: { userId: key.userId, name: key.name },
      });
      return redactAsyncApiKey(key);
    });
  }

  async beginPasskeyRegistration(input: {
    userId: string;
    expectedAuthVersion: number;
    surface: "owner" | "web";
    currentPassword: string;
    name: string;
    sessionHash: string;
  }): Promise<Awaited<ReturnType<typeof passkeyRegistrationOptions>>> {
    void input;
    throw retiredAuthenticationMethod("Passkey authentication is no longer available");
  }

  async completePasskeyRegistration(input: {
    userId: string;
    expectedAuthVersion: number;
    surface: "owner" | "web";
    ceremony: WebAuthnCeremony;
    response: unknown;
    requestId?: string | null;
  }): Promise<PublicPasskeyCredential> {
    void input;
    throw retiredAuthenticationMethod("Passkey authentication is no longer available");
  }

  async beginPasskeyAuthentication(input: {
    surface: "owner" | "web";
    sessionHash: string;
  }): Promise<Awaited<ReturnType<typeof passkeyAuthenticationOptions>>> {
    void input;
    throw retiredAuthenticationMethod("Passkey authentication is no longer available");
  }

  async completePasskeyAuthentication(input: {
    surface: "owner" | "web";
    ceremony: WebAuthnCeremony;
    response: unknown;
    requestId?: string | null;
  }): Promise<AuthSession> {
    void input;
    throw retiredAuthenticationMethod("Passkey authentication is no longer available");
  }

  async consumePasskeyCeremony(input: {
    surface: "owner" | "web";
    purpose: "registration" | "authentication";
    sessionHash: string;
  }): Promise<WebAuthnCeremony> {
    void input;
    throw retiredAuthenticationMethod("Passkey authentication is no longer available");
  }

  async listPasskeys(input: { userId: string; expectedAuthVersion: number; surface: "owner" | "web"; requestId?: string | null }): Promise<PublicPasskeyCredential[]> {
    void input;
    throw retiredAuthenticationMethod("Passkey authentication is no longer available");
  }

  async renamePasskey(input: { userId: string; expectedAuthVersion: number; surface: "owner" | "web"; passkeyId: string; name: string; requestId?: string | null }): Promise<PublicPasskeyCredential> {
    void input;
    throw retiredAuthenticationMethod("Passkey authentication is no longer available");
  }

  async deletePasskey(input: {
    userId: string;
    expectedAuthVersion: number;
    surface: "owner" | "web";
    passkeyId: string;
    currentPassword: string;
    requestId?: string | null;
  }): Promise<AuthSession> {
    void input;
    throw retiredAuthenticationMethod("Passkey authentication is no longer available");
  }

  async previewTeamInviteLink(inviteLinkId: string, options: { allowRegistrationTarget?: boolean } = {}): Promise<{ inviteLink: TeamInviteLink; team: Team; memberInvitesEnabled: boolean }> {
    const inviteLink = await this.contexts.tenancy.getInviteLink(inviteLinkId);
    if (!inviteLink || inviteLink.status !== "enabled") throw new RelayError("team_invite_link_not_found", "Team invite link not found", 404);
    const team = await this.contexts.tenancy.getTeam(inviteLink.teamId);
    if (!team || !(await this.contexts.tenancy.isTeamAvailable(team.id))) throw new RelayError("team_invite_link_not_found", "Team invite link not found", 404);
    if (!options.allowRegistrationTarget && inviteLink.createdByUserId !== team.ownerId && !(await this.contexts.authority.platformRolesForUser(inviteLink.createdByUserId)).includes("owner")) {
      const [membership, memberInvitesEnabled] = await Promise.all([
        this.contexts.tenancy.getMembership(team.id, inviteLink.createdByUserId),
        this.contexts.tenancy.isTeamMemberInvitesEnabled(team.id)
      ]);
      if (!membership || !memberInvitesEnabled) throw new RelayError("team_invite_link_not_found", "Team invite link not found", 404);
    }
    return { inviteLink, team, memberInvitesEnabled: await this.contexts.tenancy.isTeamMemberInvitesEnabled(team.id) };
  }

  async resolveUserTeamId(claims: AccessTokenClaims, requestedTeamId?: string | null, options: { allowPlatformOwner?: boolean } = {}): Promise<string> {
    const memberships = await this.contexts.tenancy.listAvailableMembershipsForUser(claims.sub);
    if (requestedTeamId) {
      if ((options.allowPlatformOwner ?? true) && claims.platformRoles.includes("owner") && await this.isPlatformOwnerUser(claims.sub)) return requestedTeamId;
      if (!memberships.some((membership) => membership.teamId === requestedTeamId)) throw new RelayError("forbidden", "User is not a member of the requested team", 403);
      return requestedTeamId;
    }
    if (memberships.length === 1) return memberships[0]!.teamId;
    if (memberships.length === 0) throw new RelayError("team_required", "User has no enabled team membership", 403);
    throw new RelayError("team_required", "Team selection is required", 400);
  }

  async requirePermission(
    claims: AccessTokenClaims,
    request: { resourceType: string; resourceId: string; action: string },
    options: { allowPlatformOwner?: boolean } = {},
  ): Promise<void> {
    if ((options.allowPlatformOwner ?? true) && claims.platformRoles.includes("owner") && await this.isPlatformOwnerUser(claims.sub)) return;
    if (!(await this.hasPermission(claims.sub, request))) throw new RelayError("forbidden", `Permission ${request.action} is required`, 403);
  }

  async hasPermission(userId: string, request: { resourceType: string; resourceId: string; action: string }): Promise<boolean> {
    const user = await this.contexts.identity.getUser(userId);
    if (!user || user.status !== "enabled") return false;
    const permissions = (await this.contexts.tenancy.listResourcePermissions(request.resourceType, request.resourceId))
      .filter((permission) => permission.status === "enabled" && permission.action === request.action);
    if (permissions.length === 0) return false;
    const subjects = new Set<string>([
      permissionSubjectKey({ subjectType: "user", subjectRef: userId, subjectRole: null }),
    ]);
    for (const membership of await this.contexts.tenancy.listAvailableMembershipsForUser(userId)) {
      subjects.add(permissionSubjectKey({ subjectType: "team", subjectRef: membership.teamId, subjectRole: null }));
      subjects.add(permissionSubjectKey({ subjectType: "member", subjectRef: membership.id, subjectRole: null }));
      for (const role of teamMembershipRoles(membership)) {
        subjects.add(permissionSubjectKey({ subjectType: "team_role", subjectRef: membership.teamId, subjectRole: role }));
      }
    }
    if (request.resourceType === "team") {
      const team = await this.contexts.tenancy.getTeam(request.resourceId);
      if (team && await this.contexts.tenancy.isTeamAvailable(team.id) && team.ownerId === userId) {
        subjects.add(permissionSubjectKey({ subjectType: "team_role", subjectRef: team.id, subjectRole: "owner" }));
      }
    }
    return permissions.some((permission) => subjects.has(permissionSubjectKey({
      subjectType: permission.subjectType as ResourcePermissionSubjectType,
      subjectRef: permission.subjectRef,
      subjectRole: permission.subjectRole,
    })));
  }

  async getTeamInviteSettings(teamId: string, actorUserId: string, options: { allowPlatformOwner?: boolean } = {}) {
    const team = await this.contexts.tenancy.getTeam(teamId);
    if (!team) throw new RelayError("team_not_found", "Team not found", 404);
    const isAdmin = options.allowPlatformOwner === true && await this.isPlatformOwnerUser(actorUserId);
    if (!isAdmin && team.status !== "enabled") throw new RelayError("team_disabled", "team is disabled", 403);
    const isMember = Boolean(await this.contexts.tenancy.getMembership(teamId, actorUserId));
    if (!isAdmin && !isMember && team.ownerId !== actorUserId) throw new RelayError("forbidden", "User is not a member of this team", 403);
    const isOwner = team.ownerId === actorUserId;
    const canManage = isOwner || isAdmin;
    return {
      teamId,
      memberInvitesEnabled: await this.contexts.tenancy.isTeamMemberInvitesEnabled(teamId),
      inviteEmailDomainRestricted: team.inviteEmailDomainPattern !== null,
      ...(canManage ? { inviteEmailDomainPattern: team.inviteEmailDomainPattern } : {}),
      capabilities: {
        canCreateInviteLinks: isAdmin || await this.hasPermission(actorUserId, { resourceType: "team", resourceId: teamId, action: "team.invite_link.create" }),
        canManageInviteSettings: canManage,
        canManageAllInviteLinks: canManage,
        canCreateUnlimitedInviteLinks: isAdmin || await this.hasPermission(actorUserId, { resourceType: "user", resourceId: actorUserId, action: "user.domain_binding.manage" }),
      },
    };
  }

  async assertTeamInviteLinksReadable(teamId: string, scope: "mine" | "all", actorUserId: string, options: { allowPlatformOwner?: boolean } = {}): Promise<void> {
    const team = await this.contexts.tenancy.getTeam(teamId);
    if (!team) throw new RelayError("team_not_found", "Team not found", 404);
    const isOwner = team.ownerId === actorUserId;
    const isAdmin = options.allowPlatformOwner === true && await this.isPlatformOwnerUser(actorUserId);
    if (!isAdmin && team.status !== "enabled") throw new RelayError("team_disabled", "team is disabled", 403);
    const isMember = Boolean(await this.contexts.tenancy.getMembership(teamId, actorUserId));
    if (!isOwner && !isAdmin && !isMember) throw new RelayError("forbidden", "User is not a member of this team", 403);
    if (scope === "all" && !isOwner && !isAdmin) throw new RelayError("forbidden", "Only Team Owner or Platform Owner can list all invite links", 403);
  }

  async listTeamInviteLinksForActor(teamId: string, scope: "mine" | "all", actorUserId: string, options: { allowPlatformOwner?: boolean } = {}): Promise<TeamInviteLink[]> {
    await this.assertTeamInviteLinksReadable(teamId, scope, actorUserId, options);
    return scope === "all"
      ? this.contexts.tenancy.listInviteLinks(teamId)
      : this.contexts.tenancy.listInviteLinks(teamId, actorUserId);
  }

  async updateTeamInviteSettings(
    teamId: string,
    input: { memberInvitesEnabled?: boolean; inviteEmailDomainPattern?: string | null },
    audit: AsyncControlPlaneSessionAudit & { actor: ReturnType<typeof actorFromClaims> },
  ) {
    const team = await this.contexts.tenancy.getTeam(teamId);
    if (!team) throw new RelayError("team_not_found", "Team not found", 404);
    if (!(await this.contexts.tenancy.isTeamAvailable(teamId))) throw new RelayError("team_disabled", "team is disabled", 403);
    if (audit.actor.actorType !== "user") throw new RelayError("user_actor_required", "A user actor is required", 403);
    const isOwner = team.ownerId === audit.actor.actorId;
    const isAdmin = audit.source === "owner" && await this.isPlatformOwnerUser(audit.actor.actorId);
    if (!isOwner && !isAdmin) throw new RelayError("forbidden", "Team owner role is required", 403);
    if (input.memberInvitesEnabled === undefined && input.inviteEmailDomainPattern === undefined) throw new RelayError("invalid_team_invite_setting", "At least one invite setting must be provided", 400);
    const nextPattern = input.inviteEmailDomainPattern === undefined
      ? team.inviteEmailDomainPattern
      : normalizeInviteEmailDomainPattern(input.inviteEmailDomainPattern);
    const result = await this.unitOfWorkRunner.run(async (transaction) => {
      if (input.memberInvitesEnabled !== undefined) {
        await transaction.commands.tenancyCommands.upsertResourcePermission({
          resourceType: "team",
          resourceId: teamId,
          action: "team.invite_link.create",
          subjectType: "team",
          subjectRef: teamId,
          status: input.memberInvitesEnabled ? "enabled" : "disabled",
        });
      }
      if (input.inviteEmailDomainPattern !== undefined) await transaction.commands.tenancyCommands.updateInviteEmailDomain(teamId, nextPattern);
      let disabledMemberLinkCount = 0;
      if (input.memberInvitesEnabled === false) {
        for (const link of await transaction.tenancy.listEnabledNonOwnerInviteLinks(teamId, team.ownerId)) {
          const creatorIsOwner = (await transaction.identity.getUser(link.createdByUserId))?.status === "enabled"
            && (await transaction.authority.platformRolesForUser(link.createdByUserId)).includes("owner");
          if (creatorIsOwner) continue;
          const disabled = await transaction.commands.tenancyCommands.disableInviteLink(link.id);
          if (!disabled) continue;
          await auditSuccessAsync(transaction.commands, {
            actor: audit.actor,
            source: audit.source,
            requestId: audit.requestId,
            action: "team_invite_link.disable",
            resource: { resourceType: "team_invite_link", resourceId: disabled.id },
            metadata: { inviteLinkId: disabled.id, teamId, creatorId: disabled.createdByUserId, reason: "setting_disabled" },
          });
          disabledMemberLinkCount += 1;
        }
      }
      const memberInvitesEnabled = input.memberInvitesEnabled ?? await transaction.tenancy.isTeamMemberInvitesEnabled(teamId);
      await auditSuccessAsync(transaction.commands, {
        actor: audit.actor,
        source: audit.source,
        requestId: audit.requestId,
        action: "team_invite_setting.update",
        resource: { resourceType: "team", resourceId: teamId },
        metadata: {
          teamId,
          changedFields: [
            ...(input.memberInvitesEnabled !== undefined ? ["memberInvitesEnabled"] : []),
            ...(input.inviteEmailDomainPattern !== undefined ? ["inviteEmailDomainPattern"] : []),
          ],
          ...(input.memberInvitesEnabled !== undefined ? { enabled: input.memberInvitesEnabled } : {}),
          emailDomainRestricted: nextPattern !== null,
          disabledMemberLinkCount,
        },
      });
      return { memberInvitesEnabled, disabledMemberLinkCount };
    });
    return {
      teamId,
      memberInvitesEnabled: result.memberInvitesEnabled,
      inviteEmailDomainRestricted: nextPattern !== null,
      inviteEmailDomainPattern: nextPattern,
      isOwner,
      canManage: true,
      disabledMemberLinkCount: result.disabledMemberLinkCount,
    };
  }

  async createTeamInviteLink(teamId: string, audit: AsyncControlPlaneSessionAudit & { actor: ReturnType<typeof actorFromClaims> }, requestedMaxUses?: unknown): Promise<TeamInviteLinkCreateResult> {
    const team = await this.contexts.tenancy.getTeam(teamId);
    if (!team) throw new RelayError("team_not_found", "Team not found", 404);
    if (!(await this.contexts.tenancy.isTeamAvailable(teamId))) throw new RelayError("team_disabled", "team is disabled", 403);
    if (audit.actor.actorType !== "user") throw new RelayError("user_actor_required", "A user actor is required to create team invite links", 403);
    const actorUserId = audit.actor.actorId;
    const isAdmin = audit.source === "owner" && await this.isPlatformOwnerUser(actorUserId);
    const isOwner = team.ownerId === actorUserId;
    const canCreateUnlimited = isAdmin || await this.hasPermission(actorUserId, { resourceType: "user", resourceId: actorUserId, action: "user.domain_binding.manage" });
    const maxUses = normalizeAsyncTeamInviteLinkMaxUses(requestedMaxUses, canCreateUnlimited);
    if (!isAdmin && !isOwner && !(await this.contexts.tenancy.getMembership(teamId, actorUserId))) throw new RelayError("forbidden", "User is not a member of this team", 403);
    if (!isAdmin && !isOwner && !(await this.hasPermission(actorUserId, { resourceType: "team", resourceId: teamId, action: "team.invite_link.create" }))) throw new RelayError("forbidden", "Invite link creation is not enabled for this member", 403);
    return this.unitOfWorkRunner.run(async (contexts) => {
      const result = isOwner || isAdmin
        ? { inviteLink: await contexts.commands.tenancyCommands.createInviteLink({ teamId, createdByUserId: actorUserId, maxUses, activeLimitExempt: true }), outcome: "created" as const }
        : await contexts.commands.tenancyCommands.getOrCreateActiveInviteLink(teamId, actorUserId, maxUses);
      if (result.outcome === "created") {
        await auditSuccessAsync(contexts.commands, {
          actor: audit.actor,
          source: audit.source,
          requestId: audit.requestId,
          action: "team_invite_link.create",
          resource: { resourceType: "team_invite_link", resourceId: result.inviteLink.id },
          metadata: { inviteLinkId: result.inviteLink.id, teamId, createdByUserId: result.inviteLink.createdByUserId, capacityMode: result.inviteLink.maxUses === null ? "unlimited" : "capped", ...(result.inviteLink.maxUses === null ? {} : { maxUses: result.inviteLink.maxUses }), outcome: result.outcome },
        });
      }
      return result;
    });
  }

  async disableTeamInviteLink(teamId: string, inviteLinkId: string, audit: AsyncControlPlaneSessionAudit & { actor: ReturnType<typeof actorFromClaims> }): Promise<TeamInviteLink> {
    const inviteLink = await this.contexts.tenancy.getInviteLink(inviteLinkId);
    if (!inviteLink || inviteLink.teamId !== teamId) throw new RelayError("team_invite_link_not_found", "Team invite link not found", 404);
    if (audit.actor.actorType !== "user") throw new RelayError("user_actor_required", "A user actor is required to disable team invite links", 403);
    const team = await this.contexts.tenancy.getTeam(teamId);
    if (!team) throw new RelayError("team_not_found", "Team not found", 404);
    const actorUserId = audit.actor.actorId;
    const isOwner = team.ownerId === actorUserId;
    const isAdmin = audit.source === "owner" && await this.isPlatformOwnerUser(actorUserId);
    const isCurrentMember = Boolean(await this.contexts.tenancy.getMembership(teamId, actorUserId));
    if (!isOwner && !isAdmin && (!isCurrentMember || inviteLink.createdByUserId !== actorUserId)) throw new RelayError("team_invite_link_not_found", "Team invite link not found", 404);
    if (inviteLink.status !== "enabled") return inviteLink;
    return this.unitOfWorkRunner.run(async (contexts) => {
      const disabled = await contexts.commands.tenancyCommands.disableInviteLink(inviteLink.id);
      if (!disabled) throw new RelayError("team_invite_link_not_found", "Team invite link not found", 404);
      await auditSuccessAsync(contexts.commands, {
        actor: audit.actor,
        source: audit.source,
        requestId: audit.requestId,
        action: "team_invite_link.disable",
        resource: { resourceType: "team_invite_link", resourceId: disabled.id },
        metadata: { inviteLinkId: disabled.id, teamId, creatorId: disabled.createdByUserId, reason: isAdmin ? "owner" : isOwner ? "owner" : "self" },
      });
      return disabled;
    });
  }

  async addTeamMember(teamId: string, userId: string, audit: AsyncControlPlaneSessionAudit & { actor: ReturnType<typeof actorFromClaims> }): Promise<TeamMembership> {
    const team = await this.contexts.tenancy.getTeam(teamId);
    if (!team) throw new RelayError("team_not_found", "Team not found", 404);
    if (!(await this.contexts.tenancy.isTeamAvailable(teamId))) throw new RelayError("team_disabled", "team is disabled", 403);
    const user = await this.contexts.identity.getUser(userId);
    if (!user) throw new RelayError("user_not_found", "User not found", 404);
    assertEnabled(user.status, "user");
    if (await this.contexts.tenancy.getMembership(teamId, userId)) throw new RelayError("team_member_already_exists", "User is already a member of this team", 409);
    return this.unitOfWorkRunner.run(async (contexts) => {
      const membership = await contexts.commands.tenancyCommands.grantMembership(teamId, userId);
      await auditSuccessAsync(contexts.commands, {
        actor: audit.actor,
        source: audit.source,
        requestId: audit.requestId,
        action: "team_member.add",
        resource: { resourceType: "team_membership", resourceId: membership.id },
        metadata: { teamId, userId },
      });
      return membership;
    });
  }

  async removeTeamMember(teamId: string, userId: string, audit: AsyncControlPlaneSessionAudit & { actor: ReturnType<typeof actorFromClaims> }): Promise<TeamMembership> {
    const team = await this.contexts.tenancy.getTeam(teamId);
    if (!team) throw new RelayError("team_not_found", "Team not found", 404);
    if (!(await this.contexts.tenancy.isTeamAvailable(teamId))) throw new RelayError("team_disabled", "team is disabled", 403);
    if (team.ownerId === userId) throw new RelayError("team_owner_member_remove_blocked", "Change the team owner before removing this member", 409);
    if (!(await this.contexts.tenancy.getMembership(teamId, userId))) throw new RelayError("team_member_not_found", "Team member not found", 404);
    return this.unitOfWorkRunner.run(async (transaction) => {
      for (const link of await transaction.tenancy.listEnabledInviteLinksByCreator(teamId, userId)) {
        const disabled = await transaction.commands.tenancyCommands.disableInviteLink(link.id);
        if (!disabled) continue;
        await auditSuccessAsync(transaction.commands, {
          actor: audit.actor,
          source: audit.source,
          requestId: audit.requestId,
          action: "team_invite_link.disable",
          resource: { resourceType: "team_invite_link", resourceId: disabled.id },
          metadata: { inviteLinkId: disabled.id, teamId, creatorId: disabled.createdByUserId, reason: "member_removed" },
        });
      }
      const revoked = await transaction.commands.tenancyCommands.removeMembership(teamId, userId);
      if (!revoked) throw new RelayError("team_member_not_found", "Team member not found", 404);
      await auditSuccessAsync(transaction.commands, {
        actor: audit.actor,
        source: audit.source,
        requestId: audit.requestId,
        action: "team_member.remove",
        resource: { resourceType: "team_membership", resourceId: revoked.id },
        metadata: { teamId, userId },
      });
      return revoked;
    });
  }

  async updateTeamMemberRoles(teamId: string, userId: string, roles: Array<"viewer" | "billing" | "manager">, audit: AsyncControlPlaneSessionAudit & { actor: ReturnType<typeof actorFromClaims> }): Promise<TeamMembership> {
    const team = await this.contexts.tenancy.getTeam(teamId);
    if (!team) throw new RelayError("team_not_found", "Team not found", 404);
    if (!(await this.contexts.tenancy.isTeamAvailable(teamId))) throw new RelayError("team_disabled", "team is disabled", 403);
    if (!(await this.contexts.tenancy.getMembership(teamId, userId))) throw new RelayError("team_member_not_found", "Team member not found", 404);
    return this.unitOfWorkRunner.run(async (contexts) => {
      const updated = await contexts.commands.tenancyCommands.changeMembershipRoles(teamId, userId, roles);
      if (!updated) throw new RelayError("team_member_not_found", "Team member not found", 404);
      await auditSuccessAsync(contexts.commands, {
        actor: audit.actor,
        source: audit.source,
        requestId: audit.requestId,
        action: "team_member_roles.update",
        resource: { resourceType: "team_membership", resourceId: updated.id },
        metadata: { teamId, targetUserId: userId, roles: teamMembershipRoles(updated) },
      });
      return updated;
    });
  }

  async createUserWithPassword(input: { teamId: string; email: string; password: unknown; status?: string }, audit: AsyncControlPlaneSessionAudit & { actor: ReturnType<typeof actorFromClaims> }): Promise<PublicUser> {
    const password = requiredNewPassword(input.password);
    const normalizedEmail = normalizeInviteEmail(input.email);
    const user = await this.unitOfWorkRunner.run(async (transaction) => {
      const team = await transaction.tenancy.getTeam(input.teamId);
      if (!team) throw new RelayError("team_not_found", "Team not found", 404);
      if (!(await transaction.tenancy.isTeamAvailable(input.teamId))) throw new RelayError("team_disabled", "team is disabled", 403);
      if (await transaction.identity.findUserByEmail(EmailAddr.restore(normalizedEmail))) throw new RelayError("email_already_registered", "Email is already registered", 409);
      const created = await transaction.commands.identityCommands.createUser({
        id: createId("user"),
        teamId: input.teamId,
        email: EmailAddr.restore(normalizedEmail),
        passwordHash: await createPasswordHash(password),
        ...(input.status ? { status: input.status } : {}),
      });
      await transaction.commands.tenancyCommands.grantMembership(input.teamId, created.id);
      await auditSuccessAsync(transaction.commands, {
        actor: audit.actor,
        source: audit.source,
        requestId: audit.requestId,
        action: "user.create",
        resource: { resourceType: "user", resourceId: created.id },
        metadata: { teamId: input.teamId, status: created.status },
      });
      return created;
    });
    return this.publicUserFor(user, "web");
  }

  async updateUserApiKeyLimit(id: string, input: { apiKeyLimit: number }, audit: AsyncControlPlaneSessionAudit & { actor: ReturnType<typeof actorFromClaims> }): Promise<PublicUser> {
    const apiKeyLimit = normalizeAsyncApiKeyLimit(input.apiKeyLimit);
    const user = await this.unitOfWorkRunner.run(async (contexts) => {
      const updated = await contexts.commands.identityCommands.updateUserApiKeyLimit(id, apiKeyLimit);
      if (!updated) throw new RelayError("user_not_found", "User not found", 404);
      await auditSuccessAsync(contexts.commands, {
        actor: audit.actor,
        source: audit.source,
        requestId: audit.requestId,
        action: "user.update",
        resource: { resourceType: "user", resourceId: updated.id },
        metadata: { field: "apiKeyLimit", apiKeyLimit },
      });
      return updated;
    });
    return this.publicUserFor(user, "web");
  }

  async createTeam(input: { name: string }, audit: AsyncControlPlaneSessionAudit & { actor: ReturnType<typeof actorFromClaims> }): Promise<Team> {
    return this.unitOfWorkRunner.run(async (contexts) => {
      const { team } = await contexts.commands.tenancyCommands.createTeamWithOwnerMembership({ ownerUserId: audit.actor.actorId, name: input.name });
      await auditSuccessAsync(contexts.commands, {
        actor: audit.actor, source: audit.source, requestId: audit.requestId,
        action: "team.create", resource: { resourceType: "team", resourceId: team.id },
        metadata: { name: team.name, ownerId: team.ownerId, status: team.status },
      });
      return team;
    });
  }

  async updateTeam(teamId: string, input: { name?: string; teamOwnerCanManageMemberApiKeyLimit?: number; teamOwnerCanManageMemberCredit?: number; teamOwnerCanCreateAccessPoint?: number }, audit: AsyncControlPlaneSessionAudit & { actor: ReturnType<typeof actorFromClaims> }): Promise<Team> {
    return this.unitOfWorkRunner.run(async (contexts) => {
      const team = await contexts.commands.tenancyCommands.updateTeamManagementSettings(teamId, input);
      await auditSuccessAsync(contexts.commands, {
        actor: audit.actor, source: audit.source, requestId: audit.requestId,
        action: "team.update", resource: { resourceType: "team", resourceId: team.id },
        metadata: { teamId: team.id, name: team.name, status: team.status },
      });
      return team;
    });
  }

  async requestTeamDeletion(teamId: string, audit: AsyncControlPlaneSessionAudit & { actor: ReturnType<typeof actorFromClaims> }) {
    return this.unitOfWorkRunner.run(async (contexts) => {
      const lifecycle = await contexts.commands.tenancyCommands.requestTeamDeletion(teamId, audit.actor.actorId);
      await auditSuccessAsync(contexts.commands, {
        actor: audit.actor, source: audit.source, requestId: audit.requestId,
        action: "team.delete.request", resource: { resourceType: "team", resourceId: teamId },
        metadata: { teamId, purgeNotBefore: lifecycle.purgeNotBefore },
      });
      return lifecycle;
    });
  }

  async cancelTeamDeletion(teamId: string, audit: AsyncControlPlaneSessionAudit & { actor: ReturnType<typeof actorFromClaims> }) {
    return this.unitOfWorkRunner.run(async (contexts) => {
      const lifecycle = await contexts.commands.tenancyCommands.cancelTeamDeletion(teamId);
      await auditSuccessAsync(contexts.commands, {
        actor: audit.actor, source: audit.source, requestId: audit.requestId,
        action: "team.delete.cancel", resource: { resourceType: "team", resourceId: teamId },
        metadata: { teamId, deletionRequestId: lifecycle.id },
      });
      return lifecycle;
    });
  }

  async updateUserProfile(userId: string, input: { adminNote?: string | null; userCanCreateCustomProvider?: number; userCanCreateAccessPoint?: number }, audit: AsyncControlPlaneSessionAudit & { actor: ReturnType<typeof actorFromClaims> }): Promise<User> {
    return this.unitOfWorkRunner.run(async (contexts) => {
      const user = await contexts.commands.identityCommands.updateUserProfile(userId, input);
      if (!user) throw new RelayError("user_not_found", "User not found", 404);
      await auditSuccessAsync(contexts.commands, {
        actor: audit.actor, source: audit.source, requestId: audit.requestId,
        action: "user.update", resource: { resourceType: "user", resourceId: user.id },
        metadata: { fields: Object.keys(input).sort() },
      });
      return user;
    });
  }

  async publicUser(userId: string, surface: "owner" | "web" = "web"): Promise<PublicUser> {
    const user = await this.contexts.identity.getUser(userId);
    if (!user) throw new RelayError("user_not_found", "User not found", 404);
    return this.publicUserFor(user, surface);
  }

  async acceptTeamInviteLink(
    inviteLinkId: string,
    input: { userId: string } | { email: string; passwordHash: string },
    audit?: AsyncControlPlaneSessionAudit & { actor?: ReturnType<typeof actorFromClaims> },
    options: { allowRegistrationTarget?: boolean } = {},
  ): Promise<{ inviteLink: TeamInviteLink; membership: TeamMembership; outcome: "joined" | "already_joined"; user: PublicUser }> {
    const accepted = await this.unitOfWorkRunner.run(async (transaction) => {
      const inviteLink = await transaction.tenancy.getInviteLink(inviteLinkId);
      if (!inviteLink || inviteLink.status !== "enabled") throw new RelayError("team_invite_link_not_found", "Team invite link not found", 404);
      const team = await transaction.tenancy.getTeam(inviteLink.teamId);
      if (!team || !(await transaction.tenancy.isTeamAvailable(team.id))) throw new RelayError("team_invite_link_not_found", "Team invite link not found", 404);
      if (!options.allowRegistrationTarget && inviteLink.createdByUserId !== team.ownerId && !(await transaction.authority.platformRolesForUser(inviteLink.createdByUserId)).includes("owner")) {
        const [membership, memberInvitesEnabled] = await Promise.all([
          transaction.tenancy.getMembership(team.id, inviteLink.createdByUserId),
          transaction.tenancy.isTeamMemberInvitesEnabled(team.id),
        ]);
        if (!membership || !memberInvitesEnabled) throw new RelayError("team_invite_link_not_found", "Team invite link not found", 404);
      }
      const user = "userId" in input
        ? await transaction.identity.getUser(input.userId)
        : {
          id: createId("user"),
          teamId: team.id,
          email: normalizeInviteEmail(input.email),
          passwordHash: input.passwordHash,
          authVersion: 1,
          status: "enabled",
          adminNote: null,
          apiKeyLimit: 3,
          userCanCreateCustomProvider: 0,
          userCanCreateAccessPoint: 0,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        } satisfies User;
      if (!user) throw new RelayError("user_not_found", "User not found", 404);
      if (!("userId" in input) && await transaction.identity.findUserByEmail(EmailAddr.restore(user.email))) throw new RelayError("email_already_registered", "Email is already registered", 409);
      const existingMembership = await transaction.tenancy.getMembership(team.id, user.id);
      let accepted: { inviteLink: TeamInviteLink; team: Team; membership: TeamMembership; outcome: "joined" | "already_joined"; user: User };
      if (existingMembership) {
        accepted = { inviteLink, team, membership: existingMembership, outcome: "already_joined", user };
      } else {
        if (!inviteEmailDomainAllowed(user.email, team.inviteEmailDomainPattern)) throw new RelayError("invite_email_domain_not_allowed", "This email domain is not allowed to join this Team", 403);
        const consumedInviteLink = await transaction.commands.tenancyCommands.consumeInviteLink(inviteLink.id);
        const persistedUser = await transaction.identity.getUser(user.id) ?? await transaction.commands.identityCommands.createUser({
          id: user.id,
          teamId: team.id,
          email: EmailAddr.restore(user.email),
          passwordHash: user.passwordHash,
          authVersion: user.authVersion,
          status: user.status,
          adminNote: user.adminNote,
          apiKeyLimit: user.apiKeyLimit,
          userCanCreateCustomProvider: user.userCanCreateCustomProvider,
          userCanCreateAccessPoint: user.userCanCreateAccessPoint,
          createdAt: user.createdAt,
        });
        const membership = await transaction.commands.tenancyCommands.grantMembership(team.id, persistedUser.id, ["viewer"], consumedInviteLink.id);
        accepted = { inviteLink: consumedInviteLink, team, membership, outcome: "joined", user: persistedUser };
      }
      const acceptingActor = audit?.actor ?? actorFromClaims({ sub: accepted.user.id });
      if (accepted.outcome === "joined" && accepted.inviteLink.status === "disabled" && accepted.inviteLink.maxUses !== null && accepted.inviteLink.usedCount === accepted.inviteLink.maxUses) {
        await auditSuccessAsync(transaction.commands, {
          actor: acceptingActor,
          source: audit?.source ?? "web",
          requestId: audit?.requestId,
          action: "team_invite_link.disable",
          resource: { resourceType: "team_invite_link", resourceId: accepted.inviteLink.id },
          metadata: { inviteLinkId: accepted.inviteLink.id, teamId: accepted.team.id, creatorId: accepted.inviteLink.createdByUserId, reason: "max_uses_reached", usedCount: accepted.inviteLink.usedCount, maxUses: accepted.inviteLink.maxUses },
        });
      }
      await auditSuccessAsync(transaction.commands, {
        actor: acceptingActor,
        source: audit?.source ?? "web",
        requestId: audit?.requestId,
        action: "team_invite_link.accept",
        resource: { resourceType: "team_membership", resourceId: accepted.membership.id },
        metadata: { inviteLinkId: accepted.inviteLink.id, teamId: accepted.team.id, userId: accepted.user.id, membershipId: accepted.membership.id, outcome: accepted.outcome, usedCount: accepted.inviteLink.usedCount, maxUses: accepted.inviteLink.maxUses },
      });
      return accepted;
    });
    return { inviteLink: accepted.inviteLink, membership: accepted.membership, outcome: accepted.outcome, user: await this.publicUserFor(accepted.user, "web") };
  }

  async acceptTeamInviteLinkWithCredentials(
    inviteLinkId: string,
    input: { email: string; password: unknown },
    audit: AsyncControlPlaneSessionAudit,
    options: { allowRegistrationTarget?: boolean } = {},
  ): Promise<{ accountOutcome: "created" | "already_registered"; result: { inviteLink: TeamInviteLink; membership: TeamMembership; outcome: "joined" | "already_joined"; user: PublicUser }; session: AuthSession }> {
    void inviteLinkId;
    void input;
    void audit;
    void options;
    throw retiredAuthenticationMethod("Friday JWT authentication has been retired; use Better Auth");
  }

  async acceptTeamInviteLinkWithCredentialsAndBetterAuth(
    inviteLinkId: string,
    input: { email: string; password: unknown },
    request: ValidatedAuthMutationRequest,
    audit: AsyncControlPlaneSessionAudit,
    options: { allowRegistrationTarget?: boolean } = {},
  ): Promise<{ accountOutcome: "created" | "already_registered"; result: { inviteLink: TeamInviteLink; membership: TeamMembership; outcome: "joined" | "already_joined"; user: PublicUser }; session: BetterAuthLoginResult }> {
    await this.previewTeamInviteLink(inviteLinkId, options);
    const normalizedEmail = normalizeInviteEmail(input.email);
    const password = requiredPasswordString(input.password);
    const existingUser = await this.contexts.identity.findUserByEmail(EmailAddr.restore(normalizedEmail));
    let result;
    let accountOutcome: "created" | "already_registered";
    if (existingUser) {
      const credentialHash = await this.requireBetterAuthRuntime().findCredentialPassword(existingUser.id);
      if (!credentialHash || !(await verifyPassword(password, credentialHash))) throw new RelayError("invalid_credentials", "Invalid email or password", 401);
      assertEnabled(existingUser.status, "user");
      result = await this.acceptTeamInviteLink(inviteLinkId, { userId: existingUser.id }, { ...audit, actor: actorFromClaims({ sub: existingUser.id }) }, options);
      accountOutcome = "already_registered";
    } else {
      const newPassword = requiredNewPassword(password);
      result = await this.acceptTeamInviteLink(inviteLinkId, { email: normalizedEmail, passwordHash: await createPasswordHash(newPassword) }, audit, options);
      accountOutcome = "created";
    }
    const session = await this.loginWithBetterAuth(normalizedEmail, password, request, audit);
    return { accountOutcome, result, session };
  }

  private async isPlatformOwnerUser(userId: string): Promise<boolean> {
    const user = await this.contexts.identity.getUser(userId);
    return user?.status === "enabled" && (await this.contexts.authority.platformRolesForUser(userId)).includes("owner");
  }

  private async requirePasskeyManagementUser(userId: string, expectedAuthVersion: number, surface: "owner" | "web"): Promise<User> {
    const user = await this.contexts.identity.getUser(userId);
    if (!user || user.status !== "enabled" || user.authVersion !== expectedAuthVersion) {
      throw new RelayError("unauthorized", "Invalid or expired authentication state", 401);
    }
    await this.assertSessionSurfaceAllowed(user, surface);
    return user;
  }

  private publicPasskeyCredential(credential: PasskeyCredential): PublicPasskeyCredential {
    const availableOn = (["web", "admin"] as const).filter((surface) => passkeySurfaceConfig(this.config, surface)?.rpId === credential.rpId);
    return {
      id: credential.id,
      name: credential.name,
      deviceType: credential.deviceType,
      backedUp: credential.backedUp === 1,
      createdAt: credential.createdAt,
      lastUsedAt: credential.lastUsedAt,
      updatedAt: credential.updatedAt,
      availableOn,
    };
  }

  private async createSession(
    user: Parameters<typeof publicUser>[0],
    surface: "owner" | "web",
    contexts?: IdentityTenancyBoundContext,
  ): Promise<AuthSession> {
    const queries = contexts ?? this.contexts;
    const commands = contexts?.commands ?? this.commandContexts;
    await this.assertSessionSurfaceAllowed(user, surface, queries);
    const refresh = createRefreshToken();
    await commands.identityCommands.createRefreshTokenForAuthVersion({
      userId: user.id,
      expectedAuthVersion: user.authVersion,
      tokenHash: refresh.hash,
      expiresAt: refreshTokenExpiresAt(this.config)
    });
    return this.sessionPayload(user, surface, refresh.raw, queries);
  }

  private async sessionPayload(
    user: Parameters<typeof publicUser>[0],
    surface: "owner" | "web",
    refreshToken: string,
    contexts: AsyncControlPlaneTenancyQueries = this.contexts,
  ): Promise<AuthSession> {
    const publicProfile = await this.publicUserFor(user, surface, contexts);
    const accessToken = signAccessToken(this.config, {
      sub: user.id,
      email: user.email,
      authVersion: user.authVersion,
      platformRoles: publicProfile.platformRoles,
      teamRoles: publicProfile.teamRoles
    });
    return { accessToken, refreshToken, user: publicProfile };
  }

  private async assertSessionSurfaceAllowed(
    user: Parameters<typeof publicUser>[0],
    surface: "owner" | "web",
    contexts: AsyncControlPlaneTenancyQueries = this.contexts,
  ): Promise<void> {
    if (surface === "owner" && !(await this.publicUserFor(user, "owner", contexts)).platformRoles.includes("owner")) {
      throw new RelayError("owner_login_forbidden", "Platform Owner role is required for the Owner Console", 403);
    }
  }

  private async requireCurrentAuthVersion(claims: AccessTokenClaims): Promise<AccessTokenClaims> {
    const user = await this.contexts.identity.getUser(claims.sub);
    if (!user || user.status !== "enabled" || user.authVersion !== claims.authVersion) {
      throw new RelayError("unauthorized", "Invalid or expired access token", 401);
    }
    return claims;
  }

  private requireBetterAuthRuntime(): BetterAuthRuntime {
    if (!this.betterAuthRuntime) throw new RelayError("auth_provider_unavailable", "Authentication provider is unavailable", 500);
    return this.betterAuthRuntime;
  }

  private async publicUserFor(
    user: Parameters<typeof publicUser>[0],
    surface: "owner" | "web",
    contexts: AsyncControlPlaneTenancyQueries = this.contexts,
  ): Promise<PublicUser> {
    const [platformRoleSource, memberships, teamRoleSource] = await Promise.all([
      contexts.authority.platformRolesForUser(user.id),
      contexts.tenancy.listAvailableMembershipsForUser(user.id),
      contexts.tenancy.teamRolesForUser(user.id)
    ]);
    const platformRoles = platformRoleSource.filter((role): role is PlatformRole => role === "owner");
    const teamRoles = teamRoleSource.filter((role): role is TeamRole => role.startsWith("owner:"));
    return publicUser(user, platformRoles, memberships, { includePlatformRoles: surface === "owner", teamRoles });
  }
}

function actorFromClaims(claims: { sub: string }): AuditActor {
  return { actorType: "user", actorId: claims.sub };
}

function retiredAuthenticationMethod(message: string): RelayError {
  return new RelayError("auth_method_retired", message, 404);
}

async function auditSuccessAsync(contexts: Pick<AsyncControlPlaneTenancyCommands, "auditCommands">, input: Omit<IdentityTenancyAuditInput, "result">): Promise<void> {
  await contexts.auditCommands.record({ ...input, result: "success" });
}

async function auditFailureAsync(contexts: Pick<AsyncControlPlaneTenancyCommands, "auditCommands">, input: Omit<IdentityTenancyAuditInput, "result"> & { error?: unknown }): Promise<void> {
  await contexts.auditCommands.record({ ...input, result: "failure", metadata: metadataWithError(input.metadata, input.error) });
}

async function auditDeniedAsync(contexts: Pick<AsyncControlPlaneTenancyCommands, "auditCommands">, input: Omit<IdentityTenancyAuditInput, "result"> & { error?: unknown }): Promise<void> {
  await contexts.auditCommands.record({ ...input, result: "denied", metadata: metadataWithError(input.metadata, input.error) });
}

function metadataWithError(metadata: Readonly<Record<string, AuditMetadataValue>> | undefined, error: unknown): Readonly<Record<string, AuditMetadataValue>> {
  const errorCode = error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : error instanceof Error ? error.name : null;
  return { ...(metadata ?? {}), ...(errorCode ? { errorCode } : {}) };
}

function teamMembershipRoles(membership: Pick<TeamMembership, "rolesJson"> | null | undefined): Array<"viewer" | "billing" | "manager"> {
  try {
    const parsed = JSON.parse(membership?.rolesJson ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return ["viewer"];
    const roles = parsed.filter((role): role is "viewer" | "billing" | "manager" => role === "viewer" || role === "billing" || role === "manager");
    return roles.length > 0 ? roles : ["viewer"];
  } catch {
    return ["viewer"];
  }
}

function passkeyProtocolSurface(surface: "owner" | "web"): PasskeySurface {
  return surface === "owner" ? "admin" : "web";
}

function auditSourceForSession(surface: "owner" | "web"): "web" | "owner" {
  return surface;
}

function requirePasskeySurfaceConfig(config: AppConfig, surface: PasskeySurface): { origin: string; rpId: string } {
  const surfaceConfig = passkeySurfaceConfig(config, surface);
  if (!surfaceConfig) throw new RelayError("not_found", "Not found", 404);
  return surfaceConfig;
}

function storedPasskeyTransports(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? normalizePasskeyTransports(parsed) : [];
  } catch {
    return [];
  }
}

function invalidPasskeyCredentials(): RelayError {
  return new RelayError("invalid_credentials", "Invalid credentials", 401);
}

function normalizeInviteEmail(email: string): string {
  return EmailAddr.parse(email).value;
}

function requiredPasswordString(value: unknown): string {
  if (typeof value !== "string") throw new RelayError("password_policy_failed", "Password must contain at least 12 characters and be at most 256 UTF-8 bytes", 400);
  return value;
}

function requiredNewPassword(value: unknown): string {
  if (typeof value !== "string" || !validatePasswordPolicy(value).valid) throw new RelayError("password_policy_failed", "Password must contain at least 12 characters and be at most 256 UTF-8 bytes", 400);
  return value;
}

function permissionSubjectKey(subject: { subjectType: ResourcePermissionSubjectType; subjectRef: string; subjectRole: string | null }): string {
  return `${subject.subjectType}:${subject.subjectRef}:${subject.subjectRole ?? ""}`;
}

function normalizeAsyncTeamInviteLinkMaxUses(value: unknown, allowUnlimited: boolean): number | null {
  if (value === undefined) return 1;
  if (value === null && allowUnlimited) return null;
  if (value === null) throw new RelayError("unlimited_team_invite_link_forbidden", "user.domain_binding.manage permission is required to create an unlimited invitation link", 403);
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 1000) {
    throw new RelayError("invalid_team_invite_link_max_uses", "maxUses must be an integer between 1 and 1000", 400);
  }
  return value;
}

function normalizeAsyncApiKeyLimit(value: number): number {
  if (!Number.isFinite(value)) throw new RelayError("invalid_api_key_limit", "API key limit must be a finite number", 400);
  const normalized = Math.trunc(value);
  if (normalized < 0 || normalized > 1000) throw new RelayError("invalid_api_key_limit", "API key limit must be between 0 and 1000", 400);
  return normalized;
}

function redactAsyncApiKey(key: ApiKey) {
  return {
    id: key.id,
    userId: key.userId,
    name: key.name,
    keyPrefix: key.keyPrefix,
    status: key.status,
    expiresAt: key.expiresAt,
    revokedAt: key.revokedAt,
    createdAt: key.createdAt,
    updatedAt: key.updatedAt,
  };
}
