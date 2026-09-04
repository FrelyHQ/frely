"use client";

import React, { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@frely/ui/components/button";
import { Input } from "@frely/ui/components/input";
import { CLI_PROXY_KIND_DEFINITIONS, type CliProxyProviderKind } from "@frely/providers";
import { useRouter } from "@admin/navigation";
import { AdminDialog, ConsoleDialogFooter, StatusBadge } from "../../../pages/owner/_components/ui";
import {
  clearProviderCredential,
  fetchProviderOAuthStatus,
  importProviderCredential,
  reconcileProviderBinding,
  saveProviderCredential,
  startProviderOAuth,
  submitProviderOAuthCallback,
  syncProviderModels,
  updateProvider,
  updateProviderModel
} from "../api/provider-api";
import { safeProviderOperationCode, startProviderOAuthStatusPolling } from "../lib/oauth-status-polling";
import { normalizeProviderModelMappings, type ProviderModelMapping } from "../form/provider-model-mappings";
import type { ProviderRecord } from "../types";
import { ProviderModelMappingEditor } from "./provider-model-mapping-editor";

export function EditProviderDialog({ provider }: { provider: ProviderRecord }) {
  return <CliProxyProviderDialog provider={provider} />;
}

function CliProxyProviderDialog({ provider }: { provider: ProviderRecord }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [modelMappings, setModelMappings] = useState<ProviderModelMapping[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [credentialFile, setCredentialFile] = useState<File | null>(null);
  const [vertexLocation, setVertexLocation] = useState("");
  const [oauthSessionId, setOauthSessionId] = useState("");
  const [oauthBindingRevision, setOauthBindingRevision] = useState(0);
  const [authorizationUrl, setAuthorizationUrl] = useState("");
  const [callbackUrl, setCallbackUrl] = useState("");
  const [oauthStatusMessage, setOauthStatusMessage] = useState("");
  const [oauthTerminalCode, setOauthTerminalCode] = useState("");
  const completingOAuth = useRef(false);
  const oauthPollingGeneration = useRef(0);
  const syncMutationRef = useRef<(() => Promise<unknown>) | null>(null);
  const updateMutation = useMutation({ mutationFn: updateProvider });
  const credentialMutation = useMutation({ mutationFn: (secret: string) => saveProviderCredential(provider.id, "api-key", { apiKey: secret }) });
  const importMutation = useMutation({ mutationFn: ({ file, location }: { file: File; location: string }) => importProviderCredential(provider.id, file, location) });
  const clearMutation = useMutation({ mutationFn: () => clearProviderCredential(provider.id) });
  const reconcileMutation = useMutation({ mutationFn: () => reconcileProviderBinding(provider.id) });
  const syncMutation = useMutation({ mutationFn: () => syncProviderModels(provider.id) });
  const modelMutation = useMutation({ mutationFn: updateProviderModel });
  const oauthStartMutation = useMutation({ mutationFn: () => startProviderOAuth(provider.id) });
  const oauthCallbackMutation = useMutation({ mutationFn: (url: string) => submitProviderOAuthCallback(provider.id, oauthSessionId, url) });
  const busy = updateMutation.isPending || credentialMutation.isPending || importMutation.isPending || clearMutation.isPending || reconcileMutation.isPending || syncMutation.isPending || modelMutation.isPending || oauthStartMutation.isPending || oauthCallbackMutation.isPending;
  syncMutationRef.current = syncMutation.mutateAsync;
  const binding = provider.binding;
  const definition = CLI_PROXY_KIND_DEFINITIONS[provider.kind as CliProxyProviderKind];
  const selectedFlow = definition?.flows.find((flow) => flow.authMethod === binding?.authMethod);
  const credentialMissing = isMissingCredentialCode(binding?.errorCode);
  const canRetryBinding = (binding?.syncStatus === "pending" || binding?.syncStatus === "error") && !credentialMissing;

  useEffect(() => {
    if (!open || !oauthSessionId || !oauthBindingRevision) return;
    const generation = ++oauthPollingGeneration.current;
    const polling = startProviderOAuthStatusPolling({
      check: (signal) => fetchProviderOAuthStatus(provider.id, oauthSessionId, oauthBindingRevision, signal),
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
        void syncMutationRef.current?.().then(() => {
          if (oauthPollingGeneration.current !== generation) return;
          setOauthSessionId("");
          setOauthBindingRevision(0);
          setAuthorizationUrl("");
          setCallbackUrl("");
          router.refresh();
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
  }, [oauthBindingRevision, oauthSessionId, open, provider.id, router]);

  return <>
    <Button type="button" variant="secondary" onClick={() => { oauthPollingGeneration.current += 1; setError(""); setOauthStatusMessage(""); setOauthTerminalCode(""); setApiKey(""); setCredentialFile(null); setVertexLocation(""); setName(provider.name); const config = parseProviderConfig(provider.configJson); setBaseUrl(config.baseUrl); setModelMappings(config.models); setOauthSessionId(""); setOauthBindingRevision(0); setAuthorizationUrl(""); setCallbackUrl(""); completingOAuth.current = false; setOpen(true); }}>Manage</Button>
    {open ? <AdminDialog
      observabilityKey="provider-edit"
      titleId={`edit-provider-${provider.id}-title`}
      eyebrow="CLIProxyAPI Provider"
      title={provider.name}
      description="Manage traffic and the CPA-owned credential without exposing internal resolvers or credentials."
      onClose={() => { if (!busy) setOpen(false); }}
      closeDisabled={busy}
    >
      <div className="rule-table">
        <div><strong>Provider ID</strong><code>{provider.id}</code></div>
        <div><strong>Transport</strong><span>CLIProxyAPI</span></div>
        <div><strong>Kind</strong><span>{provider.kind}</span></div>
        <div><strong>Auth Method</strong><span>{binding?.authMethod ?? "Not initialized"}</span></div>
        <div><strong>Credential</strong><span>{binding?.credentialPreview ?? "Not configured"}</span></div>
        <div><strong>Binding</strong><span>{binding?.syncStatus ?? "Not initialized"}</span></div>
        <div><strong>Revision</strong><span>{binding?.revision ?? "—"}</span></div>
        <div><strong>Last error</strong><code>{binding?.errorCode ?? "None"}</code></div>
        <div><strong>Traffic</strong><span>{provider.status}</span></div>
      </div>
      <div className="embedded-section">
        <div className="panel-heading"><div><strong>Edit Provider configuration</strong><p>Name, public Base URL, and API-key model mappings can be changed after creation. Kind, Auth Method, scope, and Provider ID remain immutable here.</p></div></div>
        <div className="form-grid">
          <label>Display Name<Input value={name} disabled={busy} onChange={(event) => setName(event.target.value)} /></label>
          {selectedFlow && selectedFlow.baseUrlInput !== "hidden" ? <label>Public Base URL<Input value={baseUrl} disabled={busy} placeholder="https://api.example.com/v1" onChange={(event) => setBaseUrl(event.target.value)} /><span>HTTPS and SSRF rules apply before the Provider is changed.</span></label> : null}
        </div>
        {binding?.authMethod === "api-key" ? <ProviderModelMappingEditor value={modelMappings} onChange={setModelMappings} disabled={busy} /> : null}
        <div className="drawer-actions"><Button type="button" variant="secondary" disabled={busy || !name.trim()} onClick={() => void saveConfiguration()}>Save configuration</Button></div>
      </div>
      {binding?.authMethod === "api-key" ? <div className="embedded-section">
        <div className="panel-heading"><div><strong>{credentialMissing ? "Credential is missing — replace API key" : "Replace API Key"}</strong><p>The new key is sent write-only to CPA and never returned. Reconcile cannot recreate a missing key.</p></div></div>
        <Input type="password" autoComplete="off" value={apiKey} placeholder="New API key" onChange={(event) => setApiKey(event.target.value)} />
      </div> : null}
      {binding?.authMethod === "credential-import" ? <div className="embedded-section">
        <div className="panel-heading"><div><strong>{credentialMissing ? "Credential is missing — re-import service account" : "Re-import service account"}</strong><p>The service account JSON is transferred write-only to CPA and is never returned or stored by Frely.</p></div></div>
        <div className="form-grid"><label>Service Account JSON<Input type="file" accept="application/json,.json" onChange={(event) => setCredentialFile(event.target.files?.[0] ?? null)} /></label><label>Vertex Location<Input value={vertexLocation} placeholder="us-central1" onChange={(event) => setVertexLocation(event.target.value)} /></label></div>
        <div className="drawer-actions"><Button type="button" variant="secondary" disabled={busy || !credentialFile || !vertexLocation.trim()} onClick={() => void reimportCredential()}>Re-import Credential</Button></div>
      </div> : null}
      <div className="embedded-section">
        <div className="panel-heading"><div><strong>Provider Models</strong><p>Catalog sync discovers new models as disabled. The Provider directory pages models independently; enable each model explicitly before enabling Provider traffic.</p></div></div>
        {(provider.models ?? []).length ? <div className="rule-table">
          {(provider.models ?? []).map((model) => <div key={model.id}>
            <span><strong>{model.displayName}</strong><br /><code>{model.providerModelName}</code></span>
            <span className="button-row">
              <StatusBadge tone={model.status === "enabled" ? "good" : "neutral"}>{model.status}</StatusBadge>
              <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => void toggleModel(model.providerModelName, model.status)}>{model.status === "enabled" ? "Disable model" : "Enable model"}</Button>
            </span>
          </div>)}
        </div> : <p className="muted">{(provider.modelCount ?? 0) > 0 ? "No Provider models on this page." : "No Provider models discovered. Sync the catalog first."}</p>}
      </div>
      {binding?.authMethod === "oauth" ? <div className="embedded-section">
        <div className="panel-heading"><div><strong>{credentialMissing ? "Credential is missing — reconnect OAuth" : "OAuth connection"}</strong><p>Start or recover this Provider&apos;s CPA-owned OAuth binding.</p></div></div>
        {oauthSessionId ? <>
          <div className="drawer-actions"><Button type="button" variant="secondary" disabled={busy} onClick={() => window.open(authorizationUrl, "_blank", "noopener,noreferrer")}>Open authorization page</Button></div>
          <label>Final localhost callback URL<Input value={callbackUrl} onChange={(event) => setCallbackUrl(event.target.value)} placeholder="http://localhost:.../?code=...&state=..." /></label>
          <div className="drawer-actions"><Button type="button" variant="secondary" disabled={busy || !callbackUrl.trim()} onClick={() => void submitOAuthCallbackUrl()}>Submit callback</Button></div>
        </> : <Button type="button" variant="secondary" disabled={busy} onClick={() => void reconnectOAuth()}>Reconnect OAuth</Button>}
      </div> : null}
      <ConsoleDialogFooter feedback={oauthStatusMessage || oauthTerminalCode || error ? <>
        {oauthStatusMessage ? <div className="notice-box" role="status">{oauthStatusMessage}</div> : null}
          {oauthTerminalCode ? <div className="notice-box notice-bad" role="alert">OAuth connection stopped ({oauthTerminalCode}). Reconnect OAuth to start a new session.</div> : null}
        {error ? <div className="notice-box notice-bad" role="alert">{error}</div> : null}
      </> : null}>
        <Button type="button" variant="destructive" disabled={busy || !binding?.credentialPreview} onClick={() => void clearCredential()}>Clear Credential</Button>
        {canRetryBinding ? <Button type="button" variant="secondary" disabled={busy} onClick={() => void retryBinding()}>Retry Binding</Button> : null}
        <Button type="button" variant="secondary" disabled={busy} onClick={() => void syncModels()}>Sync Models</Button>
        {binding?.authMethod === "api-key" ? <Button type="button" variant="secondary" disabled={busy || !apiKey.trim()} onClick={() => void replaceCredential()}>Replace Key</Button> : null}
        <Button type="button" disabled={busy} onClick={() => void toggleStatus()}>{provider.status === "enabled" ? "Disable" : "Enable"}</Button>
      </ConsoleDialogFooter>
    </AdminDialog> : null}
  </>;

  async function replaceCredential() {
    const secret = apiKey.trim();
    setApiKey(""); setError("");
    if (!secret) return;
    try { await credentialMutation.mutateAsync(secret); router.refresh(); }
    catch (cause) { setError(errorMessage(cause, "Replace credential failed")); }
  }

  async function reimportCredential() {
    if (!credentialFile || !vertexLocation.trim()) return;
    setError("");
    const file = credentialFile;
    setCredentialFile(null);
    try { await importMutation.mutateAsync({ file, location: vertexLocation.trim() }); router.refresh(); }
    catch (cause) { setError(errorMessage(cause, "Re-import credential failed")); }
  }

  async function saveConfiguration() {
    setError("");
    const normalized = binding?.authMethod === "api-key" ? normalizeProviderModelMappings(modelMappings) : { ok: true as const, value: [] };
    if (!normalized.ok) { setError(normalized.error); return; }
    try {
      await updateMutation.mutateAsync({
        id: provider.id,
        name: name.trim(),
        scopeRef: provider.scopeRef,
        kind: provider.kind,
        authMethod: binding?.authMethod,
        status: provider.status,
        config: { ...(selectedFlow && selectedFlow.baseUrlInput !== "hidden" && baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}), models: normalized.value },
      });
      router.refresh();
    } catch (cause) { setError(errorMessage(cause, "Save Provider configuration failed")); }
  }

  async function clearCredential() {
    setError("");
    try { await clearMutation.mutateAsync(); router.refresh(); setOpen(false); }
    catch (cause) { setError(errorMessage(cause, "Clear credential failed")); }
  }

  async function syncModels() {
    setError("");
    try { await syncMutation.mutateAsync(); router.refresh(); }
    catch (cause) { setError(errorMessage(cause, "Sync provider models failed")); }
  }

  async function toggleModel(providerModelName: string, status: string) {
    setError("");
    try {
      await modelMutation.mutateAsync({
        providerId: provider.id,
        providerModelName,
        status: status === "enabled" ? "disabled" : "enabled",
      });
      router.refresh();
    } catch (cause) { setError(errorMessage(cause, "Update Provider model failed")); }
  }

  async function retryBinding() {
    setError("");
    try { await reconcileMutation.mutateAsync(); router.refresh(); }
    catch (cause) { setError(`Binding retry failed (${safeProviderOperationCode(cause, "cliproxy_binding_reconcile_failed")}).`); }
  }

  async function reconnectOAuth() {
    oauthPollingGeneration.current += 1;
    setOauthSessionId("");
    setOauthBindingRevision(0);
    setOauthStatusMessage("");
    setOauthTerminalCode("");
    setError("");
    try {
      const result = await oauthStartMutation.mutateAsync();
      setOauthSessionId(result.sessionId);
      setOauthBindingRevision(result.bindingRevision);
      setAuthorizationUrl(result.authorizationUrl);
      window.open(result.authorizationUrl, "_blank", "noopener,noreferrer");
    } catch (cause) { setError(`Start OAuth failed (${safeProviderOperationCode(cause, "cliproxy_oauth_start_failed")}).`); }
  }

  async function submitOAuthCallbackUrl() {
    const value = callbackUrl.trim();
    setCallbackUrl(""); setError("");
    if (!value) return;
    try { await oauthCallbackMutation.mutateAsync(value); }
    catch (cause) { setError(`OAuth callback failed (${safeProviderOperationCode(cause, "cliproxy_oauth_callback_failed")}).`); }
  }

  async function toggleStatus() {
    setError("");
    try {
      await updateMutation.mutateAsync({
        id: provider.id,
        name: provider.name,
        scopeRef: provider.scopeRef,
        kind: provider.kind,
        authMethod: binding?.authMethod,
        status: provider.status === "enabled" ? "disabled" : "enabled",
        config: JSON.parse(provider.configJson || "{}") as Record<string, unknown>
      });
      router.refresh(); setOpen(false);
    } catch (cause) { setError(errorMessage(cause, "Update Provider status failed")); }
  }
}

function errorMessage(cause: unknown, fallback: string): string {
  return `${fallback} (${safeProviderOperationCode(cause, "cliproxy_provider_operation_failed")}).`;
}

function isMissingCredentialCode(code: string | null | undefined): boolean {
  return code === "cliproxy_credential_not_found" || code === "cliproxy_provider_credentials_not_found";
}

function parseProviderConfig(value: string): { baseUrl: string; models: ProviderModelMapping[] } {
  try {
    const parsed = JSON.parse(value || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { baseUrl: "", models: [] };
    const record = parsed as Record<string, unknown>;
    const models = Array.isArray(record.models) ? record.models.filter((item): item is ProviderModelMapping => Boolean(item && typeof item === "object" && typeof (item as Record<string, unknown>).name === "string" && typeof (item as Record<string, unknown>).alias === "string")).map((item) => ({ name: item.name, alias: item.alias })) : [];
    return { baseUrl: typeof record.baseUrl === "string" ? record.baseUrl : "", models };
  } catch {
    return { baseUrl: "", models: [] };
  }
}
