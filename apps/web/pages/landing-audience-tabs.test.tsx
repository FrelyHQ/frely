// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import React from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { LandingAudienceTabs } from "./landing-audience-tabs";

afterEach(cleanup);
beforeAll(() => vi.stubGlobal("React", React));
afterAll(() => vi.unstubAllGlobals());

describe("Web Landing Page audience switch (REQ-MEMBER-016)", () => {
  it("defaults to the relay operator and routes its primary action to the user boundary", () => {
    render(<LandingAudienceTabs />);

    expect(screen.getByRole("tab", { name: /中转站主理人/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveAccessibleName(/中转站主理人/);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("建立自己的AI 中转站");
    expect(screen.getByRole("link", { name: /进入我的中转站/ })).toHaveAttribute("href", "/user");
  });

  it("switches to the ordinary-user content by pointer and keyboard with complete tab semantics", async () => {
    const user = userEvent.setup();
    render(<LandingAudienceTabs />);

    const operatorTab = screen.getByRole("tab", { name: /中转站主理人/ });
    const userTab = screen.getByRole("tab", { name: "普通用户" });
    await user.click(userTab);
    expect(userTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("直接使用可靠的AI 模型");
    expect(screen.getByRole("link", { name: /进入用户控制台/ })).toHaveAttribute("href", "/user");

    await user.keyboard("{ArrowLeft}");
    expect(operatorTab).toHaveFocus();
    expect(operatorTab).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{End}");
    expect(userTab).toHaveFocus();
    expect(userTab).toHaveAttribute("aria-selected", "true");
  });
});
