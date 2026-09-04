import { createHash } from "node:crypto";
import { RelayError } from "@frely/core";

/** [L9] Identity's only canonical email representation. */
export class EmailAddr {
  readonly #value: string;

  private constructor(value: string) {
    this.#value = value;
  }

  static parse(input: string): EmailAddr {
    if (typeof input !== "string") throw invalidEmail();
    const value = input.trim().toLowerCase();
    const separator = value.indexOf("@");
    const domain = separator > 0 ? value.slice(separator + 1) : "";
    if (
      !value
      || value.length > 254
      || separator <= 0
      || separator !== value.lastIndexOf("@")
      || separator > 64
      || domain.length > 253
      || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u.test(domain)
    ) throw invalidEmail();
    return new EmailAddr(value);
  }

  static restore(value: string): EmailAddr {
    const restored = EmailAddr.parse(value);
    if (restored.value !== value) throw new RelayError("identity_email_not_canonical", "Stored identity email is not canonical", 500);
    return restored;
  }

  get value(): string {
    return this.#value;
  }

  get domain(): string {
    return this.#value.slice(this.#value.indexOf("@") + 1);
  }

  equals(other: EmailAddr): boolean {
    return this.#value === other.#value;
  }

  toString(): string {
    return this.#value;
  }
}

function invalidEmail(): RelayError {
  return new RelayError("invalid_email", "A valid email address is required", 400);
}

export interface UserSnapshot {
  id: string;
  teamId: string | null;
  email: string;
  passwordHash: string;
  authVersion: number;
  status: string;
  adminNote: string | null;
  apiKeyLimit: number;
  userCanCreateCustomProvider: number;
  userCanCreateAccessPoint: number;
  createdAt: string;
  updatedAt: string;
  migrationFrozenAt?: string | null;
  migrationFreezeReason?: string | null;
}

export interface ApiKeySnapshot {
  id: string;
  userId: string;
  name: string;
  keyHash: string;
  keyPrefix: string;
  keyValue: string;
  status: string;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RefreshTokenSnapshot {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}

export interface PasskeyCredentialSnapshot {
  id: string;
  userId: string;
  credentialId: string;
  publicKey: string;
  signCount: number;
  transportsJson: string;
  deviceType: "multiDevice" | "singleDevice";
  backedUp: number;
  rpId: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  updatedAt: string;
}

export interface WebAuthnUserHandleSnapshot {
  userId: string;
  userHandle: string;
  createdAt: string;
}

export interface OidcAuthorizationCodeSnapshot {
  id: string;
  codeHash: string;
  userId: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  codeChallenge: string;
  nonce: string;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
}

export interface OidcAccessTokenSnapshot {
  id: string;
  tokenHash: string;
  userId: string;
  clientId: string;
  audience: string;
  scope: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface OidcRefreshTokenSnapshot {
  id: string;
  tokenHash: string;
  familyId: string;
  userId: string;
  clientId: string;
  scope: string;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
  revokedAt: string | null;
  replacedById: string | null;
}

export interface WebAuthnCeremonySnapshot {
  sessionHash: string;
  challengeHash: string;
  purpose: "authentication" | "registration";
  surface: "admin" | "web";
  userId: string | null;
  expectedAuthVersion: number | null;
  rpId: string;
  origin: string;
  passkeyName: string | null;
  expiresAt: string;
  createdAt: string;
}

export interface UserAccessDecision {
  userRef: string;
  enabled: boolean;
  authVersion: number;
}

export type IdentityMigrationConflict =
  | "credential_conflict"
  | "platform_owner_conflict"
  | "tenant_ownership_conflict"
  | "identity_fact_conflict";

export interface IdentityMigrationCandidate {
  id: string;
  createdAt: string;
  credentialConflict: boolean;
  credentialCount: number;
  activePlatformOwner: boolean;
  ownedTenantCount: number;
  otherFactReferenceCount: number;
  transferStateFingerprint: string;
}

export interface IdentityMigrationDecision {
  survivorUserId: string;
  sourceUserId: string;
  outcome: "merge" | "freeze";
  conflicts: IdentityMigrationConflict[];
}

/** [L9] Deterministic one-time upgrade decision; runtime never calls this. */
export function decideCanonicalEmailUpgrade(candidates: readonly IdentityMigrationCandidate[]): IdentityMigrationDecision[] {
  if (candidates.length < 2) return [];
  const ordered = [...candidates].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  const survivor = ordered[0]!;
  return ordered.slice(1).map((source) => {
    const conflicts: IdentityMigrationConflict[] = [];
    if (source.credentialConflict || source.credentialCount > 0) conflicts.push("credential_conflict");
    if (source.activePlatformOwner) conflicts.push("platform_owner_conflict");
    if (source.ownedTenantCount > 0) conflicts.push("tenant_ownership_conflict");
    if (source.otherFactReferenceCount > 0) conflicts.push("identity_fact_conflict");
    return {
      survivorUserId: survivor.id,
      sourceUserId: source.id,
      outcome: conflicts.length === 0 ? "merge" : "freeze",
      conflicts,
    };
  });
}

export function canonicalEmailFingerprint(email: EmailAddr): string {
  return createHash("sha256").update(email.value, "utf8").digest("hex");
}
