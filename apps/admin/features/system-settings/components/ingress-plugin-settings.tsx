"use client";

import { useState } from "react";
import { useRouter } from "@admin/navigation";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@frely/ui/components/button";
import { Card } from "@frely/ui/components/card";
import { Checkbox } from "@frely/ui/components/checkbox";
import { StatusBadge } from "../../../pages/owner/_components/ui";
import { updateIngressPluginSetting } from "../api/ingress-plugin-api";
import type { IngressPluginConfigField, IngressPluginSettingView } from "../types";

export function IngressPluginSettings({ initialPlugins }: { initialPlugins: readonly IngressPluginSettingView[] }) {
  if (initialPlugins.length === 0) return null;
  return <section className="stack-md" aria-labelledby="ingress-plugins-heading">
    <div>
      <h2 id="ingress-plugins-heading">Ingress Plugins</h2>
      <p className="muted">Built-in request transforms. Global changes apply to the next Gateway request.</p>
    </div>
    {initialPlugins.map((plugin) => <IngressPluginCard key={plugin.id} initialPlugin={plugin} />)}
  </section>;
}

function IngressPluginCard({ initialPlugin }: { initialPlugin: IngressPluginSettingView }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initialPlugin.enabled);
  const [config, setConfig] = useState(initialPlugin.config);
  const mutation = useMutation({
    mutationFn: updateIngressPluginSetting,
    retry: false,
    onSuccess: (saved) => {
      setEnabled(saved.enabled);
      setConfig(saved.config);
      router.refresh();
    }
  });
  const displayed = mutation.data ?? initialPlugin;

  return <Card className="panel">
    <div className="panel-heading">
      <div>
        <div className="heading-actions">
          <h3>{initialPlugin.id}</h3>
          <StatusBadge tone="neutral">v{initialPlugin.version}</StatusBadge>
          <StatusBadge tone={enabled ? "warn" : "neutral"}>{enabled ? "Enabled" : "Disabled"}</StatusBadge>
        </div>
        <p className="muted">{initialPlugin.desc}</p>
      </div>
    </div>

    <div className="stack-md">
      <label className="toggle-row">
        <Checkbox checked={enabled} disabled={mutation.isPending} onCheckedChange={(checked) => setEnabled(checked === true)} />
        Enabled globally
      </label>
      {initialPlugin.configUi.map((field) => <MultiSelectField key={field.key} field={field} value={config[field.key]} disabled={mutation.isPending} onChange={(value) => setConfig((current) => ({ ...current, [field.key]: value }))} />)}
      <div className="heading-actions">
        <Button type="button" disabled={mutation.isPending} onClick={() => mutation.mutate({ pluginId: initialPlugin.id, enabled, config })}>
          {mutation.isPending ? "Saving..." : "Save plugin"}
        </Button>
        <span className="muted">Last updated: {displayed.updatedAt ? new Date(displayed.updatedAt).toLocaleString() : "Never"}{displayed.updatedBy ? ` by ${displayed.updatedBy}` : ""}</span>
        {mutation.isSuccess ? <span className="muted">Saved</span> : null}
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
    <div className="heading-actions">
      {field.options.map((option) => <label className="toggle-row" key={option.value}>
        <Checkbox checked={selected.includes(option.value)} onCheckedChange={(checked) => onChange(checked === true ? [...selected, option.value] : selected.filter((item) => item !== option.value))} />
        {option.label}
      </label>)}
    </div>
  </fieldset>;
}
