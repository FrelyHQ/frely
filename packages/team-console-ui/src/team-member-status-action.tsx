"use client";

import { Button } from "@frely/ui/components/button";
import { useMutation } from "@tanstack/react-query";
import type { TeamUserRow } from "./index.js";
import type { RemoveTeamMemberInput, TeamMemberRemovalActionPort } from "./team-member-action-model.js";

export function TeamMemberStatusAction({
  user,
  actionPort,
}: {
  user: TeamUserRow;
  actionPort: TeamMemberRemovalActionPort;
}) {
  const mutation = useMutation<unknown, Error, RemoveTeamMemberInput>({
    mutationFn: (input) => actionPort.removeMember(input),
    retry: false,
    onSuccess: () => actionPort.onUpdated(),
  });

  return (
    <div className="row-actions">
      <Button type="button" size="sm" variant="destructive" disabled={mutation.isPending} onClick={() => mutation.mutate({ userId: user.id, teamId: user.teamId })}>
        {mutation.isPending ? "Removing..." : "Remove"}
      </Button>
      {mutation.error ? <span className="inline-error" role="alert">{mutation.error instanceof Error ? mutation.error.message : "Failed to remove member"}</span> : null}
    </div>
  );

}
