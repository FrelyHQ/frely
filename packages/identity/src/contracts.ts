import type { AuditMetadataValue, IdentityTenancyAuditAction } from "@frely/audit";
import {
  decideCanonicalEmailUpgrade,
  EmailAddr,
  type ApiKeySnapshot,
  type IdentityMigrationCandidate,
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

export interface IdentityAuditInput {
  actor: { actorType: "user" | "api_key" | "system"; actorId: string };
  action: Extract<IdentityTenancyAuditAction,
    | "auth.login" | "auth.logout" | "auth.refresh" | "auth.password_change" | "oidc.authorization"
    | "auth.passkey.register" | "auth.passkey.list" | "auth.passkey.rename" | "auth.passkey.delete"
    | "api_key.create" | "api_key.copy" | "api_key.revoke" | "api_key.disable" | "api_key.enable"
    | "user.create" | "user.update"
    | "identity.email_upgrade.canonicalize" | "identity.email_upgrade.freeze" | "identity.email_upgrade.merge"
  >;
  resource: { resourceType: "user" | "api_key" | "passkey" | "oidc_client"; resourceId: string };
  result: "success" | "denied" | "failure";
  source: "owner" | "web" | "gateway" | "system";
  metadata?: Readonly<Record<string, AuditMetadataValue>>;
  requestId?: string | null | undefined;
}

export interface IdentityContextQueries {
  getUser(userId: string): Promise<UserSnapshot | undefined>;
  listUsers(): Promise<UserSnapshot[]>;
  findUserByEmail(email: EmailAddr): Promise<UserSnapshot | undefined>;
  decideUserAccess(userId: string): Promise<UserAccessDecision | undefined>;
  getApiKey(apiKeyId: string): Promise<ApiKeySnapshot | undefined>;
  findApiKeyByHash(keyHash: string): Promise<ApiKeySnapshot | undefined>;
  listApiKeys(userId?: string): Promise<ApiKeySnapshot[]>;
  countEnabledApiKeysForUser(userId: string): Promise<number>;
  findFirstEnabledApiKeyForUser(userId: string): Promise<ApiKeySnapshot | undefined>;
  getOidcAuthorizationCodeByHash(codeHash: string): Promise<OidcAuthorizationCodeSnapshot | undefined>;
  getOidcAccessTokenByHash(tokenHash: string): Promise<OidcAccessTokenSnapshot | undefined>;
  getOidcRefreshTokenByHash(tokenHash: string): Promise<OidcRefreshTokenSnapshot | undefined>;
  getRefreshTokenByHash(tokenHash: string): Promise<RefreshTokenSnapshot | undefined>;
  getWebAuthnUserHandle(userId: string): Promise<WebAuthnUserHandleSnapshot | undefined>;
  listPasskeyCredentials(userId: string, rpId?: string): Promise<PasskeyCredentialSnapshot[]>;
  findPasskeyByCredentialId(credentialId: string): Promise<PasskeyCredentialSnapshot | undefined>;
}

export interface IdentityContextCommands {
  createUser(input: { id?: string; teamId: string | null; email: EmailAddr; passwordHash: string; status?: string; authVersion?: number; adminNote?: string | null; apiKeyLimit?: number; userCanCreateCustomProvider?: number; userCanCreateAccessPoint?: number; createdAt?: string }): Promise<UserSnapshot>;
  updateUserProfile(userId: string, input: { adminNote?: string | null; userCanCreateCustomProvider?: number; userCanCreateAccessPoint?: number }): Promise<UserSnapshot | undefined>;
  updateUserApiKeyLimit(userId: string, apiKeyLimit: number): Promise<UserSnapshot | undefined>;
  createApiKey(input: { userId: string; name: string; keyHash: string; keyPrefix: string; keyValue: string; expiresAt?: string | null }): Promise<ApiKeySnapshot>;
  revokeApiKey(apiKeyId: string): Promise<ApiKeySnapshot | undefined>;
  setApiKeyStatus(apiKeyId: string, status: "enabled" | "disabled"): Promise<ApiKeySnapshot | undefined>;
  createRefreshTokenForAuthVersion(input: { userId: string; expectedAuthVersion: number; tokenHash: string; expiresAt: string }): Promise<RefreshTokenSnapshot>;
  rotateRefreshToken(input: { tokenHash: string; userId: string; expectedAuthVersion: number; replacementTokenHash: string; replacementExpiresAt: string }): Promise<RefreshTokenSnapshot | undefined>;
  revokeRefreshToken(tokenHash: string): Promise<void>;
  rotateOwnPassword(input: { userId: string; expectedPasswordHash: string; newPasswordHash: string; newRefreshTokenHash: string; newRefreshTokenExpiresAt: string; surface: "web" | "owner"; requestId?: string | null }): Promise<UserSnapshot>;
  changeCredentialPassword(input: { userId: string; expectedPasswordHash: string; newPasswordHash: string; surface: "web" | "owner"; requestId?: string | null }): Promise<UserSnapshot>;
  getOrCreateWebAuthnUserHandle(input: { userId: string; candidateHandle: string; additionalCandidateHandles?: string[] }): Promise<WebAuthnUserHandleSnapshot>;
  createWebAuthnCeremony(input: Omit<WebAuthnCeremonySnapshot, "createdAt"> & { createdAt?: string }, cleanupLimit?: number): Promise<WebAuthnCeremonySnapshot>;
  takeWebAuthnCeremony(input: { sessionHash: string; purpose: "authentication" | "registration"; surface: "admin" | "web"; now?: string }): Promise<WebAuthnCeremonySnapshot | undefined>;
  registerUserPasskey(input: { userId: string; expectedAuthVersion: number; credentialId: string; publicKey: string; signCount: number; transportsJson: string; deviceType: "multiDevice" | "singleDevice"; backedUp: number; rpId: string; name: string; source: "web" | "owner"; requestId?: string | null }): Promise<PasskeyCredentialSnapshot>;
  listUserPasskeysAudited(input: { userId: string; expectedAuthVersion: number; source: "web" | "owner"; requestId?: string | null }): Promise<PasskeyCredentialSnapshot[]>;
  renameUserPasskey(input: { userId: string; expectedAuthVersion: number; passkeyId: string; name: string; source: "web" | "owner"; requestId?: string | null }): Promise<PasskeyCredentialSnapshot>;
  completePasskeyLogin(input: { userId: string; expectedAuthVersion: number; passkeyId: string; credentialId: string; rpId: string; expectedUpdatedAt: string; expectedSignCount: number; newSignCount: number; deviceType: "multiDevice" | "singleDevice"; backedUp: number; refreshTokenHash: string; refreshTokenExpiresAt: string; source: "web" | "owner"; requestId?: string | null; auditMetadata: Record<string, unknown> }): Promise<UserSnapshot>;
  deleteUserPasskeyAndRotateSession(input: { userId: string; expectedAuthVersion: number; expectedPasswordHash: string; passkeyId: string; newRefreshTokenHash: string; newRefreshTokenExpiresAt: string; source: "web" | "owner"; requestId?: string | null }): Promise<UserSnapshot>;
  createOidcAuthorizationCode(input: { codeHash: string; userId: string; clientId: string; redirectUri: string; scope: string; codeChallenge: string; nonce: string; expiresAt: string }, audit?: IdentityAuditInput): Promise<OidcAuthorizationCodeSnapshot>;
  exchangeOidcAuthorizationCode(input: { codeHash: string; clientId: string; redirectUri: string; codeChallenge: string; accessTokenHash: string; accessTokenAudience: string; accessTokenExpiresAt: string; refreshToken?: { tokenHash: string; familyId: string; expiresAt: string }; now?: string }): Promise<{ authorizationCode: OidcAuthorizationCodeSnapshot; accessToken: OidcAccessTokenSnapshot; refreshToken: OidcRefreshTokenSnapshot | null; user: UserSnapshot }>;
  rotateOidcRefreshToken(input: { tokenHash: string; clientId: string; newTokenHash: string; accessTokenHash: string; accessTokenAudience: string; accessTokenExpiresAt: string; refreshTokenExpiresAt: string; now?: string }): Promise<{ status: "rotated"; accessToken: OidcAccessTokenSnapshot; refreshToken: OidcRefreshTokenSnapshot; user: UserSnapshot } | { status: "invalid" | "replayed" }>;
  revokeOidcAccessToken(tokenHash: string, clientId: string): Promise<void>;
  revokeOidcRefreshToken(tokenHash: string, clientId: string): Promise<void>;
  deleteExpiredOidcState(now?: string): Promise<{ authorizationCodes: number; accessTokens: number; refreshTokens: number }>;
  appendAudit(input: IdentityAuditInput): Promise<void>;
}

type AssertIdentityCapabilitiesDisjoint<Value extends never> = Value;
type _IdentityCapabilitiesDisjoint = AssertIdentityCapabilitiesDisjoint<Extract<keyof IdentityContextQueries, keyof IdentityContextCommands>>;

export interface CanonicalEmailUpgradeGroup {
  emailFingerprint: string;
  canonicalValue: string;
  candidates: IdentityMigrationCandidate[];
  decisions: ReturnType<typeof decideCanonicalEmailUpgrade>;
}

export interface CanonicalEmailUpgradePreflight {
  ruleVersion: "canonical-email-v1";
  snapshotDigest: string;
  observedUserCount: number;
  invalidUserIds: string[];
  singletonCanonicalizations: Array<{ userId: string; canonicalValue: string; emailFingerprint: string }>;
  collisionGroups: CanonicalEmailUpgradeGroup[];
}

export interface CanonicalEmailUpgradeResult {
  batchId: string;
  status: "completed" | "completed_with_frozen";
  canonicalizedCount: number;
  mergedCount: number;
  frozenCount: number;
}
