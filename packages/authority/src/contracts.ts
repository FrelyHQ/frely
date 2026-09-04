import type { AuthorityGrantQuotaSnapshot, AuthorityGrantSnapshot, AuthorityQuotaDecision, AuthorityRoleDecision, AuthorityUseSnapshot, PageResult, UserAuthorityGrantRow } from "./index.js";

export interface CreatePurchasedAuthorityGrantCommand { beneficiaryUserId: string; purchaseId: string; productCode: string; productVersion: number; issuedByUserId: string; grantedUnits: number; effectiveStart: string; effectiveEnd: string; maxCurrentOwnedTeams: number | null; maxLifetimeCreatedTeams: number | null; }
export interface ConsumeTeamCreationUnitCommand { beneficiaryUserId: string; targetTeamId: string; idempotencyKeyHash: string; requestHash: string; currentOwnedTeams: number; actorUserId: string; createdAt?: string; source: "web" | "owner" | "system"; requestId?: string | null; }
export interface AuthorityUseResult { use: AuthorityUseSnapshot; replayed: boolean; }

export interface AuthorityContextQueries {
  getGrant(grantId: string): Promise<AuthorityGrantSnapshot | undefined>;
  getGrantForPurchase(purchaseId: string): Promise<AuthorityGrantSnapshot | undefined>;
  getQuota(grantId: string, capabilityCode?: "team.create"): Promise<AuthorityGrantQuotaSnapshot | undefined>;
  getUseForOperation(beneficiaryUserId: string, operation: "team.create", idempotencyKeyHash: string): Promise<AuthorityUseSnapshot | undefined>;
  decidePlatformRoles(userId: string, at?: string): Promise<AuthorityRoleDecision>;
  platformRolesForUser(userId: string, at?: string): Promise<readonly string[]>;
  activeBootstrapPlatformOwnerUserId(at?: string): Promise<string | undefined>;
  hasAvailableTeamCreationUnit(userId: string, at?: string): Promise<boolean>;
  classifyIdentityMigrationUser(userId: string, at?: string): Promise<{ grantCount: number; activePlatformOwner: boolean }>;
  countAvailableTeamCreationUnits(userId: string, productCode?: string, at?: string): Promise<number>;
  decideTeamCreationQuota(userId: string, at?: string): Promise<AuthorityQuotaDecision>;
  pageUserGrants(userId: string, page?: number, at?: string, requestedPageSize?: number): Promise<PageResult<UserAuthorityGrantRow>>;
}

export interface AuthorityContextCommands {
  ensureBootstrapOwner(userId: string, actor?: { actorType: "system" | "user"; actorId: string }): Promise<{ grant: AuthorityGrantSnapshot; created: boolean }>;
  createPurchasedGrant(command: CreatePurchasedAuthorityGrantCommand): Promise<{ grant: AuthorityGrantSnapshot; quota: AuthorityGrantQuotaSnapshot; replayed: boolean }>;
  cancelGrant(input: { grantId: string; actorOwnerUserId: string; reasonCode: string; requestId?: string | null }): Promise<AuthorityGrantSnapshot>;
  cancelUnconsumedGrantForRefund(input: { grantId: string; purchaseId: string; actorOwnerUserId: string; requestId?: string | null }): Promise<AuthorityGrantSnapshot>;
  handoverBootstrapOwner(input: { currentOwnerUserId: string; nextOwnerUserId: string; actorUserId: string; at?: string }): Promise<{ previousGrant: AuthorityGrantSnapshot; nextGrant: AuthorityGrantSnapshot }>;
  consumeTeamCreationUnit(command: ConsumeTeamCreationUnitCommand): Promise<AuthorityUseResult>;
}

type AssertAuthorityCapabilitiesDisjoint<Value extends never> = Value;
type _AuthorityCapabilitiesDisjoint = AssertAuthorityCapabilitiesDisjoint<Extract<keyof AuthorityContextQueries, keyof AuthorityContextCommands>>;
