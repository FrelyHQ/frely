// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultPriceDraft } from "../form/price-draft";
import { PriceProfileMenu } from "./pricing-tables";

afterEach(cleanup);

describe("Pricing profile menu", () => {
  it("portals profile actions outside the clipping table container", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <div className="data-table-scroll-container">
        <PriceProfileMenu
          draft={createDefaultPriceDraft()}
          onChange={onChange}
        />
      </div>,
    );

    const trigger = screen.getByRole("button", { name: "Manage Profiles" });
    await user.click(trigger);

    const menu = screen.getByRole("menu", { name: "Manage Profiles menu" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(menu.parentElement).toBe(document.body);
    expect(menu).toHaveStyle({ position: "fixed", visibility: "visible" });
    expect(screen.getByRole("menuitem", { name: "Add Standard Long" })).toHaveFocus();

    await user.click(screen.getByRole("menuitem", { name: "Add Standard Long" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      tiers: expect.arrayContaining([
        expect.objectContaining({ serviceTier: "standard", tierKey: "long_context" }),
      ]),
    }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
