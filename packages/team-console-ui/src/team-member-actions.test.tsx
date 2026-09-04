/** @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TeamMemberApiKeyLimitAction } from "./team-member-api-key-limit-action.js";
import { TeamMemberStatusAction } from "./team-member-status-action.js";
import type { TeamMemberApiKeyLimitActionPort, TeamMemberRemovalActionPort } from "./team-member-action-model.js";
import type { TeamUserRow } from "./index.js";

afterEach(cleanup);

describe("Team member action ports", () => {
  it("submits API-key limit and removal intent without shared HTTP", async () => {
    const user = userEvent.setup();
    const limitActionPort = limitPort();
    const removalActionPort = removalPort();
    renderWithQuery(<>
      <TeamMemberApiKeyLimitAction user={MEMBER} actionPort={limitActionPort} />
      <TeamMemberStatusAction user={MEMBER} actionPort={removalActionPort} />
    </>);

    const limit = screen.getByRole("spinbutton", { name: "member@example.com API key limit" });
    await user.clear(limit);
    await user.type(limit, "7");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(limitActionPort.updateApiKeyLimit).toHaveBeenCalledWith({
      teamId: "team-1",
      userId: "member-1",
      apiKeyLimit: 7,
    });

    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(removalActionPort.removeMember).toHaveBeenCalledWith({
      teamId: "team-1",
      userId: "member-1",
    });
  });
});

function limitPort(): TeamMemberApiKeyLimitActionPort {
  return {
    updateApiKeyLimit: vi.fn(async () => undefined),
    onUpdated: vi.fn(),
  };
}

function removalPort(): TeamMemberRemovalActionPort {
  return {
    removeMember: vi.fn(async () => undefined),
    onUpdated: vi.fn(),
  };
}

function renderWithQuery(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}

const MEMBER: TeamUserRow = {
  id: "member-1",
  teamId: "team-1",
  name: "Member",
  email: "member@example.com",
  role: "Viewer",
  status: "Active",
  apiKeys: "1",
  apiKeyLimit: 5,
  lastSeen: "Never",
  lastSeenAt: null,
  createdAt: "2026-07-27",
  createdAtIso: "2026-07-27T00:00:00.000Z",
};
