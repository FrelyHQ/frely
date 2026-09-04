"use client";

import React, { useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  TeamInviteManagement,
} from "@frely/team-console-ui/client";
import type {
  TeamInviteActions,
  TeamInviteAudienceViewModel,
} from "@frely/team-console-ui/models";
import { ConsoleDialog, ConsoleDialogFooter } from "@frely/console-ui/console-dialog";
import { Button } from "@frely/ui/components/button";
import { Input } from "@frely/ui/components/input";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "@admin/navigation";
import {
  createAdminTeamInvite,
  disableAdminTeamInvite,
  testInviteEmailDomainRule,
  updateAdminTeamInviteSettings,
} from "../api/team-api";

export function AdminTeamInviteManagement({
  model,
  inviteRegistrationBaseUrl,
  pagination,
}: {
  model: TeamInviteAudienceViewModel;
  inviteRegistrationBaseUrl: string;
  pagination?: ReactNode;
}) {
  const router = useRouter();
  const actions: TeamInviteActions = {
    createInvite: createAdminTeamInvite,
    disableInvite: disableAdminTeamInvite,
    updateInviteSettings: updateAdminTeamInviteSettings,
    onSuccess: () => router.refresh(),
  };
  return <TeamInviteManagement
    state={{ status: "ready", model }}
    interactionMode="active"
    inviteRegistrationBaseUrl={inviteRegistrationBaseUrl}
    actions={actions}
    pagination={pagination}
    headerActions={<InviteEmailDomainTestControl
      teamId={model.team.id}
      pattern={model.settings.inviteEmailDomainPattern ?? null}
    />}
  />;
}

export function InviteEmailDomainTestControl({ teamId, pattern }: { teamId: string; pattern: string | null }) {
  const [isOpen, setIsOpen] = useState(false);
  const [email, setEmail] = useState("");
  const emailRef = useRef("");
  const mutation = useMutation({
    mutationFn: (targetEmail: string) => testInviteEmailDomainRule(teamId, targetEmail, pattern),
    retry: false,
  });
  return <>
    <Button type="button" variant="secondary" onClick={() => { emailRef.current = ""; setEmail(""); mutation.reset(); setIsOpen(true); }}>Test email domain rule</Button>
    {isOpen ? <ConsoleDialog
      observabilityKey="team-invite-domain-test"
      titleId="test-invitation-email-domain-rule-title"
      eyebrow="Invite Links"
      title="Test Invitation Email Domain Rule"
      description="Test the current rule without changing it."
      closeDisabled={mutation.isPending}
      onClose={() => setIsOpen(false)}
    >
      <label>Test email
        <Input aria-label="Test invitation email" type="email" value={email} onChange={(event) => { emailRef.current = event.target.value; setEmail(event.target.value); }} disabled={mutation.isPending} placeholder="person@example.com" />
      </label>
      <ConsoleDialogFooter feedback={mutation.data || mutation.error ? <>
        {mutation.data ? <div className={`notice-box ${mutation.data.allowed ? "notice-good" : "notice-bad"}`} role="status">{email.trim()} is {mutation.data.allowed ? "accepted" : "not accepted"}.</div> : null}
        {mutation.error ? <div className="notice-box notice-bad" role="alert">{mutation.error.message}</div> : null}
      </> : null}>
        <Button type="button" variant="secondary" disabled={mutation.isPending} onClick={() => setIsOpen(false)}>Close</Button>
        <Button type="button" disabled={mutation.isPending || !email.trim()} onClick={() => mutation.mutate(emailRef.current)}>{mutation.isPending ? "Testing..." : "Test"}</Button>
      </ConsoleDialogFooter>
    </ConsoleDialog> : null}
  </>;
}
