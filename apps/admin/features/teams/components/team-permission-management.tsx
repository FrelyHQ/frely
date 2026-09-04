"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "@admin/navigation";
import { ConsoleDialog, ConsoleDialogFooter } from "@frely/console-ui/console-dialog";
import { MaterialTable } from "@frely/console-ui/material-table";
import { Button } from "@frely/ui/components/button";
import { Checkbox } from "@frely/ui/components/checkbox";
import { SearchSelect } from "../../../pages/owner/_components/search-select";
import { updateTeamMemberRoles, updateTeamPermission, type ResourcePermissionRow } from "../api/team-api";
import { toggleTeamMembershipRole, type TeamMembershipRole } from "../form/team-member-values";
import { hasDirectUserPermission, teamManagementPermissionActions, toDirectUserPermissionInput, type TeamManagementPermissionAction } from "../form/team-permission-values";
import type { TeamMembershipRoleRow } from "./team-member-management";

const teamMembershipRoles = ["viewer", "billing", "manager"] as const;

export function TeamMemberPermissionAction({ teamId, member, ownerId, permissions }: { teamId: string; member: TeamMembershipRoleRow; ownerId: string; permissions: ResourcePermissionRow[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const roleMutation = useMutation({
    mutationFn: ({ role, enabled }: { role: TeamMembershipRole; enabled: boolean }) => updateTeamMemberRoles(teamId, member.userId, toggleTeamMembershipRole(member.roles, role, enabled)),
    retry: false,
    onSuccess: () => router.refresh()
  });
  const permissionMutation = useMutation({
    mutationFn: ({ action, enabled }: { action: TeamManagementPermissionAction; enabled: boolean }) => updateTeamPermission(teamId, toDirectUserPermissionInput(teamId, member.userId, action, enabled)),
    retry: false,
    onSuccess: () => router.refresh()
  });
  const error = roleMutation.error ?? permissionMutation.error;

  return <>
    <Button type="button" variant="secondary" size="sm" onClick={() => { roleMutation.reset(); permissionMutation.reset(); setOpen(true); }}>Permissions</Button>
    {open ? <ConsoleDialog
      observabilityKey="team-member-permissions"
      titleId={`team-member-permissions-${member.userId}`}
      eyebrow="Team Users"
      title={`Permissions for ${member.email}`}
      description="Edit this member's roles and direct management permission grants."
      closeDisabled={roleMutation.isPending || permissionMutation.isPending}
      onClose={() => setOpen(false)}
    >
      {member.userId === ownerId ? <div className="notice-box" role="status">This user is the Team Owner. Owner permissions remain derived from the Team and are not removed by changing membership roles or direct grants.</div> : null}
      <div className="embedded-section">
        <strong>Membership Roles</strong>
        <p className="muted">Roles grant their configured permissions. Team Owner is derived separately.</p>
        <div className="stack-sm">
          {teamMembershipRoles.map((role) => <label className="toggle-row" key={role}>
            <Checkbox
              checked={member.roles.includes(role)}
              disabled={roleMutation.isPending || permissionMutation.isPending}
              onCheckedChange={(checked) => roleMutation.mutate({ role, enabled: checked === true })}
              aria-label={`${member.roles.includes(role) ? "Remove" : "Add"} ${role} role for ${member.email}`}
            />
            <span>{role}</span>
          </label>)}
        </div>
      </div>
      <div className="embedded-section">
        <strong>Direct Permission Grants</strong>
        <p className="muted">Turning off a direct grant does not revoke access inherited from a role or Team ownership.</p>
        <MaterialTable
          columns={[{ header: "Permission" }, { header: "Direct Grant" }]}
          rows={teamManagementPermissionActions.map((action) => {
            const enabled = hasDirectUserPermission(permissions, member.userId, action);
            return { id: action, cells: [<code>{action}</code>, <Checkbox checked={enabled} disabled={roleMutation.isPending || permissionMutation.isPending} onCheckedChange={(checked) => permissionMutation.mutate({ action, enabled: checked === true })} aria-label={`${enabled ? "Disable" : "Enable"} direct ${action} for ${member.email}`} />] };
          })}
          table={{ density: "compact", minWidth: "content", "aria-label": `Direct permissions for ${member.email}` }}
        />
      </div>
      <ConsoleDialogFooter feedback={error ? <div className="notice-box notice-bad" role="alert">{error.message}</div> : null}><Button type="button" variant="secondary" disabled={roleMutation.isPending || permissionMutation.isPending} onClick={() => setOpen(false)}>Close</Button></ConsoleDialogFooter>
    </ConsoleDialog> : null}
  </>;
}

export function TeamPermissionManagementControl({ teamId, members, permissions }: { teamId: string; members: TeamMembershipRoleRow[]; permissions: ResourcePermissionRow[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<TeamManagementPermissionAction>(teamManagementPermissionActions[0]);
  const mutation = useMutation({
    mutationFn: ({ userId, enabled }: { userId: string; enabled: boolean }) => updateTeamPermission(teamId, toDirectUserPermissionInput(teamId, userId, action, enabled)),
    retry: false,
    onSuccess: () => router.refresh()
  });

  return <>
    <Button type="button" variant="secondary" onClick={() => { mutation.reset(); setOpen(true); }}>Permission Management</Button>
    {open ? <ConsoleDialog
      observabilityKey="team-permission-management"
      titleId="team-permission-management-title"
      eyebrow="Team Users"
      title="Permission Management"
      description="Select a management permission, then edit its direct user grants."
      closeDisabled={mutation.isPending}
      onClose={() => setOpen(false)}
    >
      <div className="form-grid single">
        <label>Permission
          <SearchSelect value={action} onValueChange={(value) => { mutation.reset(); setAction(value as TeamManagementPermissionAction); }} searchable={false} disabled={mutation.isPending} options={teamManagementPermissionActions.map((value) => ({ value, label: value }))} />
          <span>Role and Team Owner grants remain effective independently of these direct grants.</span>
        </label>
      </div>
      <MaterialTable
        columns={[{ header: "User" }, { header: "Roles" }, { header: "Direct Grant" }]}
        rows={members.map((member) => {
          const enabled = hasDirectUserPermission(permissions, member.userId, action);
          return { id: member.userId, cells: [<><strong>{member.email}</strong><code>{member.userId}</code></>, member.roles.join(", ") || "viewer", <Checkbox checked={enabled} disabled={mutation.isPending} onCheckedChange={(checked) => mutation.mutate({ userId: member.userId, enabled: checked === true })} aria-label={`${enabled ? "Disable" : "Enable"} direct ${action} for ${member.email}`} />] };
        })}
        emptyState={{ title: "No Team members." }}
        table={{ density: "compact", minWidth: "content", "aria-label": `Users with direct ${action}` }}
      />
      <ConsoleDialogFooter feedback={mutation.error ? <div className="notice-box notice-bad" role="alert">{mutation.error.message}</div> : null}><Button type="button" variant="secondary" disabled={mutation.isPending} onClick={() => setOpen(false)}>Close</Button></ConsoleDialogFooter>
    </ConsoleDialog> : null}
  </>;
}
