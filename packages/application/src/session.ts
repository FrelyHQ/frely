import type { PasskeySurface } from "@frely/auth";
import type { PlatformRole, ScopeRef, TeamRole } from "@frely/core";
import type { ApiKeySnapshot as ApiKey, UserSnapshot as User } from "@frely/identity";
import type { TeamMembershipSnapshot as TeamMembership } from "@frely/tenancy-context/server";

export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  user: PublicUser;
}

export interface PublicUser {
  id: string;
  teamId: string;
  teamIds: string[];
  email: string;
  role: string;
  platformRoles: PlatformRole[];
  teamRoles: TeamRole[];
  status: string;
  apiKeyLimit: number;
  userCanCreateCustomProvider: number;
  userCanCreateAccessPoint: number;
}

export interface OwnerUser extends PublicUser {
  adminNote: string | null;
}

export interface ApiKeyPrincipal {
  apiKey: ApiKey;
  user: User;
  effectiveScopes: ScopeRef[];
}

export interface PublicPasskeyCredential {
  id: string;
  name: string;
  deviceType: "singleDevice" | "multiDevice";
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  updatedAt: string;
  availableOn: PasskeySurface[];
}

export function publicUser(user: User, platformRoleSource: PlatformRole[] = [], memberships: TeamMembership[] = [], options: { includePlatformRoles?: boolean; teamRoles?: TeamRole[] } = {}): PublicUser {
  const includePlatformRoles = options.includePlatformRoles ?? true;
  const platformRoles = includePlatformRoles ? platformRoleSource : [];
  const teamRoles = options.teamRoles ?? [];
  const teamIds = memberships.map((membership) => membership.teamId);
  const teamId = teamIds[0] ?? "";
  return { id: user.id, teamId, teamIds, email: user.email, role: displayRole(platformRoles, teamRoles), platformRoles, teamRoles, status: user.status, apiKeyLimit: user.apiKeyLimit, userCanCreateCustomProvider: user.userCanCreateCustomProvider, userCanCreateAccessPoint: user.userCanCreateAccessPoint };
}

export function ownerUser(user: PublicUser, adminNote: string | null): OwnerUser {
  return { ...user, adminNote };
}

function displayRole(platformRoles: PlatformRole[], teamRoles: TeamRole[]): string {
  if (platformRoles.includes("owner")) return "owner";
  if (teamRoles.length > 0) return "owner";
  return "user";
}
