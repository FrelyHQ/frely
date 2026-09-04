// @vitest-environment jsdom

import React, { type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@frely/ui/components/tooltip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { ApiTestForm } from "./api-test-workbench";
import type { ApiTestAccessPoint, ApiTestKey } from "../types";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  fetchSavedCurl: vi.fn(),
  fetchApiKeyCandidates: vi.fn(),
  fetchAccessPointCandidates: vi.fn()
}));

vi.mock("../api/api-test-api", () => ({
  executeApiTest: mocks.execute,
  fetchSavedApiTestCurl: mocks.fetchSavedCurl
}));

vi.mock("../../api-keys/api/api-key-api", () => ({
  fetchApiKeyCandidates: mocks.fetchApiKeyCandidates
}));

vi.mock("../../access-points/api/access-point-api", () => ({
  fetchAccessPointCandidates: mocks.fetchAccessPointCandidates
}));

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  mocks.execute.mockReset();
  mocks.fetchSavedCurl.mockReset();
  mocks.fetchApiKeyCandidates.mockReset();
  mocks.fetchAccessPointCandidates.mockReset();
  mocks.fetchSavedCurl.mockResolvedValue("curl 'http://gateway.local/v1/chat/completions' -H \"Authorization: Bearer fr_saved_secret\"");
  mocks.fetchApiKeyCandidates.mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0, totalPages: 1 });
  mocks.fetchAccessPointCandidates.mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0, totalPages: 1 });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Owner API Test workbench (REQ-GA-003, REQ-MEMBER-004)", () => {
  it("keeps a manual API key out of the preview but injects it into the copied command", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    renderForm();

    await user.type(screen.getByLabelText(/Manual API Key/u), "fr_manual_secret");

    expect(screen.getByText(/curl 'http:\/\/127\.0\.0\.1:43000\/v1\/chat\/completions'/u)).toHaveTextContent("<api-key>");
    expect(screen.queryByText(/fr_manual_secret/u)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Copy curl command" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining("Authorization: Bearer fr_manual_secret")));
    expect(mocks.fetchSavedCurl).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Copy curl command" })).toBeInTheDocument(), { timeout: 3_000 });
  });

  it("fetches a no-store command for the selected saved key and only sends it to the clipboard", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    renderForm();

    await user.click(screen.getByRole("button", { name: "Copy curl command" }));

    await waitFor(() => expect(mocks.fetchSavedCurl).toHaveBeenCalledWith(expect.objectContaining({
      apiKeyId: "key-1",
      apiType: "chat",
      accessPointId: "ap-1"
    })));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("fr_saved_secret"));
    expect(screen.queryByText(/fr_saved_secret/u)).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Copy curl command" })).toBeInTheDocument(), { timeout: 3_000 });
  });

  it("defaults to the first enabled saved key", () => {
    renderForm([
      { id: "key-2", teamId: "team-1", userId: "user-1", name: "Available key", keyPrefix: "fr_available", status: "enabled" }
    ]);

    expect(screen.getByLabelText(/Saved API Key/u)).toHaveValue("Available key (fr_available)");
    expect(screen.getByRole("button", { name: "Send LLM Request" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Copy curl command" })).toBeEnabled();
  });

  it("makes manual identity exclusive and does not restore the saved key when cleared", async () => {
    const user = userEvent.setup();
    renderForm();

    expect(screen.getByLabelText(/Saved API Key/u)).toHaveValue("Saved key (fr_saved)");
    const manualInput = screen.getByLabelText(/Manual API Key/u);
    await user.type(manualInput, "fr_manual_secret");

    expect(screen.getByLabelText(/Saved API Key/u)).toHaveValue("");
    expect(screen.getByText("Manual API Key", { selector: "strong" })).toBeInTheDocument();
    expect(screen.queryByText("fr_saved", { selector: "code" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send LLM Request" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Copy curl command" })).toBeEnabled();

    await user.clear(manualInput);
    expect(screen.getByLabelText(/Saved API Key/u)).toHaveValue("");
    expect(screen.getByRole("button", { name: "Send LLM Request" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Copy curl command" })).toBeDisabled();
  });

  it("switches protocol labels and paths while preserving each protocol draft", async () => {
    const user = userEvent.setup();
    renderForm();

    await selectApiType(user, "Responses");
    const responsesPayload = screen.getByLabelText(/Responses Payload/u);
    expect(responsesPayload).toBeInTheDocument();
    expect(screen.getByText(/curl 'http:\/\/127\.0\.0\.1:43000\/v1\/responses'/u)).toBeInTheDocument();
    fireEvent.change(responsesPayload, { target: { value: JSON.stringify({ model: "model-a", input: "custom response input", stream: false }, null, 2) } });

    await selectApiType(user, "Messages");
    expect(screen.getByLabelText(/Messages Payload/u)).toBeInTheDocument();
    expect(screen.getByText(/curl 'http:\/\/127\.0\.0\.1:43000\/v1\/messages'/u)).toBeInTheDocument();

    await selectApiType(user, "Responses");
    expect((screen.getByLabelText(/Responses Payload/u) as HTMLTextAreaElement).value).toContain("custom response input");
  });

  it("requests later remote candidate pages from pagination inside the select popup", async () => {
    const user = userEvent.setup();
    mocks.fetchApiKeyCandidates.mockImplementation(async (_query: string, page: number) => ({
      items: page === 1 ? [{ id: "key-1", userId: "user-1", name: "First key", keyPrefix: "fr_first", status: "enabled" }] : [],
      page,
      pageSize: 20,
      total: 21,
      totalPages: 2
    }));
    renderForm([], []);

    await waitFor(() => expect(mocks.fetchApiKeyCandidates).toHaveBeenCalledWith("", 1, expect.any(AbortSignal)));
    await user.click(screen.getByLabelText(/Saved API Key/u));
    await user.click(await screen.findByRole("button", { name: "Next page" }));

    await waitFor(() => expect(mocks.fetchApiKeyCandidates).toHaveBeenCalledWith("", 2, expect.any(AbortSignal)));
    expect(screen.getByLabelText(/Saved API Key/u)).toHaveAttribute("aria-expanded", "true");
  });
});

function renderForm(
  apiKeys: ApiTestKey[] = [savedKey()],
  accessPoints: ApiTestAccessPoint[] = [{ id: "ap-1", name: "Test AP", description: null, status: "enabled", exposedModel: "model-a", targetModel: "target-a", targetType: "provider-model", targetId: "provider-1", targetProviderModelName: "target-a" }]
) {
  return render(
    <ApiTestForm
      apiKeys={apiKeys}
      accessPoints={accessPoints}
      refreshing={false}
      refresh={() => undefined}
    />,
    { wrapper: TestProviders }
  );
}

function savedKey() {
  return { id: "key-1", teamId: "team-1", userId: "user-1", name: "Saved key", keyPrefix: "fr_saved", status: "enabled" };
}

async function selectApiType(user: ReturnType<typeof userEvent.setup>, label: "Responses" | "Messages") {
  await user.click(screen.getByLabelText("API Type"));
  await user.click(screen.getByRole("option", { name: new RegExp(label, "u") }));
}

function TestProviders({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  return <TooltipProvider><QueryClientProvider client={client}>{children}</QueryClientProvider></TooltipProvider>;
}
