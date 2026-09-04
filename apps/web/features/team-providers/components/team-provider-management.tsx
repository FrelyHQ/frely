"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "@web/navigation";
import { Button } from "@frely/ui/components/button";
import { Card } from "@frely/ui/components/card";
import { Input } from "@frely/ui/components/input";
import { MaterialTable } from "@frely/console-ui/material-table";
import {
  appendTeamProviderModelCost,
  clearTeamProviderCredential,
  createTeamProvider,
  disableTeamProvider,
  enableTeamProvider,
  fetchTeamProviderOAuthStatus,
  reconcileVisibleTeamProviderBindings,
  retireTeamProvider,
  saveTeamProviderCredential,
  startTeamProviderOAuth,
  submitTeamProviderOAuthCallback,
  syncTeamProviderModels,
  updateTeamProviderModel
} from "../api/team-provider-api";

interface ProviderRow {
  id: string;
  name: string;
  kind: string;
  status: string;
  authMethod: string | null;
  credentialPreview: string | null;
  bindingStatus: string | null;
  bindingRevision: number | null;
  bindingUpdatedAt: string | null;
  modelCount: number;
  modelNames: string[];
  models?: Array<{
    id: string;
    providerModelName: string;
    displayName: string;
    status: string;
  }>;
}

export function TeamProviderManagement(props: {
  teamId: string;
  entitlementState: string;
  canManage: boolean;
  providers: ProviderRow[];
  pagination?: ReactNode;
  modelPagination?: ReactNode;
}) {
  const router = useRouter();
  const refreshAttempt = useRef("");
  const [error, setError] = useState("");
  const [createAuthMethod, setCreateAuthMethod] = useState<"api-key" | "oauth">("api-key");
  const [oauthSessions, setOauthSessions] = useState<Record<string, { sessionId: string; bindingRevision: number; status: string }>>({});
  const bindingRefresh = useMutation({
    mutationFn: (items: Array<{ providerId: string; expectedRevision: number }>) => reconcileVisibleTeamProviderBindings(props.teamId, items),
    retry: false,
    onMutate: () => setError(""),
    onSuccess: (result) => {
      const issues = result.items.filter((item) => !["ready", "skipped"].includes(item.result));
      if (issues.length > 0) setError(`${issues.length} Provider binding${issues.length === 1 ? " needs" : "s need"} attention after refresh.`);
      router.refresh();
    },
    onError: () => setError("Provider status refresh failed. Retry an individual Provider after checking its credential."),
  });
  const mutation = useMutation({
    mutationFn: (action: () => Promise<unknown>) => action(),
    retry: false,
    onMutate: () => setError(""),
    onSuccess: () => router.refresh(),
    onError: (reason) => setError(reason instanceof Error ? reason.message : "Team Provider operation failed")
  });
  const active = props.entitlementState === "active" || props.entitlementState === "permanent";
  useEffect(() => {
    if (!props.canManage || !active) return;
    const staleBefore = Date.now() - 60_000;
    const items = props.providers.flatMap((provider) => provider.credentialPreview && provider.bindingRevision !== null && provider.bindingUpdatedAt !== null && Date.parse(provider.bindingUpdatedAt) <= staleBefore
      ? [{ providerId: provider.id, expectedRevision: provider.bindingRevision }]
      : []);
    const signature = items.map((item) => `${item.providerId}:${item.expectedRevision}`).join("|");
    if (!signature || refreshAttempt.current === signature) return;
    refreshAttempt.current = signature;
    bindingRefresh.mutate(items);
  }, [active, bindingRefresh.mutate, props.canManage, props.providers]);

  function submitCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    mutation.mutate(() => createTeamProvider(props.teamId, {
      name: String(data.get("name") ?? ""),
      kind: createAuthMethod === "api-key" ? "openai-compatible" : String(data.get("kind") ?? "codex"),
      authMethod: createAuthMethod,
      ...(createAuthMethod === "api-key" ? {
        baseUrl: String(data.get("baseUrl") ?? ""),
        model: String(data.get("model") ?? "")
      } : {})
    }));
  }

  function submitCredential(event: FormEvent<HTMLFormElement>, providerId: string) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    mutation.mutate(() => saveTeamProviderCredential(props.teamId, providerId, String(data.get("apiKey") ?? "")));
  }

  function submitCost(event: FormEvent<HTMLFormElement>, providerId: string) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    mutation.mutate(() => appendTeamProviderModelCost(props.teamId, {
      providerId,
      providerModelName: String(data.get("providerModelName") ?? ""),
      inputPer1M: Number(data.get("inputPer1M")),
      cachedInputPer1M: Number(data.get("cachedInputPer1M")),
      outputPer1M: Number(data.get("outputPer1M"))
    }));
  }

  async function startOAuth(providerId: string) {
    const result = await mutation.mutateAsync(() => startTeamProviderOAuth(props.teamId, providerId)) as {
      sessionId: string;
      authorizationUrl: string;
      bindingRevision: number;
    };
    setOauthSessions((current) => ({ ...current, [providerId]: { sessionId: result.sessionId, bindingRevision: result.bindingRevision, status: "pending" } }));
    window.open(result.authorizationUrl, "_blank", "noopener,noreferrer");
  }

  async function submitOAuth(event: FormEvent<HTMLFormElement>, providerId: string) {
    event.preventDefault();
    const session = oauthSessions[providerId];
    if (!session) return;
    const data = new FormData(event.currentTarget);
    await mutation.mutateAsync(() => submitTeamProviderOAuthCallback(
      props.teamId, providerId, session.sessionId, String(data.get("callbackUrl") ?? "")
    ));
    setOauthSessions((current) => ({ ...current, [providerId]: { ...session, status: "callback submitted" } }));
  }

  async function refreshOAuth(providerId: string) {
    const session = oauthSessions[providerId];
    if (!session) return;
    const result = await mutation.mutateAsync(() => fetchTeamProviderOAuthStatus(props.teamId, providerId, session.sessionId, session.bindingRevision)) as {
      status: string;
      errorCode?: string | null;
    };
    setOauthSessions((current) => ({
      ...current,
      [providerId]: { ...session, status: result.errorCode ? `${result.status}: ${result.errorCode}` : result.status }
    }));
  }

  return <Card className="panel">
    <div className="panel-heading"><div><h2>Custom Providers</h2><p className="muted">Entitlement: {props.entitlementState}. Provider models are paged independently. Expired Teams can still disable, clear credentials, and retire Providers.</p></div></div>
    {props.canManage && active ? <form className="form-grid" onSubmit={submitCreate}>
      <div className="button-row">
        <Button type="button" size="sm" variant={createAuthMethod === "api-key" ? "default" : "secondary"} onClick={() => setCreateAuthMethod("api-key")}>API key Provider</Button>
        <Button type="button" size="sm" variant={createAuthMethod === "oauth" ? "default" : "secondary"} onClick={() => setCreateAuthMethod("oauth")}>OAuth Provider</Button>
      </div>
      <label>Name<Input name="name" required maxLength={120} /></label>
      {createAuthMethod === "api-key" ? <>
        <label>OpenAI-compatible base URL<Input name="baseUrl" type="url" required /></label>
        <label>Initial model<Input name="model" required /></label>
      </> : <label>CPA Provider kind<Input name="kind" required defaultValue="codex" /></label>}
      <div className="form-footer"><Button type="submit" disabled={mutation.isPending}>Create Provider</Button></div>
    </form> : null}
    <MaterialTable
      columns={[{ header: "Provider" }, { header: "Credential" }, { header: "Models" }, { header: "Actions" }]}
      rows={props.providers.map((provider) => ({ id: provider.id, cells: [
        <span key="provider"><strong>{provider.name}</strong><br /><code>{provider.id}</code><br />{provider.status}</span>,
        provider.credentialPreview ?? provider.bindingStatus ?? "Not configured",
        <span key="models">{provider.modelCount}<br />
          {(provider.models ?? []).length ? (provider.models ?? []).map((model) => <span className="button-row" key={model.id}>
            <span>{model.providerModelName} ({model.status})</span>
            {props.canManage && active ? <Button type="button" size="sm" variant="secondary" disabled={mutation.isPending} onClick={() => mutation.mutate(() => updateTeamProviderModel(props.teamId, provider.id, model.providerModelName, model.status === "enabled" ? "disabled" : "enabled"))}>{model.status === "enabled" ? "Disable model" : "Enable model"}</Button> : null}
          </span>) : provider.modelCount > 0 ? "No models on this page" : "Not synced"}
        </span>,
        props.canManage ? <div key="actions" className="button-row">
          {active ? <form onSubmit={(event) => submitCredential(event, provider.id)}><Input name="apiKey" type="password" required minLength={8} placeholder="API key" /><Button type="submit" size="sm" disabled={mutation.isPending}>Save key</Button></form> : null}
          {active && provider.authMethod === "oauth" ? <>
            <Button type="button" size="sm" disabled={mutation.isPending} onClick={() => void startOAuth(provider.id)}>Start OAuth</Button>
            {oauthSessions[provider.id] ? <form onSubmit={(event) => void submitOAuth(event, provider.id)}>
              <Input name="callbackUrl" type="url" required placeholder="Final localhost callback URL" />
              <Button type="submit" size="sm" variant="secondary" disabled={mutation.isPending}>Submit callback</Button>
              <Button type="button" size="sm" variant="secondary" disabled={mutation.isPending} onClick={() => void refreshOAuth(provider.id)}>Check status</Button>
              <span>{oauthSessions[provider.id]?.status}</span>
            </form> : null}
          </> : null}
          {active ? <Button type="button" size="sm" variant="secondary" disabled={mutation.isPending} onClick={() => mutation.mutate(() => syncTeamProviderModels(props.teamId, provider.id))}>Sync models</Button> : null}
          {active && provider.modelNames.length ? <form onSubmit={(event) => submitCost(event, provider.id)}>
            <label>Model<Input name="providerModelName" required defaultValue={provider.modelNames[0]} /></label>
            <Input name="inputPer1M" type="number" min="0" step="any" required placeholder="Input / 1M" />
            <Input name="cachedInputPer1M" type="number" min="0" step="any" required placeholder="Cached / 1M" />
            <Input name="outputPer1M" type="number" min="0" step="any" required placeholder="Output / 1M" />
            <Button type="submit" size="sm" variant="secondary" disabled={mutation.isPending}>Append cost</Button>
          </form> : null}
          {active && provider.status === "disabled" && provider.bindingStatus === "ready" && (provider.models ?? []).some((model) => model.status === "enabled")
            ? <Button type="button" size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate(() => enableTeamProvider(props.teamId, provider.id))}>Enable</Button>
            : null}
          {provider.status !== "disabled" ? <Button type="button" size="sm" variant="secondary" disabled={mutation.isPending} onClick={() => mutation.mutate(() => disableTeamProvider(props.teamId, provider.id))}>Disable</Button> : null}
          {provider.credentialPreview ? <Button type="button" size="sm" variant="destructive" disabled={mutation.isPending} onClick={() => mutation.mutate(() => clearTeamProviderCredential(props.teamId, provider.id))}>Clear key</Button> : null}
          {provider.status === "disabled" && !provider.credentialPreview ? <Button type="button" size="sm" variant="destructive" disabled={mutation.isPending} onClick={() => mutation.mutate(() => retireTeamProvider(props.teamId, provider.id))}>Retire</Button> : null}
        </div> : "Read only"
      ] }))}
      emptyState={{ title: "No Team Providers." }}
      table={{ density: "compact" }}
    />
    {props.pagination}
    {props.modelPagination}
    {error ? <div className="notice-box notice-bad" role="alert">{error}</div> : null}
  </Card>;
}
