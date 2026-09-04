export const TEAM_INVITE_ACTION_IDS = [
  "team.invite.create",
  "team.invite.disable.self",
  "team.invite.disable.any",
  "team.invite.settings.update",
  "team.invite.email_domain.update",
] as const;

export type TeamInviteActionId = (typeof TEAM_INVITE_ACTION_IDS)[number];
export type TeamInvitePerspective = "teamOwner" | "member" | "platformOwner";
export type TeamInviteInteractionMode = "active" | "preview";

export interface TeamInviteLinkViewModel {
  id: string;
  teamId: string;
  createdByUserId?: string;
  creatorEmail?: string | null;
  maxUses: number | null;
  usedCount: number | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface TeamInvitePageViewModel {
  items: TeamInviteLinkViewModel[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  scope: "mine" | "all";
}

export interface TeamInviteCapabilities {
  canCreateInviteLinks: boolean;
  canManageInviteSettings: boolean;
  canManageAllInviteLinks: boolean;
  canCreateUnlimitedInviteLinks: boolean;
}

export interface TeamInviteSettingsSource {
  teamId: string;
  memberInvitesEnabled: boolean;
  inviteEmailDomainRestricted: boolean;
  inviteEmailDomainPattern?: string | null;
  capabilities: TeamInviteCapabilities;
}

export interface TeamInviteAudienceViewModel {
  audience: {
    userId: string;
    teamId: string;
    perspective: TeamInvitePerspective;
  };
  team: {
    id: string;
    name: string;
  };
  settings: {
    memberInvitesEnabled: boolean;
    inviteEmailDomainRestricted: boolean;
    inviteEmailDomainPattern?: string | null;
  };
  links: TeamInvitePageViewModel;
  capabilities: TeamInviteCapabilities;
  visibleActionIds: TeamInviteActionId[];
  calculatedAt: string;
}

export interface CreateTeamInviteInput {
  teamId: string;
  maxUses: number | null;
}

export interface DisableTeamInviteInput {
  teamId: string;
  inviteLinkId: string;
}

export interface UpdateTeamInviteSettingsInput {
  teamId: string;
  memberInvitesEnabled?: boolean;
  inviteEmailDomainPattern?: string | null;
}

export type TeamInviteActionResult =
  | {
      kind: "create-link";
      inviteLink: TeamInviteLinkViewModel;
      outcome?: string;
    }
  | {
      kind: "disable-link";
    }
  | {
      kind: "member-invites";
      enabled: boolean;
      disabledMemberLinkCount?: number;
    }
  | {
      kind: "domain-pattern";
      pattern: string | null;
    };

export interface TeamInviteActions {
  createInvite(input: CreateTeamInviteInput): Promise<TeamInviteActionResult>;
  disableInvite(input: DisableTeamInviteInput): Promise<TeamInviteActionResult>;
  updateInviteSettings(input: UpdateTeamInviteSettingsInput): Promise<TeamInviteActionResult>;
  onSuccess?(): void | Promise<void>;
}

export function buildTeamInviteAudienceViewModel(input: {
  viewerUserId: string;
  perspective: TeamInvitePerspective;
  team: { id: string; name: string };
  settings: TeamInviteSettingsSource;
  links: Omit<TeamInvitePageViewModel, "scope"> & { scope?: "mine" | "all" };
  calculatedAt: string;
}): TeamInviteAudienceViewModel {
  if (input.settings.teamId !== input.team.id) {
    throw new Error("Team invitation settings do not belong to the requested Team");
  }
  const scope = input.settings.capabilities.canManageAllInviteLinks ? "all" : "mine";
  if (input.links.scope !== undefined && input.links.scope !== scope) {
    throw new Error("Team invitation links do not match the audience scope");
  }
  if (input.links.items.some((link) => link.teamId !== input.team.id)) {
    throw new Error("Team invitation links do not belong to the requested Team");
  }
  return {
    audience: {
      userId: input.viewerUserId,
      teamId: input.team.id,
      perspective: input.perspective,
    },
    team: input.team,
    settings: {
      memberInvitesEnabled: input.settings.memberInvitesEnabled,
      inviteEmailDomainRestricted: input.settings.inviteEmailDomainRestricted,
      ...(input.settings.inviteEmailDomainPattern === undefined
        ? {}
        : { inviteEmailDomainPattern: input.settings.inviteEmailDomainPattern }),
    },
    links: {
      ...input.links,
      scope,
    },
    capabilities: input.settings.capabilities,
    visibleActionIds: visibleTeamInviteActionIds(input.settings.capabilities),
    calculatedAt: input.calculatedAt,
  };
}

export function visibleTeamInviteActionIds(capabilities: TeamInviteCapabilities): TeamInviteActionId[] {
  return [
    ...(capabilities.canCreateInviteLinks ? ["team.invite.create" as const] : []),
    ...(capabilities.canManageAllInviteLinks
      ? ["team.invite.disable.any" as const]
      : ["team.invite.disable.self" as const]),
    ...(capabilities.canManageInviteSettings
      ? [
          "team.invite.settings.update" as const,
          "team.invite.email_domain.update" as const,
        ]
      : []),
  ];
}
