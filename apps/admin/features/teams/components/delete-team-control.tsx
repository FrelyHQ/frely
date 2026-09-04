"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "@admin/navigation";
import { Button } from "@frely/ui/components/button";
import { Input } from "@frely/ui/components/input";
import { FormFieldFrame } from "../../_shared/form-fields";
import { cancelTeamDeletion, deleteTeam, type TeamDeleteBlocker } from "../api/team-api";

export interface DeleteTeamControlProps {
  team: { id: string; name: string; status: string };
  blockers: TeamDeleteBlocker[];
  deletionLifecycle?: { id: string; purgeNotBefore: string; archiveStatus: string } | null;
  onDeleted?: () => void;
  redirectOnDelete?: boolean;
}

export function DeleteTeamControl({ team, blockers, deletionLifecycle, onDeleted }: DeleteTeamControlProps) {
  const router = useRouter();
  const [confirmation, setConfirmation] = useState("");
  const mutation = useMutation({
    mutationFn: () => deletionLifecycle ? cancelTeamDeletion(team.id) : deleteTeam(team.id, `Delete ${team.name} failed`),
    retry: false,
    onSuccess: () => {
      onDeleted?.();
      router.refresh();
    }
  });
  const confirmed = confirmation === team.id;

  return <div className="embedded-section team-danger-zone" data-testid="team-danger-zone">
    <div className="panel-heading">
      <div><strong>Danger Zone</strong><p className="muted">{deletionLifecycle ? "Restore this Team with the same ID and memberships." : "Soft-delete this Team immediately. Data is retained for at least 180 days and purge remains a separate Platform Owner action."}</p></div>
    </div>
    {deletionLifecycle ? <div className="notice-box" role="status">Soft-deleted. Purge is unavailable before {deletionLifecycle.purgeNotBefore}; archive status: {deletionLifecycle.archiveStatus}.</div> : blockers.length > 0 ? <p className="muted">Current data blockers do not prevent soft deletion, but they must be handled by the controlled archive flow before purge.</p> : null}
    <FormFieldFrame label="Type the full Team ID to confirm" description={team.id}>
      <Input aria-label="Team deletion confirmation" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} disabled={mutation.isPending} placeholder={team.id} />
    </FormFieldFrame>
    <Button type="button" variant={deletionLifecycle ? "secondary" : "destructive"} disabled={!confirmed || mutation.isPending} onClick={() => mutation.mutate()}>{mutation.isPending ? "Saving..." : deletionLifecycle ? "Restore Team" : "Soft-delete Team"}</Button>
    {mutation.error ? <div className="notice-box notice-bad" role="alert">{mutation.error.message}</div> : null}
  </div>;
}
