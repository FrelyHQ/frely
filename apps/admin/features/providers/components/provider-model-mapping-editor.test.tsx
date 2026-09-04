// @vitest-environment jsdom

import React, { useState, type ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { TooltipProvider } from "@frely/ui/components/tooltip";
import { ProviderModelMappingEditor } from "./provider-model-mapping-editor";
import {
  appendProviderModelMapping,
  normalizeProviderModelMappings,
  type ProviderModelMapping
} from "../form/provider-model-mappings";

afterEach(cleanup);

describe("Add Provider multi-model UI (REQ-GA-003, REQ-GA-013)", () => {
  it("accepts multiple explicitly entered upstream models and edits each Friday alias", async () => {
    const user = userEvent.setup();
    render(<EditorHarness />, { wrapper: TestProviders });

    expect(screen.getByText("0 selected")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add all suggested models" })).not.toBeInTheDocument();
    const modelInput = screen.getByRole("combobox", { name: "Add upstream model" });
    await user.click(modelInput);
    await user.type(modelInput, "upstream-model-a");
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: "Add model" }));
    await user.click(modelInput);
    await user.type(modelInput, "upstream-model-b");
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: "Add model" }));

    expect(screen.getAllByTestId("provider-model-mapping")).toHaveLength(2);
    expect(screen.getByLabelText("Upstream Model 1")).toHaveValue("upstream-model-a");
    expect(screen.getByLabelText("Friday Model Alias 2")).toHaveValue("upstream-model-b");

    await user.clear(screen.getByLabelText("Friday Model Alias 2"));
    await user.type(screen.getByLabelText("Friday Model Alias 2"), "fast-codex");
    expect(screen.getByLabelText("Friday Model Alias 2")).toHaveValue("fast-codex");

    await user.click(screen.getByRole("button", { name: "Remove model 1" }));
    expect(screen.getAllByTestId("provider-model-mapping")).toHaveLength(1);
  });

  it("normalizes the full array and rejects duplicate aliases", () => {
    const mappings = appendProviderModelMapping(
      appendProviderModelMapping([], " model-a "),
      "model-b"
    );
    expect(normalizeProviderModelMappings(mappings)).toEqual({
      ok: true,
      value: [
        { name: "model-a", alias: "model-a" },
        { name: "model-b", alias: "model-b" }
      ]
    });
    expect(normalizeProviderModelMappings([
      { name: "model-a", alias: "shared" },
      { name: "model-b", alias: "shared" }
    ])).toEqual({ ok: false, error: "Friday model alias must be unique within this Provider: shared" });
  });

  it("normalizes 304 mappings and rejects more than 8192", () => {
    const mappings = Array.from({ length: 304 }, (_, index) => ({ name: `upstream-${index}`, alias: `model-${index}` }));
    const result = normalizeProviderModelMappings(mappings);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toHaveLength(304);
    expect(normalizeProviderModelMappings(Array.from({ length: 8193 }, (_, index) => ({ name: `upstream-${index}`, alias: `model-${index}` })))).toEqual({
      ok: false,
      error: "A Provider can contain at most 8192 model mappings."
    });
  });
});

function EditorHarness() {
  const [value, setValue] = useState<ProviderModelMapping[]>([]);
  return <ProviderModelMappingEditor value={value} onChange={setValue} />;
}

function TestProviders({ children }: { children: ReactNode }) {
  return <TooltipProvider>{children}</TooltipProvider>;
}
