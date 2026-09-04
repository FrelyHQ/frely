"use client";

import { useState } from "react";
import { Button } from "@frely/ui/components/button";
import { Card } from "@frely/ui/components/card";
import { Input } from "@frely/ui/components/input";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery } from "@tanstack/react-query";
import { PageHeading, StatusBadge } from "../../../pages/owner/_components/ui";
import { AccessPointDescription } from "@frely/console-ui/access-point-description";
import { SearchSelect } from "../../../pages/owner/_components/search-select";
import { executeAccessResolutionPreview } from "../api/access-resolution-api";
import { fetchApiKeyCandidates } from "../../api-keys/api/api-key-api";
import { fetchAccessPointCandidates, type AccessPointCandidate } from "../../access-points/api/access-point-api";
import { previewFormDefaults, toPreviewInput, validatePreviewField } from "../form/access-resolution-form-values";
import { accessResolutionInputsQueryOptions } from "../query/access-resolution-query";
import type { ApiKeyOption, ResolutionTrace } from "../types";

export function AccessResolutionPreview() {
  const inputsQuery = useQuery(accessResolutionInputsQueryOptions);
  return <>
    <PageHeading eyebrow="Tools / Access Resolution" title="Access Resolution Preview" description="Execute the AccessPoint resolution path for an API key and request model.">
      <Button type="button" variant="secondary" onClick={() => void inputsQuery.refetch()} disabled={inputsQuery.isFetching}>Refresh Inputs</Button>
    </PageHeading>
    {inputsQuery.isPending ? <Card className="panel"><p className="muted">Loading preview inputs...</p></Card> : null}
    {inputsQuery.error ? <Card className="panel"><div className="notice-box notice-bad">{inputsQuery.error instanceof Error ? inputsQuery.error.message : "Request failed"}</div></Card> : null}
    {inputsQuery.data ? <PreviewWorkbench /> : null}
  </>;
}

function PreviewWorkbench() {
  const mutation = useMutation({ mutationFn: executeAccessResolutionPreview, retry: false });
  const [apiKeySearch, setApiKeySearch] = useState("");
  const [apiKeyPage, setApiKeyPage] = useState(1);
  const [apiKeyCandidate, setApiKeyCandidate] = useState<ApiKeyOption | null>(null);
  const [accessPointSearch, setAccessPointSearch] = useState("");
  const [accessPointPage, setAccessPointPage] = useState(1);
  const [accessPointCandidate, setAccessPointCandidate] = useState<AccessPointCandidate | null>(null);
  const candidates = useQuery({ queryKey: ["access-resolution", "api-key-candidates", apiKeySearch, apiKeyPage], queryFn: ({ signal }) => fetchApiKeyCandidates(apiKeySearch, apiKeyPage, signal), staleTime: 15_000, retry: false });
  const apiKeys = apiKeyCandidate && !candidates.data?.items.some((key) => key.id === apiKeyCandidate.id) ? [apiKeyCandidate, ...(candidates.data?.items ?? [])] : candidates.data?.items ?? [];
  const accessPointCandidates = useQuery({ queryKey: ["access-resolution", "access-point-candidates", accessPointSearch, accessPointPage], queryFn: ({ signal }) => fetchAccessPointCandidates(accessPointSearch, accessPointPage, signal), staleTime: 15_000, retry: false });
  const enabledAccessPoints = (accessPointCandidates.data?.items ?? []).filter((point) => point.status === "enabled");
  const accessPoints = accessPointCandidate && !enabledAccessPoints.some((point) => point.id === accessPointCandidate.id) ? [accessPointCandidate, ...enabledAccessPoints] : enabledAccessPoints;
  const form = useForm({ defaultValues: previewFormDefaults("", ""), onSubmit: ({ value }) => mutation.mutateAsync(toPreviewInput(value)) });
  const trace = mutation.data;

  return <section className="split-grid">
    <Card className="panel simulator-panel">
      <div className="panel-heading"><div><h2>Preview Simulator</h2><p className="muted">Choose request context and inspect the resolved provider model.</p></div></div>
      <form onSubmit={(event) => { event.preventDefault(); void form.handleSubmit(); }}>
        <div className="form-grid">
          <form.Field name="apiKeyId" validators={{ onSubmit: ({ value }) => validatePreviewField(value, "API key") }}>{(field) => <label>API Key<SearchSelect value={field.state.value} onBlur={field.handleBlur} onSearchChange={(query) => { setApiKeySearch(query); setApiKeyPage(1); }} onValueChange={(value) => { field.handleChange(value); setApiKeyCandidate(apiKeys.find((key) => key.id === value) ?? null); }} disabled={mutation.isPending} options={apiKeys.map((key) => ({ value: key.id, label: key.name, description: key.keyPrefix, searchText: key.id }))} pagination={{ page: candidates.data?.page ?? apiKeyPage, totalPages: candidates.data?.totalPages ?? apiKeyPage, pending: candidates.isPending, onPageChange: setApiKeyPage }} />{candidates.isPending ? <span>Loading API key candidates…</span> : null}{field.state.meta.errors.map((error) => <span className="field-error" key={String(error)}>{String(error)}</span>)}</label>}</form.Field>
          <form.Field name="accessPointId" validators={{ onSubmit: ({ value }) => validatePreviewField(value, "AccessPoint") }}>{(field) => <label>AccessPoint<SearchSelect value={field.state.value} onBlur={field.handleBlur} onSearchChange={(query) => { setAccessPointSearch(query); setAccessPointPage(1); }} onValueChange={(value) => { field.handleChange(value); setAccessPointCandidate(accessPoints.find((point) => point.id === value) ?? null); }} disabled={mutation.isPending} options={accessPoints.map((point) => ({ value: point.id, label: point.name, ...(point.description ? { description: point.description } : {}), metadata: `${point.description ? "" : "— · "}${point.scopeRef} / ${point.exposedModel}`, searchText: point.id }))} pagination={{ page: accessPointCandidates.data?.page ?? accessPointPage, totalPages: accessPointCandidates.data?.totalPages ?? accessPointPage, pending: accessPointCandidates.isPending, onPageChange: setAccessPointPage }} />{accessPointCandidates.isPending ? <span>Loading AccessPoint candidates…</span> : null}{field.state.meta.errors.map((error) => <span className="field-error" key={String(error)}>{String(error)}</span>)}</label>}</form.Field>
          <form.Field name="reqModel" validators={{ onSubmit: ({ value }) => validatePreviewField(value, "requestedModel") }}>{(field) => <label>requestedModel<Input value={field.state.value} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value)} disabled={mutation.isPending} />{field.state.meta.errors.map((error) => <span className="field-error" key={String(error)}>{String(error)}</span>)}</label>}</form.Field>
          <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting] as const}>{([canSubmit, isSubmitting]) => <Button className="w-full" type="submit" disabled={!canSubmit || isSubmitting || mutation.isPending || apiKeys.length === 0 || accessPoints.length === 0}>{mutation.isPending ? "Executing Preview" : "Execute Preview"}</Button>}</form.Subscribe>
        </div>
      </form>
      {apiKeys.length === 0 || accessPoints.length === 0 ? <div className="notice-box notice-warn">Access Resolution Preview requires at least one enabled API key and one enabled AccessPoint.</div> : null}
      <form.Subscribe selector={(state) => state.values}>{(values) => <ResolutionSummary apiKey={apiKeys.find((key) => key.id === values.apiKeyId)} accessPoint={accessPoints.find((point) => point.id === values.accessPointId)} trace={trace} />}</form.Subscribe>
      {mutation.error ? <div className="notice-box notice-bad">{mutation.error instanceof Error ? mutation.error.message : "Preview failed"}</div> : null}
    </Card>
    <ResolutionTracePanel trace={trace} />
  </section>;
}

function ResolutionSummary({ apiKey, accessPoint, trace }: { apiKey: ApiKeyOption | undefined; accessPoint: AccessPointCandidate | undefined; trace: ResolutionTrace | undefined }) {
  return <div className="resolution-summary">
    <div><span>API key</span><code>{apiKey?.id ?? "No API key selected"}</code></div><div><span>AccessPoint</span><code>{accessPoint?.id ?? "No access point selected"}</code></div>
    <div><span>actor</span><code>{trace ? `${trace.actor.actorType}:${trace.actor.actorId}` : "Run preview"}</code></div><div><span>principal</span><code>{trace ? `${trace.principal.userId} / ${trace.principal.apiKeyId}` : "Run preview"}</code></div>
    <div><span>effective scopes</span><code>{trace ? trace.principal.effectiveScopes.join(", ") : "Run preview"}</code></div><div><span>selected scopeRef</span><code>{trace?.scopeRef ?? "Run preview"}</code></div>
    <div><span>owner</span><code>{trace?.accessPoint.ownerId ?? "Pending"}</code></div><div><span>scope</span><code>{trace?.accessPoint.scopeRef ?? "Pending"}</code></div>
    <div><span>provider</span><strong>{trace?.providerId ?? "Pending"}</strong></div><div><span>provider model</span><strong>{trace?.providerModelName ?? "Pending"}</strong></div>
    <div><span>reqModel to tarModel</span><code>{trace ? `${trace.reqModel} -> ${trace.tarModel}` : "Pending"}</code></div><div><span>credential ref</span><code>{trace?.credentialRef ?? "Pending"}</code></div>
  </div>;
}

function ResolutionTracePanel({ trace }: { trace: ResolutionTrace | undefined }) {
  const preview = trace ? {
    selectedScopeRef: trace.scopeRef,
    accessPointId: trace.accessPoint.id,
    checkedScopeRefs: trace.checkedScopeRefs,
    initialCandidateId: trace.candidateId,
    selector: {
      accessPointId: trace.candidatePlan.selectorAccessPointId,
      id: trace.candidatePlan.selectorId,
      behaviorVersion: trace.candidatePlan.selectorBehaviorVersion,
      routingRevision: trace.candidatePlan.routingRevision,
    },
    candidates: trace.candidatePlan.candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      targetEdgeId: candidate.selectorTargetEdgeId,
      pathTargetEdgeIds: candidate.pathTargetEdgeIds,
      accessPointIds: candidate.accessPointChain.map((accessPoint) => accessPoint.id),
      providerId: candidate.providerId,
      providerModelName: candidate.providerModelName,
      available: candidate.available,
      unavailableReason: candidate.unavailableReason,
    })),
  } : null;
  return <Card className="panel hierarchy-panel resolution-trace"><h2>Resolution Trace</h2><p className="muted">The preview checks API key, user, team, then global scope and follows AccessPoint targets.</p>
    {(trace?.resolutionPath ?? []).map((step, index) => <div className="hierarchy-step trace-step trace-info" key={`${step.accessPointId}-${index}`}><span>{index + 1}</span><div><div className="trace-step-title"><strong>{step.accessPointId}</strong><StatusBadge tone="info">{step.exposedModel}</StatusBadge></div><AccessPointDescription description={step.description} /><p>{step.targetType === "provider-model" ? `${step.targetModel} -> ${step.targetProviderId}:${step.targetProviderModelName}` : `${step.targetModel} -> ${step.targetType}:${step.targetId}`}</p><p>owner {step.ownerId} / scope {step.accessPointScopeRef}</p></div></div>)}
    {preview ? <pre className="json-block">{JSON.stringify(preview, null, 2)}</pre> : <div className="alert-box"><strong>No preview result</strong><p>Run the preview to load the gateway resolution trace.</p></div>}
  </Card>;
}
