// @vitest-environment jsdom

import React, { type ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { ConsoleApiError } from "@frely/console-ui/api-error";
import type { ProviderRecord } from "../types";
import { EditProviderDialog } from "./edit-provider-dialog";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  reconcile: vi.fn(),
  sync: vi.fn(),
  clear: vi.fn(),
  importCredential: vi.fn(),
  fetchOAuthStatus: vi.fn(),
  saveCredential: vi.fn(),
  startOAuth: vi.fn(),
  submitOAuthCallback: vi.fn(),
  update: vi.fn(),
  updateModel: vi.fn()
}));

vi.mock("@admin/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("../api/provider-api", () => ({
  clearProviderCredential: mocks.clear,
  fetchProviderOAuthStatus: mocks.fetchOAuthStatus,
  importProviderCredential: mocks.importCredential,
  reconcileProviderBinding: mocks.reconcile,
  saveProviderCredential: mocks.saveCredential,
  startProviderOAuth: mocks.startOAuth,
  submitProviderOAuthCallback: mocks.submitOAuthCallback,
  syncProviderModels: mocks.sync,
  updateProvider: mocks.update,
  updateProviderModel: mocks.updateModel
}));

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.reconcile.mockResolvedValue({ syncStatus: "ready" });
  mocks.saveCredential.mockResolvedValue({});
  mocks.importCredential.mockResolvedValue({});
  vi.spyOn(window, "open").mockImplementation(() => null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Provider binding recovery UI (REQ-GA-013)", () => {
  it.each(["pending", "error"] as const)("offers Retry Binding while binding is %s and only reconciles", async (syncStatus) => {
    const user = userEvent.setup();
    render(<EditProviderDialog provider={provider(syncStatus)} />, { wrapper: TestProviders });

    await user.click(screen.getByRole("button", { name: "Manage" }));
    await user.click(screen.getByRole("button", { name: "Retry Binding" }));

    expect(mocks.reconcile).toHaveBeenCalledTimes(1);
    expect(mocks.sync).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("hides Retry Binding after binding is ready", async () => {
    const user = userEvent.setup();
    render(<EditProviderDialog provider={provider("ready")} />, { wrapper: TestProviders });

    await user.click(screen.getByRole("button", { name: "Manage" }));

    expect(screen.queryByRole("button", { name: "Retry Binding" })).not.toBeInTheDocument();
  });

  it("routes a confirmed missing API key to Replace Key without Retry Binding", async () => {
    const user = userEvent.setup();
    render(<EditProviderDialog provider={providerWithAuth("api-key")} />, { wrapper: TestProviders });

    await user.click(screen.getByRole("button", { name: "Manage" }));
    expect(screen.getByText("Credential is missing — replace API key")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry Binding" })).not.toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("New API key"), "replacement-key");
    await user.click(screen.getByRole("button", { name: "Replace Key" }));

    expect(mocks.saveCredential).toHaveBeenCalledWith("prv_api_key_missing", "api-key", { apiKey: "replacement-key" });
  });

  it("routes a confirmed missing OAuth credential to Reconnect OAuth", async () => {
    const user = userEvent.setup();
    mocks.startOAuth.mockResolvedValue({ sessionId: "session-1", authorizationUrl: "https://auth.example/one", expiresAt: "2026-07-15T00:10:00.000Z", bindingRevision: 3 });
    render(<EditProviderDialog provider={providerWithAuth("oauth")} />, { wrapper: TestProviders });

    await user.click(screen.getByRole("button", { name: "Manage" }));
    expect(screen.getByText("Credential is missing — reconnect OAuth")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry Binding" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reconnect OAuth" }));

    expect(mocks.startOAuth).toHaveBeenCalledWith("prv_oauth_missing");
  });

  it("routes a confirmed missing Vertex credential to write-only re-import", async () => {
    const user = userEvent.setup();
    render(<EditProviderDialog provider={providerWithAuth("credential-import")} />, { wrapper: TestProviders });

    await user.click(screen.getByRole("button", { name: "Manage" }));
    expect(screen.getByText("Credential is missing — re-import service account")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry Binding" })).not.toBeInTheDocument();
    const file = new File(["{\"type\":\"service_account\"}"], "service-account.json", { type: "application/json" });
    await user.upload(screen.getByLabelText("Service Account JSON"), file);
    await user.type(screen.getByPlaceholderText("us-central1"), "us-central1");
    await user.click(screen.getByRole("button", { name: "Re-import Credential" }));

    expect(mocks.importCredential).toHaveBeenCalledWith("prv_vertex_missing", file, "us-central1");
  });

  it("shares the reconcile busy state with credential, catalog, and traffic actions", async () => {
    const user = userEvent.setup();
    let finishReconcile!: (value: unknown) => void;
    mocks.reconcile.mockImplementation(() => new Promise((resolve) => { finishReconcile = resolve; }));
    render(<EditProviderDialog provider={provider("error")} />, { wrapper: TestProviders });

    await user.click(screen.getByRole("button", { name: "Manage" }));
    await user.click(screen.getByRole("button", { name: "Retry Binding" }));

    expect(screen.getByRole("button", { name: "Retry Binding" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Sync Models" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Enable" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reconnect OAuth" })).toBeDisabled();
    finishReconcile({ syncStatus: "ready" });
  });

  it("shows only the stable reconcile code and not a server message", async () => {
    const user = userEvent.setup();
    mocks.reconcile.mockRejectedValue(new ConsoleApiError("sensitive CPA response body", {
      status: 503,
      code: "cliproxy_credential_catalog_probe_failed"
    }));
    render(<EditProviderDialog provider={provider("error")} />, { wrapper: TestProviders });

    await user.click(screen.getByRole("button", { name: "Manage" }));
    await user.click(screen.getByRole("button", { name: "Retry Binding" }));

    expect(await screen.findByText("Binding retry failed (cliproxy_credential_catalog_probe_failed).")).toBeInTheDocument();
    expect(screen.queryByText(/sensitive CPA response body/u)).not.toBeInTheDocument();
  });

  it("stops on a terminal OAuth code and clears it when a new session starts", async () => {
    const user = userEvent.setup();
    mocks.startOAuth
      .mockResolvedValueOnce({ sessionId: "session-1", authorizationUrl: "https://auth.example/one", expiresAt: "2026-07-15T00:10:00.000Z", bindingRevision: 2 })
      .mockResolvedValueOnce({ sessionId: "session-2", authorizationUrl: "https://auth.example/two", expiresAt: "2026-07-15T00:10:00.000Z", bindingRevision: 3 });
    mocks.fetchOAuthStatus
      .mockRejectedValueOnce(new ConsoleApiError("sensitive OAuth detail", { status: 503, code: "cliproxy_oauth_credential_ambiguous" }))
      .mockResolvedValue({ status: "pending" });
    render(<EditProviderDialog provider={provider("error")} />, { wrapper: TestProviders });

    await user.click(screen.getByRole("button", { name: "Manage" }));
    await user.click(screen.getByRole("button", { name: "Reconnect OAuth" }));
    expect(await screen.findByText("OAuth connection stopped (cliproxy_oauth_credential_ambiguous). Reconnect OAuth to start a new session.")).toBeInTheDocument();
    expect(screen.queryByText(/sensitive OAuth detail/u)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reconnect OAuth" }));
    expect(screen.queryByText(/cliproxy_oauth_credential_ambiguous/u)).not.toBeInTheDocument();
    expect(mocks.startOAuth).toHaveBeenCalledTimes(2);
    expect(mocks.fetchOAuthStatus).toHaveBeenCalledTimes(2);
  });
});

function provider(syncStatus: "pending" | "ready" | "error"): ProviderRecord {
  return {
    id: "prv_111111111111111111111111",
    scopeRef: "global:",
    name: "Codex Provider",
    kind: "codex",
    status: "disabled",
    configJson: "{}",
    binding: {
      authMethod: "oauth",
      credentialOwnership: "cpa-managed",
      credentialPreview: "cod...1234",
      revision: 2,
      syncStatus,
      errorCode: syncStatus === "error" ? "cliproxy_credential_catalog_probe_failed" : null,
      updatedAt: "2026-07-15T00:00:00.000Z"
    }
  };
}

function providerWithAuth(authMethod: "api-key" | "oauth" | "credential-import"): ProviderRecord {
  const kind = authMethod === "credential-import" ? "vertex" : authMethod === "api-key" ? "openai-compatible" : "codex";
  const id = authMethod === "credential-import" ? "prv_vertex_missing" : authMethod === "api-key" ? "prv_api_key_missing" : "prv_oauth_missing";
  return {
    ...provider("error"),
    id,
    kind,
    configJson: authMethod === "api-key" ? JSON.stringify({ baseUrl: "https://api.example.com/v1", models: [{ name: "model", alias: "model" }] }) : "{}",
    binding: {
      ...provider("error").binding!,
      authMethod,
      credentialPreview: null,
      errorCode: "cliproxy_provider_credentials_not_found",
    }
  };
}

function TestProviders({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
