/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@frely/ui/components/tooltip";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MaterialTablePagination, pageSizeHref } from "./material-table-pagination.js";

beforeAll(() => vi.stubGlobal("ResizeObserver", class {
  observe() {}
  unobserve() {}
  disconnect() {}
}));

afterAll(() => vi.unstubAllGlobals());

describe("MaterialTablePagination", () => {
  it("offers preset and custom page sizes through the shared SearchSelect", async () => {
    const user = userEvent.setup();
    const onNext = vi.fn();
    const onPageSizeChange = vi.fn();
    render(
      <TooltipProvider>
        <MaterialTablePagination
          page={1}
          pageSize={20}
          total={35}
          totalPages={2}
          noun="subscriptions"
          onNext={onNext}
          onPageSizeChange={onPageSizeChange}
        />
      </TooltipProvider>
    );

    expect(screen.getByText("Page 1 of 2 · 35 subscriptions")).toBeTruthy();
    const pageSizeSelect = screen.getByRole("combobox", { name: "Rows per page" });
    await user.click(pageSizeSelect);
    expect(screen.getByRole("option", { name: "20" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "50" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "100" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "200" })).toBeTruthy();
    await user.click(screen.getByRole("option", { name: "100" }));
    expect(onPageSizeChange).toHaveBeenCalledWith(100);

    await user.click(pageSizeSelect);
    await user.type(pageSizeSelect, "37");
    await user.click(screen.getByRole("option", { name: /Use "37"/ }));
    expect(onPageSizeChange).toHaveBeenCalledWith(37);

    await user.click(pageSizeSelect);
    await user.type(pageSizeSelect, "201");
    await user.click(screen.getByRole("option", { name: /Use "201"/ }));
    expect(onPageSizeChange).toHaveBeenCalledTimes(2);

    expect(screen.getByRole("button", { name: "Go to previous page" }).hasAttribute("disabled")).toBe(true);
    await user.click(screen.getByRole("button", { name: "Go to next page" }));
    expect(onNext).toHaveBeenCalledOnce();
  });

  it("changes only the owned page-size state and resets its page", () => {
    expect(pageSizeHref(
      "https://relay.test/owner/pricing?providerPage=3&providerPageSize=50&accessPointPage=2#prices",
      { pageParam: "providerPage", pageSize: 200, pageSizeParam: "providerPageSize" }
    )).toBe("/owner/pricing?providerPageSize=200&accessPointPage=2#prices");
    expect(pageSizeHref(
      "https://relay.test/owner/audit-logs?page=4&pageSize=50&result=success",
      { pageSize: 20 }
    )).toBe("/owner/audit-logs?result=success");
    expect(pageSizeHref(
      "https://relay.test/owner/audit-logs?page=4&pageSize=50&result=success",
      { pageSize: 37 }
    )).toBe("/owner/audit-logs?pageSize=37&result=success");
  });
});
