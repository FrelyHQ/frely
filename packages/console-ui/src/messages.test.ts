import { describe, expect, it, vi } from "vitest";
import { resolveConsoleMessage } from "./messages.js";

describe("console message resolver", () => {
  it("interpolates the default English message when no locale resolver is provided", () => {
    expect(resolveConsoleMessage(undefined, "team_invite.created", "Created for {teamName}.", {
      teamName: "Team One",
    })).toBe("Created for Team One.");
  });

  it("passes a stable key, fallback, and values to an injected locale resolver", () => {
    const resolver = vi.fn(() => "已创建邀请链接");
    expect(resolveConsoleMessage(resolver, "team_invite.created", "Created for {teamName}.", {
      teamName: "Team One",
    })).toBe("已创建邀请链接");
    expect(resolver).toHaveBeenCalledWith("team_invite.created", {
      defaultMessage: "Created for {teamName}.",
      values: { teamName: "Team One" },
    });
  });
});
