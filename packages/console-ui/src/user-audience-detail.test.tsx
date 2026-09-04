// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { UserApiKeysDetail, type ConsoleUser } from "./index.js";

const USER: ConsoleUser = {
  id: "user_restricted",
  teamId: "team_restricted",
  name: "Restricted User",
  email: "restricted@example.local",
  role: "User",
  status: "Active",
  apiKeyLimit: 3,
  apiKeys: "Restricted",
  lastSeen: "Never",
  lastSeenAt: null,
  createdAt: "2026-07-27",
  createdAtIso: "2026-07-27T00:00:00.000Z",
};

describe("User audience detail", () => {
  test("renders an explicit restricted API key state without a misleading empty directory", () => {
    render(
      <UserApiKeysDetail
        user={USER}
        apiKeys={[]}
        apiKeysVisible={false}
        backHref="/user/team/team_restricted"
      />,
    );

    expect(screen.getByText("Restricted")).toBeTruthy();
    expect(screen.getByText("Not visible to this audience")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "API Keys" })).toBeNull();
  });
});
