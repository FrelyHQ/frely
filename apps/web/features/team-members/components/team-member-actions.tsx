"use client";

import {
  TeamMemberApiKeyLimitAction,
  TeamMemberStatusAction,
} from "@frely/team-console-ui/client";
import type {
  TeamMemberApiKeyLimitActionPort,
  TeamMemberRemovalActionPort,
} from "@frely/team-console-ui/models";
import type { TeamUserRow } from "@frely/team-console-ui";
import { useRouter } from "@web/navigation";
import {
  removeWebTeamMember,
  updateWebTeamMemberApiKeyLimit,
} from "../api/team-member-api";

export function WebTeamMemberApiKeyLimitAction({ user }: { user: TeamUserRow }) {
  const router = useRouter();
  const actionPort: TeamMemberApiKeyLimitActionPort = {
    updateApiKeyLimit: updateWebTeamMemberApiKeyLimit,
    onUpdated: () => router.refresh(),
  };
  return <TeamMemberApiKeyLimitAction user={user} actionPort={actionPort} />;
}

export function WebTeamMemberStatusAction({ user }: { user: TeamUserRow }) {
  const router = useRouter();
  const actionPort: TeamMemberRemovalActionPort = {
    removeMember: removeWebTeamMember,
    onUpdated: () => router.refresh(),
  };
  return <TeamMemberStatusAction user={user} actionPort={actionPort} />;
}
