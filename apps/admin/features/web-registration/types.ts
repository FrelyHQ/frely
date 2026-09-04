export interface WebRegistrationTeamView {
  id: string;
  name: string;
}

export interface WebRegistrationSettingView {
  enabled: boolean;
  configured: boolean;
  team: WebRegistrationTeamView | null;
  updatedAt: string | null;
}

export interface WebRegistrationTeamCandidate {
  id: string;
  name: string;
}

export interface WebRegistrationTeamCandidatePage {
  items: WebRegistrationTeamCandidate[];
  nextCursor: string | null;
}
