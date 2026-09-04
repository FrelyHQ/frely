"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { SearchSelect, type SearchSelectOption } from "@frely/console-ui/search-select";
import { Badge } from "@frely/ui/components/badge";
import { Button } from "@frely/ui/components/button";
import { Card } from "@frely/ui/components/card";
import { Textarea } from "@frely/ui/components/textarea";
import { useForm, useStore } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { executeUserApiTest } from "../api/api-test-api";
import { apiTestDefaults, formatJson, parseRequestParams, toApiTestCommand, updateRequestModel } from "../form/api-test-values";
import { buildCurlCommand } from "../lib/curl-command";
import type { ModelOption } from "../types";

export function UserApiTest({ models }: { models: ModelOption[] }) {
  const [origin, setOrigin] = useState("");
  const abortController = useRef<AbortController | null>(null);
  const availableModels = useMemo(() => new Set(models.map((item) => item.model)), [models]);
  const modelOptions = useMemo<SearchSelectOption[]>(() => models.map((item) => ({
    value: item.model,
    label: item.model,
    ...(item.description ? { description: item.description } : {}),
    metadata: `${item.description ? "" : "— · "}${item.label} / ${item.apiFamily}`,
    searchText: `${item.label} ${item.apiFamily}`
  })), [models]);
  const form = useForm({ defaultValues: apiTestDefaults(models[0]?.model) });
  const values = useStore(form.store, (state) => state.values);
  const mutation = useMutation({ mutationFn: executeUserApiTest, retry: false, gcTime: 0, onSettled: () => { abortController.current = null; } });
  const hasModels = models.length > 0;
  const selectedModel = availableModels.has(values.model.trim());
  const validRequestParams = parseRequestParams(values.requestParams).ok;
  const curlCommand = useMemo(() => buildCurlCommand(origin, values.requestParams), [origin, values.requestParams]);
  useEffect(() => setOrigin(window.location.origin), []);

  function submit() {
    const controller = new AbortController();
    abortController.current = controller;
    mutation.reset();
    mutation.mutate(toApiTestCommand(values, availableModels, controller.signal));
  }
  const execution = mutation.data;
  const result = execution?.result ?? null;
  const error = execution?.errorMessage ?? (mutation.error instanceof Error ? (mutation.error.name === "AbortError" ? "Request cancelled" : mutation.error.message) : null);

  return <section className="api-test-grid">
    <Card className="panel api-test-panel"><div className="panel-heading"><div><h2>Relay Request</h2><p className="muted">Send a real OpenAI-compatible chat completion request with your own enabled API key.</p></div></div><div className="form-grid single">
      <form.Field name="model">{(field) => <label>Request Model<SearchSelect value={field.state.value} options={modelOptions} onValueChange={(model) => { field.handleChange(model); form.setFieldValue("requestParams", (current) => updateRequestModel(current, model)); }} placeholder={hasModels ? "Search available models" : "No available models"} disabled={mutation.isPending || !hasModels} /><span>{hasModels ? "Search user-available models, then select one to send a real relay request." : "No user-available models are currently visible for this account."}</span></label>}</form.Field>
      <form.Field name="requestParams" validators={{ onBlur: ({ value }) => { const parsed = parseRequestParams(value); return parsed.ok ? undefined : parsed.message; } }}>{(field) => <label>Request Parameters<Textarea value={field.state.value} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value)} rows={11} spellCheck={false} disabled={mutation.isPending || !hasModels} /><span>Editable JSON body sent as an OpenAI-compatible chat completions request.</span>{field.state.meta.errors.map((item) => <span className="field-error" key={String(item)}>{String(item)}</span>)}</label>}</form.Field>
      <div className="row-actions"><Button className="w-full" type="button" onClick={submit} disabled={mutation.isPending || !hasModels || !selectedModel || !validRequestParams}>{mutation.isPending ? "Sending Request" : "Send LLM Request"}</Button>{mutation.isPending ? <Button type="button" variant="secondary" onClick={() => abortController.current?.abort()}>Cancel</Button> : null}</div>
    </div>{error ? <div className="notice-box notice-bad" role="alert" data-clarity-mask="true">{error}</div> : null}</Card>
    <Card className="panel api-test-panel"><div className="panel-heading"><div><h2>Response</h2><p className="muted">The request is sent through the Gateway path and writes normal usage facts.</p></div>{result ? <Badge variant={result.ok ? "good" : "bad"}>{result.status}</Badge> : <Badge variant="neutral">Idle</Badge>}</div>{result ? <><div className="access-summary"><div><strong>Status</strong><span data-clarity-mask="true">{result.status}</span></div><div><strong>Elapsed</strong><span data-clarity-mask="true">{result.elapsedMs}ms</span></div><div><strong>Request ID</strong><span data-clarity-mask="true">{result.requestId ?? "n/a"}</span></div><div><strong>Result</strong><span data-clarity-mask="true">{result.ok ? "OK" : "Failed"}</span></div></div><pre className="json-block" data-clarity-mask="true">{formatJson(result.body)}</pre></> : <div className="empty-state">Send a request to verify the API key, access resolution, provider call, and usage deduction.</div>}</Card>
    <Card className="panel api-test-logs"><div className="curl-command-section"><div className="curl-command-heading"><div><h2>curl Command</h2><p className="muted">Uses the current Web session cookie; no raw API key is exposed here.</p></div></div><Textarea className="code-textarea" value={curlCommand} readOnly rows={8} spellCheck={false} /></div>{execution?.rawResponse ? <div className="api-test-raw"><h2>Raw Response</h2><pre data-clarity-mask="true">{execution.rawResponse}</pre></div> : null}</Card>
  </section>;
}
