import type { ValidatedAuthMutationRequest } from "@frely/auth";

export interface BetterAuthSessionResult {
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly name: string;
    readonly emailVerified: boolean;
    readonly createdAt: Date;
    readonly updatedAt: Date;
  };
  readonly session: {
    readonly id: string;
    readonly userId: string;
    readonly expiresAt: Date;
    readonly createdAt: Date;
    readonly updatedAt: Date;
  };
}

export interface BetterAuthResponseResult extends BetterAuthSessionResult {
  readonly setCookieHeaders: string[];
}

export interface BetterAuthRuntime {
  readonly cookieName: string;
  signInEmail(request: ValidatedAuthMutationRequest, email: string, password: string): Promise<BetterAuthResponseResult>;
  getSession(headers: Headers): Promise<BetterAuthSessionResult | null>;
  signOut(request: ValidatedAuthMutationRequest): Promise<string[]>;
  revokeUserSessions(userId: string): Promise<void>;
  createCredentialAccount(input: { userId: string; passwordHash: string; createdAt: Date; updatedAt: Date }): Promise<void>;
  updateCredentialPassword(input: { userId: string; expectedPasswordHash: string; newPasswordHash: string }): Promise<boolean>;
  findCredentialPassword(userId: string): Promise<string | null>;
}
