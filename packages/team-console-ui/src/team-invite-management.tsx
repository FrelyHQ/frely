"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import { StatusBadge } from "@frely/console-ui";
import { ConsoleDialog, ConsoleDialogFooter } from "@frely/console-ui/console-dialog";
import { MaterialTable } from "@frely/console-ui/material-table";
import { consoleErrorMessage } from "@frely/console-ui/api-error";
import { resolveConsoleMessage, type ConsoleMessageResolver } from "@frely/console-ui/messages";
import { BrowserTime } from "@frely/ui/components/browser-time";
import { Button } from "@frely/ui/components/button";
import { Card } from "@frely/ui/components/card";
import { Input } from "@frely/ui/components/input";
import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import type {
  TeamInviteActionResult,
  TeamInviteActions,
  TeamInviteAudienceViewModel,
  TeamInviteInteractionMode,
  TeamInviteLinkViewModel,
} from "./team-invite-model.js";
import { teamInviteRegistrationUrl } from "./team-invite-registration-url.js";

export type TeamInviteManagementState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; model: TeamInviteAudienceViewModel };

export interface TeamInviteManagementProps {
  state: TeamInviteManagementState;
  interactionMode: TeamInviteInteractionMode;
  inviteRegistrationBaseUrl: string;
  actions?: TeamInviteActions;
  fetching?: boolean;
  onRetry?: () => void;
  onPageChange?: (page: number) => void;
  pagination?: ReactNode;
  headerActions?: ReactNode;
  messageResolver?: ConsoleMessageResolver;
}

type PendingAction =
  | { kind: "member-invites"; enabled: boolean }
  | { kind: "domain-pattern"; pattern: string | null }
  | { kind: "create-link"; maxUses: number | null }
  | { kind: "disable-link"; inviteLinkId: string };

export function TeamInviteManagement(props: TeamInviteManagementProps) {
  if (props.state.status === "loading") {
    return <Card className="panel team-invite-management"><p className="muted">{resolveConsoleMessage(props.messageResolver, "team_invite.loading", "Loading invitation settings...")}</p></Card>;
  }
  if (props.state.status === "error") {
    return <Card className="panel team-invite-management">
      <div className="notice-box notice-bad" role="alert" data-clarity-mask="true">{props.state.message}</div>
      {props.onRetry ? <Button type="button" variant="secondary" onClick={props.onRetry}>{resolveConsoleMessage(props.messageResolver, "common.retry", "Retry")}</Button> : null}
    </Card>;
  }
  return <TeamInviteWorkbench {...props} model={props.state.model} />;
}

function TeamInviteWorkbench({
  model,
  interactionMode,
  inviteRegistrationBaseUrl,
  actions,
  fetching = false,
  onPageChange,
  pagination,
  headerActions,
  messageResolver,
}: Omit<TeamInviteManagementProps, "state"> & { model: TeamInviteAudienceViewModel }) {
  const [notice, setNotice] = useState<string | null>(null);
  const [clipboardError, setClipboardError] = useState<string | null>(null);
  const [createdLink, setCreatedLink] = useState<TeamInviteLinkViewModel | null>(null);
  const [maxUses, setMaxUses] = useState("1");
  const [unlimited, setUnlimited] = useState(false);
  const [confirmation, setConfirmation] = useState<
    | { kind: "copy"; link: TeamInviteLinkViewModel }
    | { kind: "member-invites"; enabled: boolean }
    | null
  >(null);
  const isPreview = interactionMode === "preview";
  const mutation = useMutation({
    mutationFn: async (input: PendingAction) => {
      if (!actions || isPreview) throw new Error("Preview actions are read-only");
      if (input.kind === "create-link") {
        return actions.createInvite({ teamId: model.team.id, maxUses: input.maxUses });
      }
      if (input.kind === "disable-link") {
        return actions.disableInvite({
          teamId: model.team.id,
          inviteLinkId: input.inviteLinkId,
        });
      }
      return actions.updateInviteSettings({
        teamId: model.team.id,
        ...(input.kind === "member-invites"
          ? { memberInvitesEnabled: input.enabled }
          : { inviteEmailDomainPattern: input.pattern }),
      });
    },
    retry: false,
    onSuccess: async () => {
      await actions?.onSuccess?.();
    },
  });
  const form = useForm({
    defaultValues: { pattern: model.settings.inviteEmailDomainPattern ?? "" },
    onSubmit: async ({ value }) => {
      const pattern = value.pattern.trim() || null;
      try {
        const result = await mutation.mutateAsync({ kind: "domain-pattern", pattern });
        setNotice(messageFor(result, model.team.name, messageResolver));
      } catch {
        // TanStack Mutation owns the user-visible error state.
      }
    },
  });
  const parsedMaxUses = Number(maxUses);
  const validMaxUses = Number.isInteger(parsedMaxUses) && parsedMaxUses >= 1 && parsedMaxUses <= 1000;
  const canAct = !isPreview && Boolean(actions);

  async function run(input: PendingAction) {
    setNotice(null);
    setClipboardError(null);
    try {
      const result = await mutation.mutateAsync(input);
      if (result.kind === "create-link") setCreatedLink(result.inviteLink);
      if (input.kind === "disable-link" && createdLink?.id === input.inviteLinkId) setCreatedLink(null);
      setNotice(messageFor(result, model.team.name, messageResolver));
      return true;
    } catch {
      // TanStack Mutation owns the user-visible error state.
      return false;
    }
  }

  async function copyLink(inviteLink: TeamInviteLinkViewModel) {
    setClipboardError(null);
    try {
      await navigator.clipboard.writeText(teamInviteRegistrationUrl(inviteRegistrationBaseUrl, inviteLink.id));
      setNotice(resolveConsoleMessage(messageResolver, "team_invite.copy_succeeded", "Invitation link copied for {teamName}. Recipients who join may use resources granted to Team members, including Team plans, budgets, or balance.", { teamName: model.team.name }));
    } catch {
      setClipboardError(resolveConsoleMessage(messageResolver, "team_invite.copy_failed", "Could not copy the invitation link. Check browser clipboard permissions."));
    }
  }

  async function confirmAction() {
    if (!confirmation) return;
    if (confirmation.kind === "copy") await copyLink(confirmation.link);
    else if (!await run({ kind: "member-invites", enabled: confirmation.enabled })) return;
    setConfirmation(null);
  }

  const showCreator = model.links.scope === "all";
  const previewOnly = resolveConsoleMessage(messageResolver, "common.preview_only", "Preview only");
  const requestFailed = resolveConsoleMessage(messageResolver, "team_invite.request_failed", "The invitation request failed");
  const previewDisabledLabel = isPreview ? previewOnly : null;

  return <Card className="panel team-invite-management">
    <div className="panel-heading">
      <div>
        <p className="eyebrow">Invitation Authorization</p>
        <h2>Invite people to <span data-clarity-mask="true">{model.team.name}</span></h2>
        <p className="muted">{model.capabilities.canManageAllInviteLinks ? "Team owners can keep multiple active invitation links; other members can keep one." : "Each member can have at most one active invitation link for this Team."}</p>
      </div>
      <div className="row-actions">
        {isPreview ? <StatusBadge tone="neutral">{previewOnly}</StatusBadge> : null}
        <StatusBadge tone={model.settings.memberInvitesEnabled ? "warn" : "neutral"}>{model.settings.memberInvitesEnabled ? "Member invites on" : "Owner only"}</StatusBadge>
        {headerActions}
      </div>
    </div>

    {model.capabilities.canManageInviteSettings ? <>
      <div className="invite-setting-row">
        <div><strong>Allow all members to invite</strong><p className="muted">The Team owner can always create and govern invitation links.</p></div>
        <Button
          type="button"
          variant={model.settings.memberInvitesEnabled ? "secondary" : "default"}
          role="switch"
          aria-checked={model.settings.memberInvitesEnabled}
          disabled={!canAct || mutation.isPending}
          title={previewDisabledLabel ?? undefined}
          onClick={() => setConfirmation({ kind: "member-invites", enabled: !model.settings.memberInvitesEnabled })}
        >
          {isPreview ? previewOnly : model.settings.memberInvitesEnabled ? "Turn off" : "Turn on"}
        </Button>
      </div>
      <form className="invite-setting-row" onSubmit={(event) => { event.preventDefault(); if (canAct) void form.handleSubmit(); }}>
        <div><strong>Invitation email domain rule</strong><p className="muted">Enter one exact email domain, for example <code>example.com</code>. Subdomains are not included. Leave blank to allow every domain.</p></div>
        <div className="row-actions">
          <form.Field name="pattern">{(field) => <Input aria-label="Invitation email domain rule" value={field.state.value} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value)} disabled={!canAct || mutation.isPending} placeholder="No restriction" />}</form.Field>
          <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting] as const}>{([canSubmit, submitting]) => <Button type="submit" variant="secondary" disabled={!canAct || !canSubmit || submitting || mutation.isPending}>{isPreview ? previewOnly : "Save rule"}</Button>}</form.Subscribe>
        </div>
      </form>
    </> : null}

    {!model.capabilities.canManageInviteSettings && model.settings.inviteEmailDomainRestricted ? <div className="notice-box">Invitation registration is restricted by email domain.</div> : null}
    {model.settings.memberInvitesEnabled ? <div className="notice-box notice-warn" role="status"><strong>Recursive invitations and shared resources are enabled.</strong> New members can create their own links and invite more people. Everyone who joins can use current and future resources granted to Team members and may consume <span data-clarity-mask="true">{model.team.name}</span>&apos;s plans, budgets, or balance.</div> : null}

    {model.capabilities.canCreateInviteLinks ? <div className="invite-create-panel">
      <div><strong>Get my invitation link for <span data-clarity-mask="true">{model.team.name}</span></strong><p className="muted">Before sharing, confirm the recipient should gain member resources and may consume this Team&apos;s plans, budgets, or balance. The limit cannot be changed after creation.</p></div>
      <label>Maximum successful joins<Input aria-label="Maximum successful joins" type="number" min={1} max={1000} step={1} value={maxUses} onChange={(event) => setMaxUses(event.target.value)} disabled={!canAct || mutation.isPending || unlimited} /><span>1–1000; defaults to 1.</span></label>
      {model.capabilities.canCreateUnlimitedInviteLinks ? <label className="row-actions"><input aria-label="Unlimited successful joins" type="checkbox" checked={unlimited} disabled={!canAct || mutation.isPending} onChange={(event) => setUnlimited(event.target.checked)} />Create an unlimited invitation link<span>Unlimited links keep counting successful joins and remain subject to Team and email-domain rules.</span></label> : null}
      <Button type="button" onClick={() => void run({ kind: "create-link", maxUses: unlimited ? null : parsedMaxUses })} disabled={!canAct || mutation.isPending || (!unlimited && !validMaxUses)}>{isPreview ? previewOnly : "Get My Link"}</Button>
    </div> : <div className="notice-box">Only the Team owner can create links while member invitations are off. You can still review and disable your own link history.</div>}

    {createdLink ? <div className="invite-copy-panel"><div><strong>Ready to share for <span data-clarity-mask="true">{model.team.name}</span></strong><p className="muted">This bearer link grants Team membership after acceptance. Send it only to the intended recipient.</p></div><code data-clarity-mask="true">{shortToken(createdLink.id)}</code><Button type="button" variant="secondary" onClick={() => setConfirmation({ kind: "copy", link: createdLink })}>Copy Link</Button></div> : null}
    {notice ? <div className="notice-box notice-good" role="status" data-clarity-mask="true">{notice}</div> : null}
    {mutation.error ? <div className="notice-box notice-bad" role="alert" data-clarity-mask="true">{consoleErrorMessage(mutation.error, requestFailed)}</div> : null}
    {clipboardError ? <div className="notice-box notice-bad" role="alert" data-clarity-mask="true">{clipboardError}</div> : null}

    <div className="panel-heading invite-list-heading">
      <div><h3>{showCreator ? "All Team invitation links" : "My invitation links"}</h3><p className="muted">{showCreator ? "Team owners can review and disable any link for this Team." : "Other members' links are not visible to you."}</p></div>
      <StatusBadge tone="info">{fetching ? "Loading" : `${model.links.total} links`}</StatusBadge>
    </div>
    <MaterialTable
      columns={["Link", ...(showCreator ? ["Creator"] : []), "Uses", "Status", "Created", "Updated", "Actions"].map((header) => ({ header }))}
      rows={model.links.items.map((link) => ({
        id: link.id,
        cells: [
          <code data-clarity-mask="true">{shortToken(link.id)}</code>,
          ...(showCreator ? [<span data-clarity-mask="true">{link.creatorEmail ?? link.createdByUserId ?? "Unknown"}</span>] : []),
          capacityLabel(link),
          <StatusBadge tone={link.status === "enabled" ? "good" : "neutral"}>{managementStatus(link)}</StatusBadge>,
          <BrowserTime value={link.createdAt} />,
          <BrowserTime value={link.updatedAt} />,
          <div className="row-actions">
            {link.status === "enabled" ? <Button type="button" variant="secondary" disabled={isPreview} title={previewDisabledLabel ?? undefined} onClick={() => setConfirmation({ kind: "copy", link })}>{isPreview ? previewOnly : "Copy"}</Button> : null}
            {link.status === "enabled" ? <Button type="button" variant="secondary" disabled={!canAct || mutation.isPending} title={previewDisabledLabel ?? undefined} onClick={() => void run({ kind: "disable-link", inviteLinkId: link.id })}>{isPreview ? previewOnly : mutation.isPending ? "Disabling..." : "Disable"}</Button> : null}
          </div>,
        ],
      }))}
      emptyState={!fetching ? { title: "No invitation links in this view." } : { title: "Loading invitation links…" }}
      table={{ minWidth: "content", stickyHeader: true }}
    />
    {pagination}
    {!pagination && onPageChange && model.links.totalPages > 1 ? <div className="row-actions">
      <Button type="button" variant="ghost" size="sm" disabled={model.links.page <= 1 || fetching} onClick={() => onPageChange(model.links.page - 1)}>Previous</Button>
      <span>Page {model.links.page} / {model.links.totalPages}</span>
      <Button type="button" variant="ghost" size="sm" disabled={model.links.page >= model.links.totalPages || fetching} onClick={() => onPageChange(model.links.page + 1)}>Next</Button>
    </div> : null}

    {confirmation ? <ConsoleDialog
      observabilityKey="team-invite-confirmation"
      titleId="team-invite-confirmation-title"
      eyebrow={confirmation.kind === "copy" ? "Sensitive link" : "Invitation policy"}
      title={confirmation.kind === "copy"
        ? <>Copy invitation link for <span data-clarity-mask="true">{model.team.name}</span></>
        : confirmation.enabled
          ? <>Allow all <span data-clarity-mask="true">{model.team.name}</span> members to invite</>
          : <>Turn off member invitations for <span data-clarity-mask="true">{model.team.name}</span></>}
      description={confirmation.kind === "copy" ? "Anyone with this bearer link can accept the invitation until its use limit is reached." : confirmation.enabled ? "Current and future members will be able to invite more people recursively." : "Enabled links created by members will be disabled immediately; the Team owner's link remains available."}
      closeDisabled={mutation.isPending}
      onClose={() => setConfirmation(null)}
    >
      <div className={confirmation.kind === "copy" || confirmation.enabled ? "notice-box notice-warn" : "notice-box"}>{confirmation.kind === "copy" ? <>Recipients may use resources granted to <span data-clarity-mask="true">{model.team.name}</span> members, including Team plans, budgets, or balance. Send it only to the intended recipient.</> : confirmation.enabled ? <>Everyone who joins may share member resources and consume <span data-clarity-mask="true">{model.team.name}</span>&apos;s plans, budgets, or balance.</> : "This change is reversible, but disabled member links will not be re-enabled automatically."}</div>
      <ConsoleDialogFooter feedback={mutation.error || clipboardError ? <>{mutation.error ? <div className="notice-box notice-bad" role="alert">{consoleErrorMessage(mutation.error, requestFailed)}</div> : null}{clipboardError ? <div className="notice-box notice-bad" role="alert">{clipboardError}</div> : null}</> : null}>
        <Button type="button" variant="secondary" disabled={mutation.isPending} onClick={() => setConfirmation(null)}>Cancel</Button>
        <Button type="button" variant={confirmation.kind === "copy" || confirmation.enabled ? "warning" : "default"} disabled={mutation.isPending} onClick={() => void confirmAction()}>{confirmation.kind === "copy" ? "Copy invitation link" : confirmation.enabled ? "Allow member invitations" : "Turn off invitations"}</Button>
      </ConsoleDialogFooter>
    </ConsoleDialog> : null}
  </Card>;
}

function messageFor(result: TeamInviteActionResult, teamName: string, resolver?: ConsoleMessageResolver) {
  if (result.kind === "create-link") return result.outcome === "already_active"
    ? resolveConsoleMessage(resolver, "team_invite.existing_link", "Your existing active invitation link for {teamName} is ready.", { teamName })
    : resolveConsoleMessage(resolver, "team_invite.created", "A new invitation link for {teamName} was created.", { teamName });
  if (result.kind === "disable-link") return resolveConsoleMessage(resolver, "team_invite.disabled", "The invitation link for {teamName} was disabled.", { teamName });
  if (result.kind === "domain-pattern") return result.pattern
    ? resolveConsoleMessage(resolver, "team_invite.domain_restricted", "Invitation registration for {teamName} is now restricted by email domain.", { teamName })
    : resolveConsoleMessage(resolver, "team_invite.domain_open", "Invitation registration for {teamName} now allows every email domain.", { teamName });
  if (result.enabled) return resolveConsoleMessage(resolver, "team_invite.members_enabled", "All current and future members of {teamName} can now create their own invitation link.", { teamName });
  const count = result.disabledMemberLinkCount ?? 0;
  return resolveConsoleMessage(resolver, "team_invite.members_disabled", "Member invitations are off. {count} member {linkLabel} disabled.", {
    count,
    linkLabel: count === 1 ? "link was" : "links were",
  });
}

function shortToken(token: string) {
  return token.length <= 16 ? token : `${token.slice(0, 8)}…${token.slice(-6)}`;
}

function capacityLabel(link: TeamInviteLinkViewModel) {
  return link.maxUses === null
    ? link.usedCount === null ? "Legacy" : `${link.usedCount} / Unlimited`
    : link.usedCount === null ? "Legacy" : `${link.usedCount} / ${link.maxUses}`;
}

function managementStatus(link: TeamInviteLinkViewModel) {
  return link.status === "disabled" && link.maxUses !== null && link.usedCount === link.maxUses ? "exhausted" : link.status;
}
