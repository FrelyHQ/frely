import type { AdminTeamDirectoryRow } from "../../../lib/teams";

export interface TeamSettingsFormValues {
  name: string;
  teamOwnerCanManageMemberApiKeyLimit: boolean;
  teamOwnerCanManageMemberCredit: boolean;
  teamOwnerCanCreateAccessPoint: boolean;
}

export function createTeamSettingsFormValues(team: AdminTeamDirectoryRow): TeamSettingsFormValues {
  return {
    name: team.name,
    teamOwnerCanManageMemberApiKeyLimit: team.canManageMemberApiKeyLimit,
    teamOwnerCanManageMemberCredit: team.canManageMemberCredit,
    teamOwnerCanCreateAccessPoint: team.teamOwnerCanCreateAccessPoint
  };
}

export function createBulkTeamFormValues(): Omit<TeamSettingsFormValues, "name"> {
  return {
    teamOwnerCanManageMemberApiKeyLimit: false,
    teamOwnerCanManageMemberCredit: false,
    teamOwnerCanCreateAccessPoint: false
  };
}

export function toTeamUpdateInput(values: TeamSettingsFormValues) {
  return {
    name: values.name.trim(),
    teamOwnerCanManageMemberApiKeyLimit: values.teamOwnerCanManageMemberApiKeyLimit,
    teamOwnerCanManageMemberCredit: values.teamOwnerCanManageMemberCredit,
    teamOwnerCanCreateAccessPoint: values.teamOwnerCanCreateAccessPoint
  };
}

export function requiredTeamName(value: string) {
  return value.trim() ? undefined : "Team name is required";
}
