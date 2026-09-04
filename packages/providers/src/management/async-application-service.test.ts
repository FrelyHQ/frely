import type { AuditCommands } from "@frely/audit";
import { RelayError } from "@frely/core";
import type {
  ModelAccessManagementQueryService,
  ProviderBindingTransitionView,
  ProviderManagementCommandService,
  ProviderManagementView,
} from "@frely/model-access/server";
import type { ApplicationCommands, ApplicationQueries, Provider, ProviderBinding } from "@frely/application/runtime";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CliProxyControlClient } from "../cliproxy/control-client.js";
import { AsyncProviderManagementService } from "./async-application-service.js";

const provider = {
  id: "provider_test", ownerId: "user_owner", scopeRef: "global:", name: "Provider", kind: "openai-compatible",
  status: "enabled", baseUrlResolver: "literal:", credentialResolver: "api-key:", modelsResolver: "cliproxyapi:catalog",
  configJson: "{}", cpaInstanceId: "cpa_default", createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z",
} satisfies Provider;
const binding = {
  providerId: provider.id, authMethod: "api-key", credentialOwnership: "cpa-managed", credentialRefsJson: "[\"ref\"]",
  credentialPreview: "key-...", revision: 7, syncStatus: "ready", errorCode: null,
  createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z",
} satisfies ProviderBinding;

const oauthProvider: ProviderManagementView = {
  id: "prv_0123456789abcdef01234567",
  ownerId: "user_test",
  scopeRef: "user:user_test",
  name: "Codex",
  kind: "codex",
  status: "disabled",
  baseUrlResolver: "literal:",
  credentialResolver: "oauth:",
  modelsResolver: "cliproxyapi:catalog",
  configJson: "{}",
  cpaInstanceId: "cpa-default",
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
};
const oauthBinding: ProviderBinding = {
  providerId: oauthProvider.id,
  authMethod: "oauth",
  credentialOwnership: "cpa-managed",
  credentialRefsJson: "[]",
  credentialPreview: null,
  revision: 7,
  syncStatus: "error",
  errorCode: "provider_binding_transition_in_progress",
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
};
const pending: ProviderBindingTransitionView = { ...oauthBinding, revision: 8, previousSyncStatus: "error" };
const oauthContext = {
  actor: { actorType: "user" as const, actorId: "user_test" },
  source: "owner" as const,
  requestId: "req_provider_binding_transition",
};

const originalEnvironment = { baseUrl: process.env.CLIPROXY_CONTROL_BASE_URL, apiKey: process.env.CLIPROXY_CONTROL_API_KEY };

beforeEach(() => {
  process.env.CLIPROXY_CONTROL_BASE_URL = "http://control.test";
  process.env.CLIPROXY_CONTROL_API_KEY = "x".repeat(32);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalEnvironment.baseUrl === undefined) delete process.env.CLIPROXY_CONTROL_BASE_URL;
  else process.env.CLIPROXY_CONTROL_BASE_URL = originalEnvironment.baseUrl;
  if (originalEnvironment.apiKey === undefined) delete process.env.CLIPROXY_CONTROL_API_KEY;
  else process.env.CLIPROXY_CONTROL_API_KEY = originalEnvironment.apiKey;
});

describe("AsyncProviderManagementService Provider binding terminal decisions", () => {
  test.each([
    ["malformed ready credential", { status: "ready", credential: { credentialRef: "ref-oauth" } }],
    ["unknown terminal status", { status: "failed" }],
  ])("ends the OAuth reservation for %s", async (_case, result) => {
    vi.spyOn(CliProxyControlClient, "fromEnv").mockReturnValue({
      oauthStatus: vi.fn().mockResolvedValue(result),
    } as unknown as CliProxyControlClient);
    const { service, complete } = oauthFixture();

    await expect(service.oauthStatus(oauthProvider.id, "oauth-session", pending.revision, oauthContext))
      .rejects.toMatchObject({ code: "cliproxy_oauth_invalid_response" });

    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith(oauthProvider.id, pending.revision, {
      syncStatus: "error",
      errorCode: "cliproxy_oauth_invalid_response",
    });
  });
});

describe("Provider Base URL management policy", () => {
  test.each([
    ["platform owner", { actor: { actorType: "user" as const, actorId: "user_owner" }, source: "owner" as const }],
    ["Team owner", { actor: { actorType: "user" as const, actorId: "user_team" }, source: "web" as const, fixedScopeRef: "team:team_test" as const }],
  ])("rejects an internal URL for %s before creating a Provider", async (_label, context) => {
    const createProvider = vi.fn();
    const service = new AsyncProviderManagementService(
      { getProviderBinding: vi.fn().mockResolvedValue(undefined) } as unknown as ApplicationQueries,
      {} as ApplicationCommands,
      { createProvider } as unknown as ProviderManagementCommandService,
      { hasEnabledProviderModel: vi.fn().mockResolvedValue(false) } as unknown as ModelAccessManagementQueryService,
      { record: vi.fn() },
    );

    await expect(service.mutate("POST", {
      name: "Unsafe provider", kind: "openai-compatible", authMethod: "api-key",
      config: { baseUrl: "http://127.0.0.1:43003/v1", models: [{ name: "model", alias: "model" }] },
    }, context)).rejects.toMatchObject({ code: "provider_url_not_allowed" });
    expect(createProvider).not.toHaveBeenCalled();
  });

  test("allows only the configured private origin for a platform Owner", async () => {
    const createProvider = vi.fn().mockResolvedValue(provider);
    const service = new AsyncProviderManagementService(
      { getProviderBinding: vi.fn().mockResolvedValue(undefined) } as unknown as ApplicationQueries,
      {} as ApplicationCommands,
      { createProvider } as unknown as ProviderManagementCommandService,
      { hasEnabledProviderModel: vi.fn().mockResolvedValue(false) } as unknown as ModelAccessManagementQueryService,
      { record: vi.fn() },
    );

    await expect(service.mutate("POST", {
      name: "Private provider", kind: "openai-compatible", authMethod: "api-key",
      config: { baseUrl: "http://100.64.0.10:43003/v1", models: [{ name: "model", alias: "model" }] },
    }, { actor: { actorType: "user", actorId: "user_owner" }, source: "owner", privateProviderOrigin: "http://100.64.0.10:43003" })).resolves.toMatchObject({ id: provider.id });
    expect(createProvider).toHaveBeenCalledOnce();
  });
});

describe("on-demand Provider binding refresh", () => {
  test("writes a ready observation through the expected revision CAS", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [{
      providerId: provider.id, credentialRef: "credential-ref", credentialStatus: "ready", credentialFailureReason: null, credentialErrorCode: null,
      configuredModels: ["model"], catalogStatus: "full", catalogPresentModels: ["model"],
      catalogMissingModels: [], catalogAttemptedAt: "2026-08-20T00:01:00.000Z", catalogCheckedAt: "2026-08-20T00:01:00.000Z",
      lastSuccessfulCatalogCheckedAt: "2026-08-20T00:01:00.000Z", catalogErrorCode: null, stale: false,
    }] }), { status: 200, headers: { "content-type": "application/json" } })));
    const updates: unknown[] = [];
    const repository = fakeApplicationOperationPort(async (input) => {
      updates.push(input);
      return { ...binding, syncStatus: "ready", updatedAt: "2026-08-20T00:01:00.000Z" };
    });
    const result = await serviceForApplicationOperationPort(repository).reconcileVisible(
      [{ providerId: provider.id, expectedRevision: 7 }],
      { actor: { actorType: "user", actorId: "user_owner" }, source: "owner" },
    );
    expect(result.items).toEqual([{ providerId: provider.id, result: "ready", syncStatus: "ready", errorCode: null }]);
    expect(updates).toEqual([{ providerId: provider.id, expectedCpaInstanceId: "cpa_default", expectedRevision: 7, syncStatus: "ready", errorCode: null }]);
  });

  test("rejects a reconciliation response for another Provider", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [{
      providerId: "provider_other", credentialRef: "credential-ref", credentialStatus: "ready", credentialFailureReason: null, credentialErrorCode: null,
      configuredModels: ["model"], catalogStatus: "full", catalogPresentModels: ["model"],
      catalogMissingModels: [], catalogAttemptedAt: "2026-08-20T00:01:00.000Z", catalogCheckedAt: "2026-08-20T00:01:00.000Z",
      lastSuccessfulCatalogCheckedAt: "2026-08-20T00:01:00.000Z", catalogErrorCode: null, stale: false,
    }] }), { status: 200, headers: { "content-type": "application/json" } })));
    const update = vi.fn();
    const result = await serviceForApplicationOperationPort(fakeApplicationOperationPort(update)).reconcileVisible(
      [{ providerId: provider.id, expectedRevision: 7 }],
      { actor: { actorType: "user", actorId: "user_owner" }, source: "owner" },
    );
    expect(result.items[0]).toMatchObject({ result: "transient", errorCode: "cliproxy_control_invalid_response" });
    expect(update).not.toHaveBeenCalled();
  });

  test("preserves the binding on transient Control failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const update = vi.fn();
    const result = await serviceForApplicationOperationPort(fakeApplicationOperationPort(update)).reconcileVisible(
      [{ providerId: provider.id, expectedRevision: 7 }],
      { actor: { actorType: "user", actorId: "user_owner" }, source: "owner" },
    );
    expect(result.items[0]).toMatchObject({ result: "transient", syncStatus: "ready", errorCode: "cliproxy_control_unavailable" });
    expect(update).not.toHaveBeenCalled();
  });

  test("rejects a mixed-scope batch before any Control call or CAS write", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const update = vi.fn();
    const audit = vi.fn(async () => undefined);
    const other = { ...provider, id: "provider_other", scopeRef: "team:other" };
    const repository: ProviderApplicationFixture = {
      queries: {
        getProviderBindingRefreshSnapshots: async () => [
          { provider: { ...provider, scopeRef: "team:expected" }, binding },
          { provider: other, binding: { ...binding, providerId: other.id } },
        ],
      } as unknown as ApplicationQueries,
      commands: { updateProviderBindingStatusIfCurrent: update } as unknown as ApplicationCommands,
      audit: { record: audit } as AuditCommands,
    };
    await expect(serviceForApplicationOperationPort(repository).reconcileVisible(
      [{ providerId: provider.id, expectedRevision: 7 }, { providerId: other.id, expectedRevision: 7 }],
      { actor: { actorType: "user", actorId: "user_owner" }, source: "web", fixedScopeRef: "team:expected" },
    )).rejects.toMatchObject({ code: "provider_scope_forbidden" });
    expect(fetch).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "provider_binding.reconcile_batch", result: "failure" }));
  });

  test("marks only a confirmed credential failure as error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [{
      providerId: provider.id, credentialRef: "credential-ref", credentialStatus: "unready", credentialFailureReason: "auth_not_found", credentialErrorCode: "cliproxy_provider_credentials_not_found",
      configuredModels: [], catalogStatus: "unknown", catalogPresentModels: [], catalogMissingModels: [],
      catalogAttemptedAt: "2026-08-20T00:01:00.000Z", catalogCheckedAt: null,
      lastSuccessfulCatalogCheckedAt: null, catalogErrorCode: "cliproxy_provider_credentials_not_found", stale: false,
    }] }), { status: 200, headers: { "content-type": "application/json" } })));
    const update = vi.fn(async () => ({ ...binding, syncStatus: "error" as const, errorCode: "cliproxy_provider_credentials_not_found" }));
    const result = await serviceForApplicationOperationPort(fakeApplicationOperationPort(update)).reconcileVisible(
      [{ providerId: provider.id, expectedRevision: 7 }],
      { actor: { actorType: "user", actorId: "user_owner" }, source: "owner" },
    );
    expect(result.items[0]).toMatchObject({ result: "error", syncStatus: "error", errorCode: "cliproxy_provider_credentials_not_found" });
    expect(update).toHaveBeenCalledOnce();
  });

  test("clears stale credential summary only when the credential is confirmed missing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [{
      providerId: provider.id, credentialRef: null, credentialStatus: "unready", credentialFailureReason: "auth_not_found", credentialErrorCode: "cliproxy_provider_credentials_not_found",
      configuredModels: [], catalogStatus: "unknown", catalogPresentModels: [], catalogMissingModels: [],
      catalogAttemptedAt: "2026-08-20T00:01:00.000Z", catalogCheckedAt: null, lastSuccessfulCatalogCheckedAt: null,
      catalogErrorCode: "cliproxy_provider_credentials_not_found", stale: false,
    }] }), { status: 200, headers: { "content-type": "application/json" } })));
    const update = vi.fn(async () => ({ ...binding, credentialRefsJson: "[]", credentialPreview: null, syncStatus: "error" as const, errorCode: "cliproxy_provider_credentials_not_found" }));
    const result = await serviceForApplicationOperationPort(fakeApplicationOperationPort(update)).reconcileVisible(
      [{ providerId: provider.id, expectedRevision: 7 }],
      { actor: { actorType: "user", actorId: "user_owner" }, source: "owner" },
    );
    expect(result.items[0]).toMatchObject({ result: "error", errorCode: "cliproxy_provider_credentials_not_found" });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ clearCredentialSummary: true }));
  });
});

interface ProviderApplicationFixture {
  queries: ApplicationQueries;
  commands: ApplicationCommands;
  audit: AuditCommands;
}

function oauthFixture() {
  const applicationQueries = { getProviderBinding: vi.fn().mockResolvedValue(oauthBinding) } as unknown as ApplicationQueries;
  const complete = vi.fn().mockResolvedValue(pending);
  const modelAccessCommands = {
    beginProviderBindingTransition: vi.fn().mockResolvedValue(pending),
    completeProviderBindingTransition: complete,
  } as unknown as ProviderManagementCommandService;
  const modelAccessQueries = { getProvider: vi.fn().mockResolvedValue(oauthProvider) } as unknown as ModelAccessManagementQueryService;
  return { service: new AsyncProviderManagementService(applicationQueries, {} as ApplicationCommands, modelAccessCommands, modelAccessQueries, { record: vi.fn() }), complete };
}

function serviceForApplicationOperationPort(application: ProviderApplicationFixture): AsyncProviderManagementService {
  return new AsyncProviderManagementService(
    application.queries,
    application.commands,
    {} as ProviderManagementCommandService,
    { getProvider: async () => provider as unknown as ProviderManagementView } as unknown as ModelAccessManagementQueryService,
    application.audit,
  );
}

function fakeApplicationOperationPort(
  updateProviderBindingStatusIfCurrent: (input: unknown) => Promise<ProviderBinding | undefined> | ProviderBinding | undefined,
): ProviderApplicationFixture {
  return {
    queries: {
      getProvider: async () => provider,
      getProviderBinding: async () => binding,
      getProviderBindingRefreshSnapshots: async () => [{ provider, binding }],
    } as unknown as ApplicationQueries,
    commands: {
      updateProviderBindingStatusIfCurrent,
    } as unknown as ApplicationCommands,
    audit: { record: async () => undefined },
  };
}
