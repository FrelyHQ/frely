/** @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@frely/ui/components/tooltip";
import type { PropsWithChildren, ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TeamInviteManagement } from "./team-invite-management.js";
import type { TeamInviteActions, TeamInviteAudienceViewModel } from "./team-invite-model.js";

afterEach(cleanup);

describe("shared Team invitation experience", () => {
  it("executes a granted Team Owner create action through the injected port", async () => {
    const user = userEvent.setup();
    const actions = actionPorts();
    renderWithQuery(<TeamInviteManagement
      state={{ status: "ready", model: model("teamOwner") }}
      interactionMode="active"
      inviteRegistrationBaseUrl="https://relay.example"
      actions={actions}
    />);

    expect(screen.getByRole("heading", { name: "Invite people to Team One" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Unlimited successful joins" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Get My Link" }));

    expect(actions.createInvite).toHaveBeenCalledWith({ teamId: "team-1", maxUses: 1 });
    expect(await screen.findByText("A new invitation link for Team One was created.")).toBeTruthy();
  });

  it("shows the same Team Owner actions as disabled controls in Admin preview", () => {
    const actions = actionPorts();
    renderWithQuery(<TeamInviteManagement
      state={{ status: "ready", model: model("teamOwner") }}
      interactionMode="preview"
      inviteRegistrationBaseUrl="https://relay.example"
      actions={actions}
    />);

    expect(screen.getAllByText("Preview only").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Preview only" }).every((button) => button.hasAttribute("disabled"))).toBe(true);
    expect(actions.createInvite).not.toHaveBeenCalled();
    expect(actions.updateInviteSettings).not.toHaveBeenCalled();
  });

  it("uses the host message resolver without branching on the application source", () => {
    renderWithQuery(<TeamInviteManagement
      state={{ status: "ready", model: model("teamOwner") }}
      interactionMode="preview"
      inviteRegistrationBaseUrl="https://relay.example"
      messageResolver={(key, context) => key === "common.preview_only" ? "只读预览" : context.defaultMessage}
    />);

    expect(screen.getAllByText("只读预览").length).toBeGreaterThan(0);
    expect(screen.queryByText("Preview only")).toBeNull();
  });

  it("labels an unlimited link from the bounded current page", () => {
    const owner = model("teamOwner");
    owner.links.items[0] = { ...owner.links.items[0]!, maxUses: null, usedCount: 7 };
    renderWithQuery(<TeamInviteManagement
      state={{ status: "ready", model: owner }}
      interactionMode="preview"
      inviteRegistrationBaseUrl="https://relay.example"
    />);

    expect(screen.getByText("7 / Unlimited")).toBeTruthy();
    expect(screen.getByText("51 links")).toBeTruthy();
    expect(screen.queryByText("Legacy")).toBeNull();
  });
});

function renderWithQuery(element: ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  function Providers({ children }: PropsWithChildren) {
    return <QueryClientProvider client={queryClient}><TooltipProvider>{children}</TooltipProvider></QueryClientProvider>;
  }
  return render(element, { wrapper: Providers });
}

function actionPorts(): TeamInviteActions {
  return {
    createInvite: vi.fn(async ({ teamId }) => ({
      kind: "create-link" as const,
      inviteLink: {
        id: "invite-created",
        teamId,
        createdByUserId: "owner-1",
        creatorEmail: "owner@example.com",
        maxUses: 1,
        usedCount: 0,
        status: "enabled",
        createdAt: "2026-07-27T00:00:00.000Z",
        updatedAt: "2026-07-27T00:00:00.000Z",
      },
    })),
    disableInvite: vi.fn(async () => ({ kind: "disable-link" as const })),
    updateInviteSettings: vi.fn(async (input) => input.memberInvitesEnabled === undefined
      ? { kind: "domain-pattern" as const, pattern: input.inviteEmailDomainPattern ?? null }
      : { kind: "member-invites" as const, enabled: input.memberInvitesEnabled }),
  };
}

function model(perspective: "teamOwner" | "member"): TeamInviteAudienceViewModel {
  const owner = perspective === "teamOwner";
  return {
    audience: { userId: owner ? "owner-1" : "member-1", teamId: "team-1", perspective },
    team: { id: "team-1", name: "Team One" },
    settings: { memberInvitesEnabled: true, inviteEmailDomainRestricted: false, inviteEmailDomainPattern: null },
    links: {
      items: [{
        id: "invite-1",
        teamId: "team-1",
        createdByUserId: "owner-1",
        ...(owner ? { creatorEmail: "owner@example.com" } : {}),
        maxUses: 5,
        usedCount: 1,
        status: "enabled",
        createdAt: "2026-07-27T00:00:00.000Z",
        updatedAt: "2026-07-27T00:00:00.000Z",
      }],
      page: 2,
      pageSize: 50,
      total: 51,
      totalPages: 2,
      scope: owner ? "all" : "mine",
    },
    capabilities: {
      canCreateInviteLinks: true,
      canManageInviteSettings: owner,
      canManageAllInviteLinks: owner,
      canCreateUnlimitedInviteLinks: owner,
    },
    visibleActionIds: owner
      ? ["team.invite.create", "team.invite.disable.any", "team.invite.settings.update", "team.invite.email_domain.update"]
      : ["team.invite.create", "team.invite.disable.self"],
    calculatedAt: "2026-07-27T00:00:00.000Z",
  };
}
