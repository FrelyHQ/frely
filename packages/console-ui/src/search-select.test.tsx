// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { TooltipProvider } from "@frely/ui/components/tooltip";
import type { ReactElement, ReactNode } from "react";
import { SearchSelect, type SearchSelectOption } from "./search-select.js";

const OPTIONS: SearchSelectOption[] = [
  { value: "alpha", label: "Alpha", description: "First option" },
  { value: "beta", label: "Beta", searchText: "second" },
  { value: "gamma", label: "Gamma", disabled: true }
];

afterEach(cleanup);

function renderWithProviders(ui: ReactElement) {
  return render(ui, { wrapper: TestProviders });
}

function TestProviders({ children }: { children: ReactNode }) {
  return <TooltipProvider>{children}</TooltipProvider>;
}

describe("SearchSelect", () => {
  it("keeps search query separate from a controlled committed value", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    const { rerender } = renderWithProviders(
      <SearchSelect ariaLabel="Provider" value="alpha" options={OPTIONS} onValueChange={onValueChange} />
    );
    const input = screen.getByRole("combobox", { name: "Provider" });

    await user.click(input);
    await user.type(input, "second");
    expect(onValueChange).not.toHaveBeenCalled();
    expect(input).toHaveValue("second");

    fireEvent.mouseDown(screen.getByRole("option", { name: "Beta" }));
    expect(onValueChange).toHaveBeenCalledOnce();
    expect(onValueChange).toHaveBeenCalledWith("beta");

    rerender(<SearchSelect ariaLabel="Provider" value="beta" options={OPTIONS} onValueChange={onValueChange} />);
    expect(input).toHaveValue("Beta");
  });

  it("reports transient search text without committing a new value", async () => {
    const user = userEvent.setup();
    const onSearchChange = vi.fn();
    const onValueChange = vi.fn();
    renderWithProviders(
      <SearchSelect ariaLabel="Plan" value="alpha" options={OPTIONS} onSearchChange={onSearchChange} onValueChange={onValueChange} />
    );
    const input = screen.getByRole("combobox", { name: "Plan" });

    await user.click(input);
    await user.type(input, "second");

    expect(onSearchChange).toHaveBeenLastCalledWith("second");
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("supports uncontrolled serialization, disabled omission, and form reset", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    const { rerender } = renderWithProviders(
      <form data-testid="form">
        <SearchSelect name="kind" defaultValue="beta" options={OPTIONS} searchable={false} onValueChange={onValueChange} />
      </form>
    );
    const form = screen.getByTestId("form") as HTMLFormElement;
    const input = screen.getByRole("combobox");

    expect(new FormData(form).get("kind")).toBe("beta");
    await user.click(input);
    fireEvent.mouseDown(screen.getByRole("option", { name: /Alpha/ }));
    expect(new FormData(form).get("kind")).toBe("alpha");
    expect(onValueChange).toHaveBeenCalledWith("alpha");

    fireEvent.reset(form);
    expect(input).toHaveValue("Beta");
    expect(new FormData(form).get("kind")).toBe("beta");

    rerender(
      <form data-testid="form">
        <SearchSelect name="kind" defaultValue="beta" options={OPTIONS} searchable={false} disabled />
      </form>
    );
    expect(new FormData(screen.getByTestId("form") as HTMLFormElement).has("kind")).toBe(false);
  });

  it("navigates enabled options and exposes complete combobox ARIA", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    renderWithProviders(
      <SearchSelect
        id="status"
        ariaLabel="Status"
        defaultValue="alpha"
        options={OPTIONS}
        searchable={false}
        onValueChange={onValueChange}
      />
    );
    const input = screen.getByRole("combobox", { name: "Status" });

    expect(input).toHaveAttribute("aria-autocomplete", "none");
    expect(input).toHaveAttribute("aria-controls", "status-listbox");
    expect(input).toHaveAttribute("readonly");
    await user.click(input);
    const listbox = screen.getByRole("listbox");
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(listbox).toHaveAttribute("id", "status-listbox");
    expect(listbox.parentElement).toBe(document.body);
    expect(listbox).toHaveStyle({ position: "fixed" });
    expect(screen.getByRole("option", { name: "Gamma" })).toHaveAttribute("aria-disabled", "true");

    await user.keyboard("{End}");
    expect(input).toHaveAttribute("aria-activedescendant", "status-listbox-option-beta");
    await user.keyboard("{Home}{ArrowUp}");
    expect(input).toHaveAttribute("aria-activedescendant", "status-listbox-option-beta");
    await user.keyboard("{Home}{ArrowDown}{Enter}");
    expect(onValueChange).toHaveBeenCalledOnce();
    expect(onValueChange).toHaveBeenCalledWith("beta");
    expect(input).toHaveAttribute("aria-expanded", "false");
  });

  it("submits custom values explicitly and discards them on Escape or Tab", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    renderWithProviders(
      <SearchSelect defaultValue="alpha" options={OPTIONS} allowCustomValue onValueChange={onValueChange} />
    );
    const input = screen.getByRole("combobox");

    await user.click(input);
    await user.type(input, "custom-one");
    await user.keyboard("{Escape}");
    expect(input).toHaveValue("Alpha");
    expect(onValueChange).not.toHaveBeenCalled();

    await user.click(input);
    await user.type(input, "custom-two");
    await user.keyboard("{Tab}");
    expect(input).toHaveValue("Alpha");
    expect(onValueChange).not.toHaveBeenCalled();

    await user.click(input);
    await user.type(input, "custom-three");
    await waitFor(() => expect(input).toHaveAttribute("aria-activedescendant", expect.stringContaining("-custom")));
    await user.keyboard("{Enter}");
    expect(onValueChange).toHaveBeenCalledOnce();
    expect(onValueChange).toHaveBeenCalledWith("custom-three");
    expect(input).toHaveValue("custom-three");
  });

  it("does not emit a portal blur before a mouse selection", async () => {
    const user = userEvent.setup();
    const onBlur = vi.fn();
    const onValueChange = vi.fn();
    const onOpenChange = vi.fn();
    renderWithProviders(
      <SearchSelect
        ariaLabel="Model"
        value="alpha"
        options={OPTIONS}
        onBlur={onBlur}
        onValueChange={onValueChange}
        onOpenChange={onOpenChange}
      />
    );
    const input = screen.getByRole("combobox", { name: "Model" });

    await user.click(input);
    fireEvent.mouseDown(screen.getByRole("option", { name: "Beta" }));
    expect(onValueChange).toHaveBeenCalledWith("beta");
    expect(onBlur).not.toHaveBeenCalled();
    expect(onOpenChange.mock.calls).toEqual([[true], [false]]);

    fireEvent.blur(input);
    expect(onBlur).toHaveBeenCalledOnce();
  });

  it("keeps remote pagination inside the open popup without committing a value", async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();
    const onValueChange = vi.fn();
    const { rerender } = renderWithProviders(
      <SearchSelect
        ariaLabel="User"
        value="alpha"
        options={OPTIONS}
        onValueChange={onValueChange}
        pagination={{ page: 1, totalPages: 3, onPageChange }}
      />
    );
    const input = screen.getByRole("combobox", { name: "User" });

    await user.click(input);
    expect(screen.getByText("Page 1 / 3")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(onPageChange).toHaveBeenCalledWith(2);
    expect(onValueChange).not.toHaveBeenCalled();
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(input).toHaveFocus();

    rerender(
      <SearchSelect
        ariaLabel="User"
        value="alpha"
        options={OPTIONS}
        onValueChange={onValueChange}
        pagination={{ page: 2, totalPages: 3, onPageChange }}
      />
    );
    expect(screen.getByText("Page 2 / 3")).toBeInTheDocument();
    await user.keyboard("{PageUp}");
    expect(onPageChange).toHaveBeenLastCalledWith(1);
  });

  it("disables popup pagination while the requested page is loading", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <SearchSelect
        ariaLabel="Plan"
        options={OPTIONS}
        pagination={{ page: 2, totalPages: 4, pending: true, onPageChange: vi.fn() }}
      />
    );

    await user.click(screen.getByRole("combobox", { name: "Plan" }));
    expect(screen.getByText("Loading page 2…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
    expect(screen.getByRole("listbox")).toHaveAttribute("aria-busy", "true");
  });

  it("preserves the committed value if dynamic options remove the current item", () => {
    const { rerender, container } = renderWithProviders(
      <SearchSelect name="provider" value="beta" options={OPTIONS} />
    );
    const input = screen.getByRole("combobox");

    rerender(<SearchSelect name="provider" value="beta" options={[OPTIONS[0]!]} />);
    expect(input).toHaveValue("");
    expect(container.querySelector<HTMLInputElement>('input[type="hidden"]')).toHaveValue("beta");
  });

  it("supports an explicit empty option and does not submit an uncertain no-match query", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    const { container } = renderWithProviders(
      <form>
        <SearchSelect
          name="status"
          defaultValue=""
          options={[{ value: "", label: "All statuses" }, ...OPTIONS]}
          onValueChange={onValueChange}
        />
      </form>
    );
    const input = screen.getByRole("combobox");
    const form = container.querySelector("form")!;

    expect(input).toHaveValue("All statuses");
    expect(new FormData(form).get("status")).toBe("");
    await user.click(input);
    await user.type(input, "not-a-match");
    expect(screen.getByText("No matching options.")).toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(onValueChange).not.toHaveBeenCalled();
    expect(input).toHaveValue("not-a-match");
    await user.keyboard("{Escape}");
    expect(input).toHaveValue("All statuses");
  });
});
