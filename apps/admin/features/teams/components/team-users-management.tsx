"use client";

import { useState } from "react";
import type { TeamUserRow } from "@frely/team-console-ui";
import { ConsoleDialog, ConsoleDialogFooter } from "@frely/console-ui/console-dialog";
import { Button } from "@frely/ui/components/button";
import { AddTeamMemberControl, ChangeTeamOwnerControl } from "./team-member-management";

export function TeamUsersManagementControl({ teamId, ownerId, members }: { teamId: string; ownerId: string; members: TeamUserRow[] }) {
  const [open, setOpen] = useState(false);

  return <>
    <Button type="button" onClick={() => setOpen(true)}>Manage Users</Button>
    {open ? <ConsoleDialog observabilityKey="team-users-management" titleId="team-users-management-title" eyebrow="Team Users" title="Manage Users" description="Add an existing user to this Team or transfer Team ownership." onClose={() => setOpen(false)}>
      <div className="embedded-section"><strong>Add Member</strong><p className="muted">Only enabled users who are not already Team members are available.</p><AddTeamMemberControl teamId={teamId} /></div>
      <ChangeTeamOwnerControl teamId={teamId} ownerId={ownerId} members={members} />
      <ConsoleDialogFooter><Button type="button" variant="secondary" onClick={() => setOpen(false)}>Close</Button></ConsoleDialogFooter>
    </ConsoleDialog> : null}
  </>;
}
