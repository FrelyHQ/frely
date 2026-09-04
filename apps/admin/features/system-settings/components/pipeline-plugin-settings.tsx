"use client";

import { useState } from "react";
import { useRouter } from "@admin/navigation";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@frely/ui/components/button";
import { Card } from "@frely/ui/components/card";
import { Checkbox } from "@frely/ui/components/checkbox";
import { StatusBadge } from "../../../pages/owner/_components/ui";
import { updatePipelinePluginSetting } from "../api/pipeline-plugin-api";
import type { IngressPluginConfigField, PipelinePluginSettingView } from "../types";

export function PipelinePluginSettings({ initialPlugins }: { initialPlugins: readonly PipelinePluginSettingView[] }) {
  if (initialPlugins.length === 0) return null;
  return <section className="stack-md" aria-labelledby="pipeline-plugins-heading">
    <div>
      <h2 id="pipeline-plugins-heading">Pipeline Plugins</h2>
      <p className="muted">Built-in static execution plan. Phase, order, permissions, and dependencies are code-owned and read-only.</p>
    </div>
    {initialPlugins.map((plugin) => <PipelinePluginCard key={plugin.id} initialPlugin={plugin} />)}
  </section>;
}

function PipelinePluginCard({ initialPlugin }: { initialPlugin: PipelinePluginSettingView }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initialPlugin.enabled);
  const [config, setConfig] = useState(initialPlugin.config);
  const mutation = useMutation({
    mutationFn: updatePipelinePluginSetting,
    retry: false,
    onSuccess: (saved) => {
      setEnabled(saved.enabled);
      setConfig(saved.config);
      router.refresh();
    },
  });
  const displayed = mutation.data ?? initialPlugin;
  const editable = initialPlugin.userToggleable || initialPlugin.userConfigurable;

  return <Card className="panel">
    <div className="panel-heading">
      <div>
        <div className="heading-actions">
          <h3>{initialPlugin.id}</h3>
          <StatusBadge tone="neutral">API {initialPlugin.apiVersion}</StatusBadge>
          <StatusBadge tone="neutral">Behavior {initialPlugin.behaviorVersion}</StatusBadge>
          <StatusBadge tone={initialPlugin.availability === "required" ? "info" : enabled ? "warn" : "neutral"}>{initialPlugin.availability === "required" ? "Required" : enabled ? "Enabled" : "Disabled"}</StatusBadge>
        </div>
        <p className="muted">{initialPlugin.desc}</p>
        <p className="muted">Execution plan: {initialPlugin.phases.join(" → ")}</p>
      </div>
    </div>
    <div className="stack-md">
      <label className="toggle-row">
        <Checkbox checked={enabled} disabled={!initialPlugin.userToggleable || mutation.isPending} onCheckedChange={(checked) => setEnabled(checked === true)} />
        {initialPlugin.userToggleable ? "Enabled globally" : "Required by the static runtime plan"}
      </label>
      {initialPlugin.configUi.map((field) => <MultiSelectField key={field.key} field={field} value={config[field.key]} disabled={!initialPlugin.userConfigurable || mutation.isPending} onChange={(value) => setConfig((current) => ({ ...current, [field.key]: value }))} />)}
      <div className="heading-actions">
        {editable ? <Button type="button" disabled={mutation.isPending} onClick={() => mutation.mutate({ pluginId: initialPlugin.id, enabled, config })}>{mutation.isPending ? "Saving..." : "Save plugin"}</Button> : null}
        <span className="muted">Setting revision: {displayed.settingRevision ?? "built-in"}{displayed.updatedAt ? ` · ${new Date(displayed.updatedAt).toLocaleString()}` : ""}{displayed.updatedBy ? ` by ${displayed.updatedBy}` : ""}</span>
        {mutation.error ? <span className="field-error">{mutation.error instanceof Error ? mutation.error.message : "Save failed"}</span> : null}
      </div>
    </div>
  </Card>;
}

function MultiSelectField({ field, value, disabled, onChange }: { field: IngressPluginConfigField; value: unknown; disabled: boolean; onChange(value: string[]): void }) {
  const selected = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  return <fieldset disabled={disabled}>
    <legend>{field.label}{field.required ? " *" : ""}</legend>
    <p className="muted">{field.description}</p>
    <div className="heading-actions">{field.options.map((option) => <label className="toggle-row" key={option.value}>
      <Checkbox checked={selected.includes(option.value)} onCheckedChange={(checked) => onChange(checked === true ? [...selected, option.value] : selected.filter((item) => item !== option.value))} />
      {option.label}
    </label>)}</div>
  </fieldset>;
}
