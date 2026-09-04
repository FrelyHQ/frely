"use client";

import React, { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@frely/ui/components/button";
import { Input } from "@frely/ui/components/input";
import type { CliProxyAuthMethod, CliProxyProviderKind, ProviderOnboardingUiCapabilities, ProviderOnboardingUiFlow } from "@frely/providers";
import { useRouter } from "@admin/navigation";
import { SearchSelect } from "../../../pages/owner/_components/search-select";
import { AdminDialog, ConsoleDialogFooter } from "../../../pages/owner/_components/ui";
import { createProvider, fetchProviderApiKeyCandidates, fetchProviderOAuthStatus, fetchProviderUserCandidates, importProviderCredential, saveProviderCredential, startProviderOAuth, submitProviderOAuthCallback, syncProviderModels, updateProvider } from "../api/provider-api";
import { buildProviderScopeOptions } from "../form/provider-form-fields";
import { normalizeProviderModelMappings, type ProviderModelMapping } from "../form/provider-model-mappings";
import { safeProviderOperationCode, startProviderOAuthStatusPolling } from "../lib/oauth-status-polling";
import { providerDialogQueryOptions } from "../query/provider-query-options";
import { providerQueryKeys } from "../query/provider-query-keys";
import type { AdminSession } from "../types";
import { ProviderModelMappingEditor } from "./provider-model-mapping-editor";

type Kind = CliProxyProviderKind;
type AuthMethod = CliProxyAuthMethod;

export function AddProviderDialog({ capabilities }: { capabilities: ProviderOnboardingUiCapabilities }) {
  const router = useRouter();
  const defaultOption = capabilities.options[0]!;
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(defaultOption.label);
  const [id, setId] = useState("");
  const [scopeRef, setScopeRef] = useState("");
  const [kind, setKind] = useState<Kind>(defaultOption.value);
  const [authMethod, setAuthMethod] = useState<AuthMethod>(defaultOption.flows[0]!.authMethod);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [credentialFile, setCredentialFile] = useState<File | null>(null);
  const [vertexLocation, setVertexLocation] = useState("");
  const [importingCredential, setImportingCredential] = useState(false);
  const [modelMappings, setModelMappings] = useState<ProviderModelMapping[]>([]);
  const [oauthSessionId, setOauthSessionId] = useState("");
  const [oauthBindingRevision, setOauthBindingRevision] = useState(0);
  const [authorizationUrl, setAuthorizationUrl] = useState("");
  const [callbackUrl, setCallbackUrl] = useState("");
  const [oauthStatusMessage, setOauthStatusMessage] = useState("");
  const [oauthTerminalCode, setOauthTerminalCode] = useState("");
  const [userSearch, setUserSearch] = useState("");
  const [debouncedUserSearch, setDebouncedUserSearch] = useState("");
  const [userCandidatePage, setUserCandidatePage] = useState(1);
  const [stage, setStage] = useState<"provider" | "credential" | "catalog" | "done">("provider");
  const [error, setError] = useState("");
  const completingOAuth = useRef(false);
  const oauthPollingGeneration = useRef(0);
  const syncMutationRef = useRef<((providerId: string) => Promise<unknown>) | null>(null);
  const query = useQuery(providerDialogQueryOptions(open));
  const createMutation = useMutation({ mutationFn: createProvider });
  const updateMutation = useMutation({ mutationFn: updateProvider });
  const credentialMutation = useMutation({ mutationFn: ({ providerId, secret }: { providerId: string; secret: string }) => saveProviderCredential(providerId, "api-key", { apiKey: secret }) });
  const syncMutation = useMutation({ mutationFn: syncProviderModels });
  const oauthStartMutation = useMutation({ mutationFn: startProviderOAuth });
  const oauthCallbackMutation = useMutation({ mutationFn: ({ providerId, sessionId, url }: { providerId: string; sessionId: string; url: string }) => submitProviderOAuthCallback(providerId, sessionId, url) });
  const busy = createMutation.isPending || updateMutation.isPending || credentialMutation.isPending || importingCredential || syncMutation.isPending || oauthStartMutation.isPending || oauthCallbackMutation.isPending;
  syncMutationRef.current = syncMutation.mutateAsync;
  const defaultScope = defaultCurrentUserScope(query.data?.session ?? null);
  useEffect(() => {
    const timer = window.setTimeout(() => { setDebouncedUserSearch(userSearch); setUserCandidatePage(1); }, 200);
    return () => window.clearTimeout(timer);
  }, [userSearch]);
  const userCandidates = useQuery({
    queryKey: providerQueryKeys.userCandidates(debouncedUserSearch, userCandidatePage),
    queryFn: ({ signal }) => fetchProviderUserCandidates(debouncedUserSearch, userCandidatePage, signal),
    enabled: open,
    staleTime: 15_000,
    retry: false
  });
  const apiKeyCandidates = useQuery({
    queryKey: providerQueryKeys.apiKeyCandidates(debouncedUserSearch, userCandidatePage),
    queryFn: ({ signal }) => fetchProviderApiKeyCandidates(debouncedUserSearch, userCandidatePage, signal),
    enabled: open,
    staleTime: 15_000,
    retry: false
  });
  const scopeOptions = buildProviderScopeOptions({ teams: query.data?.teams ?? [], users: userCandidates.data?.items ?? [], apiKeys: apiKeyCandidates.data?.items ?? [], extraScopeRefs: [defaultScope, scopeRef] });
  const selectedKind = capabilities.options.find((option) => option.value === kind) ?? capabilities.options[0]!;
  const selectedFlow = selectedKind.flows.find((flow) => flow.authMethod === authMethod) ?? selectedKind.flows[0]!;

  useEffect(() => {
    if (open && !scopeRef && defaultScope) setScopeRef(defaultScope);
  }, [defaultScope, open, scopeRef]);

  useEffect(() => {
    if (!open || !oauthSessionId || !oauthBindingRevision) return;
    const generation = ++oauthPollingGeneration.current;
    const polling = startProviderOAuthStatusPolling({
      check: (signal) => fetchProviderOAuthStatus(id, oauthSessionId, oauthBindingRevision, signal),
      onPending: () => {
        if (oauthPollingGeneration.current === generation) setOauthStatusMessage("");
      },
      onTransientError: (code, delayMs) => {
        if (oauthPollingGeneration.current === generation) setOauthStatusMessage(`OAuth status check temporarily failed (${code}); retrying in ${Math.round(delayMs / 1_000)}s.`);
      },
      onTerminalError: (code) => {
        if (oauthPollingGeneration.current !== generation) return;
        setOauthTerminalCode(code);
        setOauthStatusMessage("");
        setOauthSessionId("");
        setOauthBindingRevision(0);
        setAuthorizationUrl("");
        setCallbackUrl("");
      },
      onReady: () => {
        if (oauthPollingGeneration.current !== generation || completingOAuth.current) return;
        completingOAuth.current = true;
        setOauthStatusMessage("");
        setOauthTerminalCode("");
        setStage("catalog");
        void syncMutationRef.current?.(id).then(() => {
          if (oauthPollingGeneration.current !== generation) return;
          setStage("done");
          router.refresh();
          setOpen(false);
        }).catch((cause: unknown) => {
          if (oauthPollingGeneration.current === generation) setError(`Catalog sync failed (${safeProviderOperationCode(cause, "cliproxy_catalog_sync_failed")}).`);
        }).finally(() => {
          if (oauthPollingGeneration.current === generation) completingOAuth.current = false;
        });
      }
    });
    return () => {
      polling.cancel();
      if (oauthPollingGeneration.current === generation) oauthPollingGeneration.current += 1;
    };
  }, [id, oauthBindingRevision, oauthSessionId, open, router]);

  return <>
    <Button type="button" onClick={() => { reset(); setOpen(true); }}>Add Provider</Button>
    {open ? <AdminDialog
      observabilityKey="provider-create"
      titleId="add-provider-title"
      eyebrow="Upstream Provider"
      title="Add Provider"
      description="Create a disabled CLIProxyAPI Provider, connect its credential, then sync its prefix-scoped catalog."
      onClose={() => { if (!busy) setOpen(false); }}
      closeDisabled={busy}
    >
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <div className="form-grid">
          <label>Display Name<Input value={name} disabled={busy} onChange={(event) => setName(event.target.value)} /></label>
          <label>Provider ID<Input value={id || "Assigned after creation"} disabled /><span>Server-generated immutable CPA credential prefix.</span></label>
          <label>Scope<SearchSelect value={scopeRef} options={scopeOptions} onSearchChange={setUserSearch} onValueChange={setScopeRef} allowCustomValue disabled={Boolean(id)} pagination={{ page: userCandidates.data?.page ?? apiKeyCandidates.data?.page ?? userCandidatePage, totalPages: Math.max(userCandidates.data?.totalPages ?? userCandidatePage, apiKeyCandidates.data?.totalPages ?? userCandidatePage), pending: userCandidates.isPending || apiKeyCandidates.isPending, onPageChange: setUserCandidatePage }} /></label>
          <label>Provider Kind<SearchSelect value={kind} searchable={false} options={capabilities.options} onValueChange={(value) => changeKind(value as Kind)} disabled={Boolean(id)} /></label>
          <label>Auth Method<SearchSelect value={authMethod} searchable={false} options={selectedKind.flows.map(({ authMethod: value, label }) => ({ value, label }))} onValueChange={(value) => changeFlow(value as AuthMethod)} disabled={Boolean(id)} /></label>
          {selectedFlow.baseUrlInput !== "hidden" ? <label>Public Base URL<Input value={baseUrl} disabled={busy} placeholder="https://api.example.com/v1" required={selectedFlow.baseUrlInput === "required"} onChange={(event) => setBaseUrl(event.target.value)} /><span>{selectedFlow.baseUrlInput === "required" ? "Required by this CPA capability." : "Optional CPA upstream override; HTTPS and SSRF rules apply."}</span></label> : null}
          {authMethod === "api-key" ? <label>API Key<Input type="password" autoComplete="off" value={apiKey} placeholder="Required" onChange={(event) => setApiKey(event.target.value)} /><span>Sent write-only to CPA and cleared after every attempt.</span></label> : null}
          {authMethod === "credential-import" ? <>
            <label>Service Account JSON<Input type="file" accept="application/json,.json" required onChange={(event) => setCredentialFile(event.target.files?.[0] ?? null)} /><span>Transferred write-only to CPA; Friday stores only the resulting credential reference.</span></label>
            <label>Vertex Location<Input value={vertexLocation} placeholder="us-central1" required onChange={(event) => setVertexLocation(event.target.value)} /></label>
          </> : null}
        </div>
        {authMethod === "api-key" ? <ProviderModelMappingEditor value={modelMappings} onChange={setModelMappings} disabled={busy} /> : null}
        {oauthSessionId || oauthTerminalCode ? <div className="embedded-section">
          <div className="panel-heading"><div><strong>Complete OAuth</strong><p>Open the authorization page, then wait for status. If the provider redirects to localhost, paste that final URL below.</p></div></div>
          {oauthSessionId ? <>
            <div className="drawer-actions"><Button type="button" variant="secondary" onClick={() => window.open(authorizationUrl, "_blank", "noopener,noreferrer")}>Open authorization page</Button></div>
            <label>Final localhost callback URL<Input value={callbackUrl} onChange={(event) => setCallbackUrl(event.target.value)} placeholder="http://localhost:.../?code=...&state=..." /></label>
            <div className="drawer-actions"><Button type="button" variant="secondary" disabled={busy || !callbackUrl.trim()} onClick={() => void submitCallback()}>Submit callback</Button></div>
          </> : <Button type="button" variant="secondary" disabled={busy || !id} onClick={() => void startOAuthConnection(id)}>Reconnect OAuth</Button>}
        </div> : null}
        {capabilities.blocked.length > 0 ? <div className="embedded-section" aria-label="Unavailable CPA capabilities">
          <div className="panel-heading"><div><strong>Unavailable CPA capabilities</strong><p>Detected in CPA {capabilities.version}, but blocked by an explicit Friday product boundary.</p></div></div>
          <div className="rule-table">{capabilities.blocked.map((capability) => <div key={capability.id}><strong>{capability.label}</strong><span>{capability.reason}</span></div>)}</div>
        </div> : null}
        <div className="embedded-section">
          <div className="rule-table">
            <div><strong>Provider</strong><span>{stageState("provider", stage)}</span></div>
            <div><strong>Credential binding</strong><span>{stageState("credential", stage)}</span></div>
            <div><strong>Catalog</strong><span>{stageState("catalog", stage)}</span></div>
            <div><strong>Traffic</strong><span>disabled until explicit review and enable</span></div>
          </div>
        </div>
        <ConsoleDialogFooter feedback={query.isError || oauthStatusMessage || oauthTerminalCode || error ? <>
          {query.isError ? <div className="notice-box notice-bad" role="alert">Provider options failed to load.</div> : null}
          {oauthStatusMessage ? <div className="notice-box" role="status">{oauthStatusMessage}</div> : null}
          {oauthTerminalCode ? <div className="notice-box notice-bad" role="alert">OAuth connection stopped ({oauthTerminalCode}). Reconnect OAuth to start a new session.</div> : null}
          {error ? <div className="notice-box notice-bad" role="alert">{error}</div> : null}
        </> : null}>
          <Button type="button" variant="secondary" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
          <Button type="submit" disabled={busy || Boolean(oauthSessionId)}>{busy ? "Connecting..." : "Create and connect"}</Button>
        </ConsoleDialogFooter>
      </form>
    </AdminDialog> : null}
  </>;

  async function submit() {
    setError("");
    const secret = apiKey.trim();
    if (authMethod === "api-key") setApiKey("");
    if (!name.trim() || !scopeRef.trim() || (authMethod === "api-key" && !secret) || (authMethod === "credential-import" && (!credentialFile || !vertexLocation.trim()))) {
      setError("Display Name and Scope are required; credential fields for the selected CPA capability are also required.");
      return;
    }
    const normalizedMappings = authMethod === "api-key" ? normalizeProviderModelMappings(modelMappings) : null;
    if (normalizedMappings && !normalizedMappings.ok) {
      setError(normalizedMappings.error);
      return;
    }
    if (selectedFlow.baseUrlInput === "required" && !baseUrl.trim()) {
      setError(`${selectedKind.label} requires a public Base URL.`);
      return;
    }
    try {
      setStage("provider");
      let providerId = id;
      const providerConfig = authMethod === "api-key" ? { ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}), models: normalizedMappings?.value ?? [] } : {};
      if (!providerId) {
        const created = await createMutation.mutateAsync({
          name: name.trim(),
          scopeRef: scopeRef.trim(),
          kind,
          authMethod,
          config: providerConfig
        });
        providerId = created.id;
        setId(providerId);
      } else {
        await updateMutation.mutateAsync({ id: providerId, name: name.trim(), scopeRef: scopeRef.trim(), kind, authMethod, status: "disabled", config: providerConfig });
      }
      setStage("credential");
      if (authMethod === "oauth") {
        await startOAuthConnection(providerId);
        return;
      }
      if (authMethod === "credential-import") {
        const file = credentialFile!;
        setCredentialFile(null);
        setImportingCredential(true);
        try {
          await importProviderCredential(providerId, file, vertexLocation.trim());
        } finally {
          setImportingCredential(false);
        }
      } else {
        await credentialMutation.mutateAsync({ providerId, secret });
      }
      setStage("catalog");
      await syncMutation.mutateAsync(providerId);
      setStage("done");
      router.refresh();
      setOpen(false);
    } catch (cause) {
      setError(`Provider onboarding failed (${safeProviderOperationCode(cause, "cliproxy_provider_onboarding_failed")}).`);
      router.refresh();
    }
  }

  async function submitCallback() {
    setError("");
    try {
      await oauthCallbackMutation.mutateAsync({ providerId: id, sessionId: oauthSessionId, url: callbackUrl.trim() });
      setCallbackUrl("");
    } catch (cause) { setError(`OAuth callback failed (${safeProviderOperationCode(cause, "cliproxy_oauth_callback_failed")}).`); }
  }

  async function startOAuthConnection(providerId: string) {
    oauthPollingGeneration.current += 1;
    setOauthSessionId("");
    setOauthBindingRevision(0);
    setOauthStatusMessage("");
    setOauthTerminalCode("");
    setError("");
    try {
      const oauth = await oauthStartMutation.mutateAsync(providerId);
      setOauthSessionId(oauth.sessionId);
      setOauthBindingRevision(oauth.bindingRevision);
      setAuthorizationUrl(oauth.authorizationUrl);
      window.open(oauth.authorizationUrl, "_blank", "noopener,noreferrer");
    } catch (cause) {
      setError(`Start OAuth failed (${safeProviderOperationCode(cause, "cliproxy_oauth_start_failed")}).`);
    }
  }

  function changeKind(next: Kind) {
    const definition = capabilities.options.find((option) => option.value === next)!;
    setKind(next);
    setAuthMethod(definition.flows[0]!.authMethod);
    setName(definition.label);
    setModelMappings([]);
    setBaseUrl("");
    setCredentialFile(null);
    setVertexLocation("");
  }

  function changeFlow(next: AuthMethod) {
    const nextFlow = selectedKind.flows.find((flow) => flow.authMethod === next) as ProviderOnboardingUiFlow | undefined;
    if (!nextFlow) return;
    setAuthMethod(next);
    setBaseUrl("");
    setApiKey("");
    setCredentialFile(null);
    setVertexLocation("");
  }

  function reset() {
    oauthPollingGeneration.current += 1;
    completingOAuth.current = false;
    const first = capabilities.options[0]!;
    setError(""); setOauthStatusMessage(""); setOauthTerminalCode(""); setStage("provider"); setName(first.label); setKind(first.value); setAuthMethod(first.flows[0]!.authMethod); setApiKey(""); setBaseUrl(""); setCredentialFile(null); setVertexLocation(""); setModelMappings([]); setOauthSessionId(""); setOauthBindingRevision(0); setAuthorizationUrl(""); setCallbackUrl(""); setUserSearch(""); setDebouncedUserSearch(""); setUserCandidatePage(1);
    setId("");
    setScopeRef(defaultScope);
  }
}

function defaultCurrentUserScope(session: AdminSession | null): string {
  if (session?.userId) return `user:${session.userId}`;
  return "";
}

function stageState(item: "provider" | "credential" | "catalog", stage: "provider" | "credential" | "catalog" | "done"): string {
  const order = ["provider", "credential", "catalog", "done"];
  const current = order.indexOf(stage);
  const target = order.indexOf(item);
  return current > target ? "ready" : current === target ? "in progress" : "pending";
}
