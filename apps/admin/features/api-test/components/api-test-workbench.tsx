"use client";

import React, { useMemo, useState } from "react";
import Link from "@admin/navigation";
import { Badge } from "@frely/ui/components/badge";
import { Button } from "@frely/ui/components/button";
import { Card } from "@frely/ui/components/card";
import { Input } from "@frely/ui/components/input";
import { Textarea } from "@frely/ui/components/textarea";
import { Tooltip } from "@frely/ui/components/tooltip";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery } from "@tanstack/react-query";
import { executeApiTest, fetchSavedApiTestCurl } from "../api/api-test-api";
import { fetchApiKeyCandidates } from "../../api-keys/api/api-key-api";
import { fetchAccessPointCandidates } from "../../access-points/api/access-point-api";
import { activeApiTestPayload, apiTestFormDefaults, hasExecutableApiTestIdentity, payloadDraftsWithModel, toApiTestRequest, validateApiTestIdentity, validateApiTestPayloadDraft, validateRequired } from "../form/api-test-form-values";
import { API_TEST_TYPES, apiTestProtocol, isApiTestType } from "../lib/api-test-protocols";
import { curlCommand, responseErrorExplanation, responseErrorFields } from "../lib/api-test-presenters";
import { apiTestInputsQueryOptions } from "../query/api-test-query";
import type { ApiTestAccessPoint, ApiTestFormValues, ApiTestKey, ApiTestResult } from "../types";
import { SearchSelect, type SearchSelectOption } from "../../../pages/owner/_components/search-select";
import { AccessPointDescription } from "@frely/console-ui/access-point-description";

export function ApiTestWorkbench() {
  const inputsQuery = useQuery(apiTestInputsQueryOptions);
  if (inputsQuery.isPending) return <Card className="panel"><p className="muted">Loading API keys and AccessPoints...</p></Card>;
  if (inputsQuery.error) return <Card className="panel"><div className="notice-box notice-bad">{inputsQuery.error instanceof Error ? inputsQuery.error.message : "Load API test inputs failed"}</div><Button type="button" variant="secondary" onClick={() => void inputsQuery.refetch()}>Retry</Button></Card>;
  return <ApiTestForm apiKeys={[]} accessPoints={[]} refreshing={inputsQuery.isFetching} refresh={() => void inputsQuery.refetch()} />;
}

export function ApiTestForm({ apiKeys, accessPoints, refreshing, refresh }: { apiKeys: ApiTestKey[]; accessPoints: ApiTestAccessPoint[]; refreshing: boolean; refresh: () => void }) {
  const [copied, setCopied] = useState<"ok" | "failed" | null>(null);
  const [apiKeySearch, setApiKeySearch] = useState("");
  const [apiKeyPage, setApiKeyPage] = useState(1);
  const [selectedApiKey, setSelectedApiKey] = useState<ApiTestKey | null>(null);
  const [accessPointSearch, setAccessPointSearch] = useState("");
  const [accessPointPage, setAccessPointPage] = useState(1);
  const [selectedAccessPoint, setSelectedAccessPoint] = useState<ApiTestAccessPoint | null>(null);
  const mutation = useMutation({ mutationFn: executeApiTest, retry: false, gcTime: 0 });
  const copyMutation = useMutation({
    mutationFn: async (values: ApiTestFormValues) => {
      const request = toApiTestRequest(values);
      const command = values.apiKey.trim()
        ? curlCommand(values.apiType, values.gatewayBaseUrl, values.apiKey, activeApiTestPayload(values))
        : await fetchSavedApiTestCurl({
          gatewayBaseUrl: values.gatewayBaseUrl.trim(),
          apiType: request.apiType,
          accessPointId: request.accessPointId,
          apiKeyId: request.apiKeyId ?? "",
          payload: request.payload
        });
      await navigator.clipboard.writeText(command);
    },
    retry: false,
    gcTime: 0,
    onSuccess: () => showCopyState("ok"),
    onError: () => showCopyState("failed")
  });
  const defaultApiKeyId = apiKeys[0]?.id;
  const form = useForm({ defaultValues: apiTestFormDefaults(defaultApiKeyId, accessPoints[0]?.id, accessPoints[0]?.exposedModel), onSubmit: ({ value }) => mutation.mutateAsync(toApiTestRequest(value)) });
  const accessPointCandidates = useQuery({ queryKey: ["api-test", "access-point-candidates", accessPointSearch, accessPointPage], queryFn: ({ signal }) => fetchAccessPointCandidates(accessPointSearch, accessPointPage, signal), enabled: accessPoints.length === 0, staleTime: 15_000, retry: false });
  const remoteAccessPoints: ApiTestAccessPoint[] = (accessPointCandidates.data?.items ?? []).map((point) => ({ ...point, targetModel: point.exposedModel, targetType: "provider-model", targetId: null, targetProviderModelName: null }));
  const availableAccessPoints = selectedAccessPoint && !remoteAccessPoints.some((point) => point.id === selectedAccessPoint.id) ? [selectedAccessPoint, ...accessPoints, ...remoteAccessPoints] : [...accessPoints, ...remoteAccessPoints];
  const accessPointOptions = useMemo<SearchSelectOption[]>(() => availableAccessPoints.map((point) => ({
    value: point.id,
    label: point.name,
    ...(point.description ? { description: point.description } : {}),
    metadata: `${point.description ? "" : "— · "}request model: ${point.exposedModel}`,
    searchText: `${point.id} ${point.exposedModel}`
  })), [availableAccessPoints]);
  const candidates = useQuery({ queryKey: ["api-test", "api-key-candidates", apiKeySearch, apiKeyPage], queryFn: ({ signal }) => fetchApiKeyCandidates(apiKeySearch, apiKeyPage, signal), enabled: apiKeys.length === 0, staleTime: 15_000, retry: false });
  const remoteApiKeys: ApiTestKey[] = (candidates.data?.items ?? []).map((key) => ({ ...key, teamId: "" }));
  const availableApiKeys = selectedApiKey && !remoteApiKeys.some((key) => key.id === selectedApiKey.id) ? [selectedApiKey, ...apiKeys, ...remoteApiKeys] : [...apiKeys, ...remoteApiKeys];
  const apiKeyOptions = useMemo<SearchSelectOption[]>(() => availableApiKeys.map((key) => ({
    value: key.id,
    label: `${key.name} (${key.keyPrefix})`,
    description: `user:${key.userId} / team:${key.teamId}`,
    searchText: `${key.id} ${key.name} ${key.keyPrefix} ${key.userId} ${key.teamId}`
  })), [availableApiKeys]);
  const apiTypeOptions = useMemo<SearchSelectOption[]>(() => API_TEST_TYPES.map((type) => {
    const protocol = apiTestProtocol(type);
    return { value: type, label: protocol.label, description: `${protocol.requestPath} · ${protocol.description}` };
  }), []);

  return <form onSubmit={(event) => { event.preventDefault(); void form.handleSubmit(); }}>
    <section className="api-test-grid">
      <Card className="panel api-test-panel">
        <div className="panel-heading"><div><h2>Relay Request</h2><p className="muted">Send a real Chat Completions, Responses, or Messages request through friday-relay.</p></div><Button type="button" variant="secondary" onClick={refresh} disabled={refreshing || mutation.isPending}>Refresh Keys</Button></div>
        <div className="form-grid single">
          <form.Field name="gatewayBaseUrl" validators={{ onSubmit: ({ value }) => validateRequired(value, "Gateway Base URL") }}>{(field) => <label>Gateway Base URL<Input value={field.state.value} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value)} disabled={mutation.isPending} /><span>Used only for the copied curl command. In-page execution uses the deployment's fixed internal Gateway.</span>{errors(field.state.meta.errors)}</label>}</form.Field>
          <form.Field name="apiType">{(field) => <label>API Type<SearchSelect value={field.state.value} options={apiTypeOptions} onBlur={field.handleBlur} onValueChange={(value) => { if (!isApiTestType(value)) return; field.handleChange(value); mutation.reset(); copyMutation.reset(); setCopied(null); }} searchable={false} ariaLabel="API Type" disabled={mutation.isPending || copyMutation.isPending} /><span>Select the public Relay API protocol to exercise.</span></label>}</form.Field>
          <form.Field name="accessPointId" validators={{ onSubmit: ({ value }) => validateRequired(value, "AccessPoint") }}>{(field) => <label>AccessPoint<SearchSelect value={field.state.value} options={accessPointOptions} onSearchChange={(query) => { setAccessPointSearch(query); setAccessPointPage(1); }} onValueChange={(id) => { field.handleChange(id); const point = availableAccessPoints.find((item) => item.id === id); setSelectedAccessPoint(point ?? null); if (point?.exposedModel) form.setFieldValue("payloadDrafts", (current) => payloadDraftsWithModel(current, point.exposedModel)); }} placeholder="Search AccessPoints" disabled={mutation.isPending} {...(accessPoints.length === 0 ? { pagination: { page: accessPointCandidates.data?.page ?? accessPointPage, totalPages: accessPointCandidates.data?.totalPages ?? accessPointPage, pending: accessPointCandidates.isPending, onPageChange: setAccessPointPage } } : {})} /><span>{accessPointCandidates.isPending ? "Loading AccessPoint candidates…" : "The selected model is tested with the API key's real Gateway visibility and Plan entitlement."}</span>{errors(field.state.meta.errors)}</label>}</form.Field>
          <form.Field name="apiKeyId" validators={{ onSubmit: ({ value, fieldApi }) => validateApiTestIdentity({ apiKeyId: value, apiKey: fieldApi.form.state.values.apiKey }, availableApiKeys) }}>{(field) => <form.Subscribe selector={(state) => state.values.apiKey}>{(manualKey) => <label>Saved API Key<SearchSelect value={field.state.value} options={apiKeyOptions} onSearchChange={(query) => { setApiKeySearch(query); setApiKeyPage(1); }} onValueChange={(value) => { field.handleChange(value); setSelectedApiKey(availableApiKeys.find((key) => key.id === value) ?? null); }} placeholder={availableApiKeys.length ? "Search saved API keys" : "Search saved API keys"} disabled={mutation.isPending || Boolean(manualKey.trim())} {...(apiKeys.length === 0 ? { pagination: { page: candidates.data?.page ?? apiKeyPage, totalPages: candidates.data?.totalPages ?? apiKeyPage, pending: candidates.isPending, onPageChange: setApiKeyPage } } : {})} /><span>{candidates.isPending ? "Loading API key candidates…" : "Its private value is used server-side for the real Gateway request and an explicit curl copy."}</span>{errors(field.state.meta.errors)}</label>}</form.Subscribe>}</form.Field>
          <form.Field name="apiKey">{(field) => <label>Manual API Key<Input value={field.state.value} onBlur={field.handleBlur} onChange={(event) => { const value = event.target.value; field.handleChange(value); if (value.trim()) form.setFieldValue("apiKeyId", ""); }} placeholder="fr_..." disabled={mutation.isPending} type="password" /><span>The value stays masked and is used only for execution or an explicit curl copy.</span></label>}</form.Field>
          <form.Subscribe selector={(state) => state.values.apiType}>{(apiType) => {
            const protocol = apiTestProtocol(apiType);
            const payloadField = `payloadDrafts.${apiType}` as "payloadDrafts.chat" | "payloadDrafts.responses" | "payloadDrafts.messages";
            return <form.Field name={payloadField} validators={{ onSubmit: ({ value }) => validateApiTestPayloadDraft(apiType, value) }}>{(field) => <label>{protocol.payloadLabel}<Textarea value={field.state.value} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value)} disabled={mutation.isPending} rows={11} /><span>In-page execution is non-streaming; use the copied curl command for direct endpoint testing.</span>{errors(field.state.meta.errors)}</label>}</form.Field>;
          }}</form.Subscribe>
          <form.Subscribe selector={(state) => ({ canSubmit: state.canSubmit, isSubmitting: state.isSubmitting, apiKey: state.values.apiKey, apiKeyId: state.values.apiKeyId })}>{(state) => <Button className="w-full" type="submit" disabled={!state.canSubmit || !hasExecutableApiTestIdentity(state, availableApiKeys) || state.isSubmitting || mutation.isPending || availableAccessPoints.length === 0}>{mutation.isPending ? "Sending Request" : "Send LLM Request"}</Button>}</form.Subscribe>
        </div>
        <form.Subscribe selector={(state) => ({ accessPointId: state.values.accessPointId, apiKeyId: state.values.apiKeyId, manualIdentity: Boolean(state.values.apiKey.trim()) })}>{(values) => <SelectionCards accessPoint={availableAccessPoints.find((point) => point.id === values.accessPointId)} apiKey={availableApiKeys.find((key) => key.id === values.apiKeyId)} manualIdentity={values.manualIdentity} />}</form.Subscribe>
        {mutation.error ? <div className="alert-box">{mutation.error instanceof Error ? mutation.error.message : "API test failed"}</div> : null}
      </Card>
      <ResponsePanel result={mutation.data} />
      <Card className="panel api-test-logs"><form.Subscribe selector={(state) => state.values}>{(values) => { const preview = curlCommand(values.apiType, values.gatewayBaseUrl, "", activeApiTestPayload(values)); const hasIdentity = hasExecutableApiTestIdentity(values, availableApiKeys); return <div className="curl-command-section"><div className="curl-command-heading"><div><h2>curl Command</h2><p className="muted">The preview always redacts the key. Copy injects the selected saved key or the masked Manual API Key so the command is immediately usable.</p></div><Tooltip content="Copy curl command with the selected API key"><Button className="copy-key-button" type="button" variant="secondary" disabled={!hasIdentity || copyMutation.isPending} onClick={() => copyMutation.mutate(values)}>{copyMutation.isPending ? "Copying..." : copied === "failed" ? "Copy failed" : copied === "ok" ? "Copied" : "Copy curl command"}</Button></Tooltip></div><pre className="json-block">{preview}</pre>{copyMutation.error ? <div className="notice-box notice-bad" role="alert">{copyMutation.error instanceof Error ? copyMutation.error.message : "Copy curl command failed"}</div> : null}</div>; }}</form.Subscribe></Card>
    </section>
  </form>;

  function showCopyState(state: "ok" | "failed") { setCopied(state); window.setTimeout(() => setCopied(null), 1500); }
}

function errors(values: unknown[]) { return values.map((error) => <span className="field-error" key={String(error)}>{String(error)}</span>); }
function SelectionCards({ accessPoint, apiKey, manualIdentity }: { accessPoint: ApiTestAccessPoint | undefined; apiKey: ApiTestKey | undefined; manualIdentity: boolean }) { return <><div className="request-point-card"><strong>{accessPoint?.name ?? "No AccessPoint selected"}</strong><AccessPointDescription description={accessPoint?.description} /><span>{accessPoint?.exposedModel ? `request model: ${accessPoint.exposedModel}` : "No request model selected."}</span><code>{accessPoint?.id ?? "n/a"}</code></div><div className="request-point-card"><strong>{manualIdentity ? "Manual API Key" : apiKey?.name ?? "No saved key selected"}</strong><span>{manualIdentity ? "The pasted key is the only identity used for this request." : apiKey ? `user:${apiKey.userId} / team:${apiKey.teamId}` : "Paste a manual API key or select an available saved key."}</span><code>{manualIdentity ? "manual" : apiKey?.keyPrefix ?? "n/a"}</code></div></>; }
function ResponsePanel({ result }: { result: ApiTestResult | undefined }) { return <Card className="panel api-test-panel"><div className="panel-heading"><div><h2>Response</h2><p className="muted">The request is sent to the relay gateway and forwarded to the resolved provider.</p></div>{result ? <Badge variant={result.ok ? "good" : "bad"}>{result.status}</Badge> : <Badge variant="neutral">Idle</Badge>}</div>{result ? <>{!result.ok ? <div className="notice-box notice-bad" role="alert"><strong>Reason</strong><p>{responseErrorExplanation(result)}</p><div className="api-test-error-meta"><span><strong>Code</strong> {responseErrorFields(result).code || "n/a"}</span><span><strong>Message</strong> {responseErrorFields(result).message || "n/a"}</span></div></div> : null}<div className="access-summary"><div><strong>Status</strong><span>{result.status}</span></div><div><strong>Elapsed</strong><span>{result.elapsedMs}ms</span></div><div><strong>Request ID</strong>{result.requestId ? <Link href={`/owner/request-logs#${encodeURIComponent(result.requestId)}`}><code>{result.requestId}</code></Link> : <span>n/a</span>}</div><div><strong>Result</strong><span>{result.ok ? "OK" : "Failed"}</span></div></div><pre className="json-block">{JSON.stringify(result.body, null, 2)}</pre></> : <div className="empty-state">Send a request to verify the API key, relay gateway, access resolution, and upstream provider.</div>}</Card>; }
