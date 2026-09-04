export interface UpdateTeamMemberApiKeyLimitInput {
  teamId: string;
  userId: string;
  apiKeyLimit: number;
}

export interface RemoveTeamMemberInput {
  teamId: string;
  userId: string;
}

export interface TeamMemberApiKeyLimitActionPort {
  updateApiKeyLimit(input: UpdateTeamMemberApiKeyLimitInput): Promise<unknown>;
  onUpdated(): void | Promise<void>;
}

export interface TeamMemberRemovalActionPort {
  removeMember(input: RemoveTeamMemberInput): Promise<unknown>;
  onUpdated(): void | Promise<void>;
}
