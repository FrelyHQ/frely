"use client";

import { useState } from "react";

import { Badge, badgeVariants } from "@frely/ui/components/badge";
import { Tooltip } from "@frely/ui/components/tooltip";
import { cn } from "@frely/ui/lib/utils";
import { ConsoleDialog } from "./console-dialog.js";

export type PipelinePluginOutcome = "applied" | "noop" | "denied" | "failed" | "fallback";

export interface PipelinePluginChipItem {
  id: string;
  abbreviation: string;
  behaviorVersion: number;
  hook: string;
  instanceRevision?: string;
  outcome: PipelinePluginOutcome;
}

type PipelinePluginTone = "good" | "warn" | "bad" | "neutral";

export function pipelinePluginTone(outcome: PipelinePluginOutcome): PipelinePluginTone {
  if (outcome === "applied") return "good";
  if (outcome === "failed" || outcome === "denied") return "bad";
  if (outcome === "fallback") return "warn";
  return "neutral";
}

export function PipelinePluginChips({
  plugins,
  summary = false
}: {
  plugins: readonly PipelinePluginChipItem[];
  summary?: boolean;
}) {
  if (plugins.length === 0) return <span className="muted">None</span>;
  if (summary) return <PipelinePluginSummary plugins={plugins} />;

  return (
    <div className="flex flex-wrap gap-1" aria-label="Invoked pipeline plugins">
      {plugins.map((plugin, index) => (
        <Badge
          className="gap-1"
          data-outcome={plugin.outcome}
          key={`${plugin.id}:${plugin.hook}:${index}`}
          variant={pipelinePluginTone(plugin.outcome)}
        >
          <Tooltip content={plugin.id}>
            <span tabIndex={0} aria-label={`Plugin ${plugin.id}`}>{plugin.abbreviation}</span>
          </Tooltip>
          <span aria-hidden="true">·</span>
          <Tooltip content={<PluginExecutionTooltip plugin={plugin} />}>
            <span
              tabIndex={0}
              aria-label={`Behavior version ${plugin.behaviorVersion}; hook ${plugin.hook}; outcome ${plugin.outcome}`}
            >
              b{plugin.behaviorVersion}
            </span>
          </Tooltip>
        </Badge>
      ))}
    </div>
  );
}

function PipelinePluginSummary({ plugins }: { plugins: readonly PipelinePluginChipItem[] }) {
  const [open, setOpen] = useState(false);
  const visiblePlugins = plugins.slice(0, 2);
  const hiddenCount = plugins.length - visiblePlugins.length;

  return <>
    <div className="grid max-w-full gap-1" aria-label="Pipeline plugin summary">
      <div className="grid min-w-0 grid-cols-2 gap-1">
        {visiblePlugins.map((plugin, index) => (
          <button
            type="button"
            className={cn(badgeVariants({ variant: pipelinePluginTone(plugin.outcome) }), "min-w-0 cursor-pointer gap-1 px-2")}
            data-outcome={plugin.outcome}
            key={`${plugin.id}:${plugin.hook}:${index}`}
            aria-label={`View pipeline plugin chain; plugin ${plugin.id}`}
            onClick={() => setOpen(true)}
          >
            <span className="min-w-0 truncate">{plugin.abbreviation}</span>
            <span aria-hidden="true">·</span>
            <span className="shrink-0">b{plugin.behaviorVersion}</span>
          </button>
        ))}
      </div>
      {hiddenCount > 0 ? (
        <button
          type="button"
          className="w-fit cursor-pointer whitespace-nowrap text-xs font-bold leading-5 text-primary underline decoration-dotted underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
          aria-label={`View all ${plugins.length} pipeline plugins`}
          onClick={() => setOpen(true)}
        >
          +{hiddenCount} more {hiddenCount === 1 ? "plugin" : "plugins"}
        </button>
      ) : null}
    </div>
    {open ? <PipelinePluginChainDialog plugins={plugins} onClose={() => setOpen(false)} /> : null}
  </>;
}

function PipelinePluginChainDialog({ plugins, onClose }: { plugins: readonly PipelinePluginChipItem[]; onClose: () => void }) {
  return (
    <ConsoleDialog
      observabilityKey="pipeline-plugin-chain"
      titleId="pipeline-plugin-chain-dialog-title"
      eyebrow="Request History"
      title="Pipeline Plugin Chain"
      description={`${plugins.length} plugin ${plugins.length === 1 ? "invocation" : "invocations"} in execution order.`}
      onClose={onClose}
    >
      <ol className="grid gap-2" aria-label="Pipeline plugin invocation chain">
        {plugins.map((plugin, index) => (
          <li className="grid gap-2" key={`${plugin.id}:${plugin.hook}:${index}`}>
            <div className="grid gap-3 rounded border border-[var(--border)] bg-[var(--surface-low)] p-3">
              <div className="flex min-w-0 items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-2">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-[var(--primary-soft)] text-xs font-extrabold text-[var(--primary-strong)]" aria-hidden="true">{index + 1}</span>
                  <code className="min-w-0 break-all text-sm font-bold" data-testid="pipeline-plugin-chain-name">{plugin.id}</code>
                </div>
                <Badge className="shrink-0" variant={pipelinePluginTone(plugin.outcome)}>{outcomeLabel(plugin.outcome)}</Badge>
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                <div><dt className="font-bold text-[var(--muted)]">Hook</dt><dd className="break-all"><code>{plugin.hook}</code></dd></div>
                <div><dt className="font-bold text-[var(--muted)]">Behavior version</dt><dd>b{plugin.behaviorVersion}</dd></div>
                {plugin.instanceRevision ? <div className="col-span-2"><dt className="font-bold text-[var(--muted)]">Instance revision</dt><dd className="break-all"><code>{plugin.instanceRevision}</code></dd></div> : null}
              </dl>
            </div>
            {index < plugins.length - 1 ? <div className="pl-3 text-sm font-bold leading-none text-[var(--muted)]" aria-hidden="true">↓</div> : null}
          </li>
        ))}
      </ol>
    </ConsoleDialog>
  );
}

function PluginExecutionTooltip({ plugin }: { plugin: PipelinePluginChipItem }) {
  return (
    <span className="flex flex-col gap-1">
      <span><strong>Behavior version</strong> {plugin.behaviorVersion}</span>
      <span><strong>Hook</strong> {plugin.hook}</span>
      <span><strong>Outcome</strong> {outcomeLabel(plugin.outcome)}</span>
    </span>
  );
}

function outcomeLabel(outcome: PipelinePluginOutcome): string {
  return outcome[0]!.toUpperCase() + outcome.slice(1);
}
