"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { DataTable, type ColumnDef, type RowSelectionState } from "@frely/console-ui/data-table";
import { MaterialTablePagination } from "@frely/console-ui/material-table-pagination";
import { PortalMenu } from "@frely/console-ui/portal-menu";
import { Button } from "@frely/ui/components/button";
import { Checkbox } from "@frely/ui/components/checkbox";
import { Input } from "@frely/ui/components/input";
import { Tooltip } from "@frely/ui/components/tooltip";
import { StatusBadge } from "../../../pages/owner/_components/ui";
import { AccessPointDescription } from "@frely/console-ui/access-point-description";
import {
  addDraftTier,
  formatPriceTupleDisplay,
  missingReferenceProfileCount,
  parsePriceTupleDisplay,
  removeDraftTier,
  unsupportedReferenceProfiles,
  updateDraftTier,
  validatePriceDraft,
  type PriceDraft,
  type PriceTupleDisplay,
  type PriceTierDraft,
} from "../form/price-draft";
import { numericPricePayload, pricingRowId } from "../table/pricing-workbench";
import type { AccessPointPriceWorkbenchRow, OpenAiReferencePrice, ProviderCostWorkbenchRow } from "../types";
import {
  enabledPriceProfileRows,
  formatDraftTokenRange,
  formatPricePerMillion,
  referencePriceEqualsCurrent,
  referencePriceProfileRows,
  type PriceProfileDisplayRow,
} from "./price-profile";

export function ProviderCostWorkbenchTable({
  rows,
  selectedIds,
  onSelectedIdsChange,
  onDraftChange,
  onFillReference,
  onAdoptReference,
  onCreateRow,
}: {
  rows: ProviderCostWorkbenchRow[];
  selectedIds: Set<string>;
  onSelectedIdsChange: (selectedIds: Set<string>) => void;
  onDraftChange: (rowId: string, draft: PriceDraft) => void;
  onFillReference: (row: ProviderCostWorkbenchRow) => void;
  onAdoptReference: (row: ProviderCostWorkbenchRow) => void;
  onCreateRow: (row: ProviderCostWorkbenchRow) => void;
}) {
  const [showUnsupportedReference, setShowUnsupportedReference] = useState(false);
  const showUnsupportedReferenceRef = useRef(showUnsupportedReference);
  showUnsupportedReferenceRef.current = showUnsupportedReference;
  const handlers = useRef({ onDraftChange, onFillReference, onAdoptReference, onCreateRow });
  handlers.current = { onDraftChange, onFillReference, onAdoptReference, onCreateRow };
  const columns = useMemo<Array<ColumnDef<ProviderCostWorkbenchRow, unknown>>>(
    () => [
      {
        id: "providerModel",
        accessorFn: (row) => `${row.providerName} ${row.displayName} ${row.providerModelName}`,
        header: "Provider Model",
        cell: ({ row }) => (
          <>
            <strong>{row.original.providerName}</strong>
            <span>{row.original.displayName}</span>
            <code>
              {row.original.providerId}:{row.original.providerModelName}
            </code>
          </>
        ),
      },
      {
        id: "profile",
        header: "Profile",
        cell: ({ row }) => (
          <SharedProfileColumn
            profiles={providerProfileKeys(row.original, showUnsupportedReferenceRef.current)}
            draft={row.original.draft}
            onChange={(draft) => handlers.current.onDraftChange(row.original.id, draft)}
          />
        ),
      },
      {
        id: "currentEnabled",
        header: "Current Enabled",
        columns: priceProfileColumns("current", (row) => providerProfileKeys(row, showUnsupportedReferenceRef.current), (row) => row.enabledCost ? enabledPriceProfileRows(row.enabledCost) : null, "No enabled cost"),
      },
      {
        id: "reference",
        header: () => (
          <div className="reference-header-controls">
            <span>Reference</span>
            <Tooltip content="Show unsupported batch and flex pricing profiles">
              <label>
                <Checkbox
                  checked={showUnsupportedReferenceRef.current}
                  onCheckedChange={(checked) => setShowUnsupportedReference(checked === true)}
                />
                <span>Show batch/flex</span>
              </label>
            </Tooltip>
          </div>
        ),
        columns: priceProfileColumns(
          "reference",
          (row) => providerProfileKeys(row, showUnsupportedReferenceRef.current),
          (row) => row.referencePrice ? referencePriceProfileRows(row.referencePrice, showUnsupportedReferenceRef.current) : null,
          "No match",
          (row) => row.referencePrice ? {
            tooltip: referencePriceTooltip(row.referencePrice),
            muted: row.enabledCost ? referencePriceEqualsCurrent(row.referencePrice, row.enabledCost) : false,
          } : undefined,
        ),
      },
      {
        id: "draft",
        header: "Draft Price Profile",
        columns: draftPriceColumns(
          (row) => providerProfileKeys(row, showUnsupportedReferenceRef.current),
          (row) => row.draft,
          (row) => row.referencePrice,
          () => showUnsupportedReferenceRef.current,
          (row, draft) => handlers.current.onDraftChange(row.id, draft),
        ),
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => (
          <div className="model-pair">
            <StatusBadge tone={row.original.modelStatus === "enabled" ? "good" : "neutral"}>{row.original.modelStatus}</StatusBadge>
            <StatusBadge tone={row.original.enabledCost ? "good" : "warn"}>{row.original.enabledCost ? "priced" : "missing"}</StatusBadge>
          </div>
        ),
      },
      {
        id: "actions",
        header: "Actions",
        cell: ({ row }) => (
          <PriceRowActions
            draft={row.original.draft}
            referencePrice={row.original.referencePrice}
            onChange={(draft) => handlers.current.onDraftChange(row.original.id, draft)}
            onFillReference={() => handlers.current.onFillReference(row.original)}
            onAdoptReference={() => handlers.current.onAdoptReference(row.original)}
            onCreate={() => handlers.current.onCreateRow(row.original)}
          />
        ),
      },
    ],
    [],
  );
  return (
    <DataTable
      data={rows}
      columns={columns}
      getRowId={pricingRowId}
      table={{ density: "compact", minWidth: "wide" }}
      emptyState={{ title: "No provider models match the current filters." }}
      initialState={{ sorting: [{ id: "providerModel", desc: false }] }}
      state={{ rowSelection: setToRowSelection(selectedIds) }}
      onStateChange={{
        rowSelection: (updater) =>
          onSelectedIdsChange(rowSelectionToSet(typeof updater === "function" ? updater(setToRowSelection(selectedIds)) : updater)),
      }}
      selection={{
        selectedLabel: "provider cost rows",
      }}
    />
  );
}

function referencePriceTooltip(price: OpenAiReferencePrice) {
  return `Source: OpenAI official pricing. Model: ${price.displayName || price.model}. Fetched: ${new Date(price.fetchedAt).toLocaleString()}. URL: ${price.sourceUrl}`;
}

type PriceProfileDimension = "range" | "inputPer1M" | "cachedInputPer1M" | "cacheWritePer1M" | "outputPer1M";
type SharedProfile = { serviceTier: string; tierKey: string; label: string };

function profileKey(profile: Pick<SharedProfile, "serviceTier" | "tierKey">) {
  return `${profile.serviceTier}:${profile.tierKey}`;
}

function providerProfileKeys(row: ProviderCostWorkbenchRow, includeUnsupported: boolean): SharedProfile[] {
  const profiles = [
    ...(row.enabledCost ? enabledPriceProfileRows(row.enabledCost) : []),
    ...(row.referencePrice ? referencePriceProfileRows(row.referencePrice, includeUnsupported) : []),
    { serviceTier: "standard", tierKey: "short_context", label: "standard / short" },
    ...row.draft.tiers.map((tier) => ({ serviceTier: tier.serviceTier, tierKey: tier.tierKey, label: `${tier.serviceTier} / ${tier.tierKey === "short_context" ? "short" : "long"}` })),
  ];
  const unique = new Map(profiles.map((profile) => [profileKey(profile), { serviceTier: profile.serviceTier, tierKey: profile.tierKey, label: profile.label }]));
  const serviceOrder: Record<string, number> = { standard: 0, priority: 1, batch: 2, flex: 3 };
  return [...unique.values()].sort((left, right) =>
    (serviceOrder[left.serviceTier] ?? 99) - (serviceOrder[right.serviceTier] ?? 99) ||
    (left.tierKey === "short_context" ? 0 : 1) - (right.tierKey === "short_context" ? 0 : 1) ||
    left.label.localeCompare(right.label));
}

function accessPointProfileKeys(row: AccessPointPriceWorkbenchRow): SharedProfile[] {
  const profiles = [
    ...(row.targetCost ? enabledPriceProfileRows(row.targetCost) : []),
    ...(row.enabledPrice ? enabledPriceProfileRows(row.enabledPrice) : []),
    { serviceTier: "standard", tierKey: "short_context", label: "standard / short" },
    ...row.draft.tiers.map((tier) => ({ serviceTier: tier.serviceTier, tierKey: tier.tierKey, label: `${tier.serviceTier} / ${tier.tierKey === "short_context" ? "short" : "long"}` })),
  ];
  return [...new Map(profiles.map((profile) => [profileKey(profile), { serviceTier: profile.serviceTier, tierKey: profile.tierKey, label: profile.label }])).values()];
}

function priceProfileColumns<TRow>(
  prefix: string,
  profilesFor: (row: TRow) => SharedProfile[],
  rowsFor: (row: TRow) => PriceProfileDisplayRow[] | null,
  emptyLabel: string,
  decorationFor?: (row: TRow) => { tooltip?: string; muted?: boolean } | undefined,
): Array<ColumnDef<TRow, unknown>> {
  const definitions: Array<{ dimension: PriceProfileDimension; header: string }> = [
    { dimension: "range", header: "Range" },
    { dimension: "inputPer1M", header: "Input" },
    { dimension: "cachedInputPer1M", header: "Cache read" },
    { dimension: "cacheWritePer1M", header: "Cache write" },
    { dimension: "outputPer1M", header: "Output" },
  ];
  return definitions.map(({ dimension, header }) => ({
    id: `${prefix}-${dimension}`,
    header,
    cell: ({ row }) => {
      const profileRows = rowsFor(row.original);
      const profiles = profilesFor(row.original);
      const decoration = decorationFor?.(row.original);
      const tooltip = dimension === "range" ? decoration?.tooltip : undefined;
      return (
        <Tooltip content={tooltip}>
          <div className={`price-profile-column${decoration?.muted ? " reference-price-cell-same" : ""}`} tabIndex={tooltip ? 0 : undefined}>
            {profiles.map((profile, index) => {
              const value = profileRows?.find((candidate) => profileKey(candidate) === profileKey(profile));
              return <span key={profileKey(profile)}>{value ? (dimension === "range" ? value.range : formatProfileDimension(value[dimension])) : index === 0 && !profileRows ? emptyLabel : "—"}</span>;
            })}
          </div>
        </Tooltip>
      );
    },
  }));
}

function formatProfileDimension(value: number | null) {
  return value === null || Number.isNaN(value) ? "Unavailable" : formatPricePerMillion(value);
}

export function AccessPointPriceWorkbenchTable({
  rows,
  selectedIds,
  onSelectedIdsChange,
  onDraftChange,
  onSuggestRow,
  onCreateRow,
}: {
  rows: AccessPointPriceWorkbenchRow[];
  selectedIds: Set<string>;
  onSelectedIdsChange: (selectedIds: Set<string>) => void;
  onDraftChange: (rowId: string, draft: PriceDraft) => void;
  onSuggestRow: (row: AccessPointPriceWorkbenchRow) => void;
  onCreateRow: (row: AccessPointPriceWorkbenchRow) => void;
}) {
  const handlers = useRef({ onDraftChange, onSuggestRow, onCreateRow });
  handlers.current = { onDraftChange, onSuggestRow, onCreateRow };
  const columns = useMemo<Array<ColumnDef<AccessPointPriceWorkbenchRow, unknown>>>(
    () => [
      {
        id: "accessPoint",
        accessorFn: (row) => `${row.name} ${row.scopeRef} ${row.id}`,
        header: "AccessPoint",
        cell: ({ row }) => (
          <>
            <strong>{row.original.name}</strong>
            <AccessPointDescription description={row.original.description} />
            <span>{row.original.scopeRef}</span>
            <code>{row.original.id}</code>
          </>
        ),
      },
      {
        id: "target",
        header: "Target",
        cell: ({ row }) => (
          <>
            <span>{row.original.targetLabel}</span>
            {row.original.targetReference ? <code>{row.original.targetReference}</code> : null}
          </>
        ),
      },
      {
        id: "profile",
        header: "Profile",
        cell: ({ row }) => <SharedProfileColumn profiles={accessPointProfileKeys(row.original)} draft={row.original.draft} onChange={(draft) => handlers.current.onDraftChange(row.original.id, draft)} />,
      },
      {
        id: "targetCost",
        header: "Target Cost",
        columns: priceProfileColumns(
          "target-cost",
          accessPointProfileKeys,
          (row) => row.targetCost ? enabledPriceProfileRows(row.targetCost) : null,
          "No enabled target cost",
        ),
      },
      {
        id: "currentEnabled",
        header: "Current Enabled",
        columns: priceProfileColumns(
          "current",
          accessPointProfileKeys,
          (row) => row.enabledPrice ? enabledPriceProfileRows(row.enabledPrice) : null,
          "No enabled price",
        ),
      },
      {
        id: "draft",
        header: "Draft Price Profile",
        columns: draftPriceColumns(
          (row) => accessPointProfileKeys(row),
          (row) => row.draft,
          () => null,
          () => false,
          (row, draft) => handlers.current.onDraftChange(row.id, draft),
        ),
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => (
          <div className="model-pair">
            <StatusBadge tone={row.original.status === "enabled" ? "good" : "neutral"}>{row.original.status}</StatusBadge>
            <StatusBadge tone={row.original.enabledPrice ? "good" : "warn"}>{row.original.enabledPrice ? "priced" : "missing"}</StatusBadge>
          </div>
        ),
      },
      {
        id: "actions",
        header: "Actions",
        cell: ({ row }) => (
          <PriceRowActions
            draft={row.original.draft}
            onChange={(draft) => handlers.current.onDraftChange(row.original.id, draft)}
            onSuggestTarget={() => handlers.current.onSuggestRow(row.original)}
            suggestTargetDisabled={!row.original.targetCost}
            onCreate={() => handlers.current.onCreateRow(row.original)}
          />
        ),
      },
    ],
    [],
  );
  return (
    <DataTable
      data={rows}
      columns={columns}
      getRowId={pricingRowId}
      table={{ density: "compact", minWidth: "wide" }}
      emptyState={{ title: "No AccessPoints match the current filters." }}
      initialState={{ sorting: [{ id: "accessPoint", desc: false }] }}
      state={{ rowSelection: setToRowSelection(selectedIds) }}
      onStateChange={{
        rowSelection: (updater) =>
          onSelectedIdsChange(rowSelectionToSet(typeof updater === "function" ? updater(setToRowSelection(selectedIds)) : updater)),
      }}
      selection={{
        selectedLabel: "AccessPoint price rows",
      }}
    />
  );
}

export function MaterialWorkbenchPagination({
  label,
  page,
  pageCount,
  pageSize,
  totalRows,
  onPageChange,
  onPageSizeChange,
}: {
  label: string;
  page: number;
  pageCount: number;
  pageSize: number;
  totalRows: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}) {
  const start = totalRows === 0 ? 0 : page * pageSize + 1;
  const end = Math.min((page + 1) * pageSize, totalRows);

  return <MaterialTablePagination aria-label={`${label} pagination`} page={page + 1} pageSize={pageSize} totalPages={pageCount} total={totalRows} noun={label} rangeStart={start} rangeEnd={end} onPageSizeChange={onPageSizeChange} {...(page > 0 ? { onPrevious: () => onPageChange(page - 1) } : {})} {...(page < pageCount - 1 ? { onNext: () => onPageChange(page + 1) } : {})} />;
}

function draftPriceColumns<TRow extends { id: string }>(
  profilesFor: (row: TRow) => SharedProfile[],
  draftFor: (row: TRow) => PriceDraft,
  referenceFor: (row: TRow) => OpenAiReferencePrice | null,
  showUnsupported: () => boolean,
  onChange: (row: TRow, draft: PriceDraft) => void,
): Array<ColumnDef<TRow, unknown>> {
  return [
    { id: "draft-range", header: "Range", cell: ({ row }) => <DraftRangeColumn profiles={profilesFor(row.original)} draft={draftFor(row.original)} referencePrice={referenceFor(row.original)} showUnsupported={showUnsupported()} onChange={(draft) => onChange(row.original, draft)} /> },
    { id: "draft-prices", header: "Prices — Input, Cache read, Cache write, Output", cell: ({ row }) => <DraftPricesColumn profiles={profilesFor(row.original)} draft={draftFor(row.original)} referencePrice={referenceFor(row.original)} showUnsupported={showUnsupported()} onChange={(draft) => onChange(row.original, draft)} /> },
  ];
}

function SharedProfileColumn({ profiles, draft, onChange }: { profiles: SharedProfile[]; draft: PriceDraft; onChange: (draft: PriceDraft) => void }) {
  return <div className="price-draft-column price-draft-profile-column">{profiles.map((profile) => {
    const tierIndex = draft.tiers.findIndex((tier) => profileKey(tier) === profileKey(profile));
    return <div className="price-draft-cell" key={profileKey(profile)}><strong>{profile.label}</strong>{tierIndex >= 0 ? <Tooltip content="Remove tier"><Button type="button" variant="ghost" className="price-draft-remove" onClick={() => onChange(removeDraftTier(draft, tierIndex))} aria-label={`Remove ${profile.label}`}>×</Button></Tooltip> : null}</div>;
  })}</div>;
}

function DraftRangeColumn({ profiles, draft, referencePrice, showUnsupported, onChange }: { profiles: SharedProfile[]; draft: PriceDraft; referencePrice: OpenAiReferencePrice | null; showUnsupported: boolean; onChange: (draft: PriceDraft) => void }) {
  const unsupported = referencePrice && showUnsupported ? unsupportedReferenceProfiles(referencePrice) : [];
  return <div className="price-draft-column price-draft-range-column">{profiles.map((profile) => {
    if (profileKey(profile) === "standard:short_context") return <div className="price-draft-cell muted" key={profileKey(profile)}>0–∞</div>;
    const index = draft.tiers.findIndex((tier) => profileKey(tier) === profileKey(profile));
    const tier = draft.tiers[index];
    if (tier) return <div className="price-draft-cell" key={profileKey(profile)}><div className="price-draft-range">
      <CompactPriceInput label={`${tier.serviceTier} / ${tier.tierKey} minimum input tokens`} value={tier.minInputTokensDisplay} onChange={(value) => onChange(updateDraftTier(draft, index, { minInputTokensDisplay: value }))} inputMode="numeric" placeholder="Min" />
      <Tooltip content={formatDraftTokenRange(tier)}><span tabIndex={0}>–</span></Tooltip>
      <CompactPriceInput label={`${tier.serviceTier} / ${tier.tierKey} maximum input tokens`} value={tier.maxInputTokensDisplay} onChange={(value) => onChange(updateDraftTier(draft, index, { maxInputTokensDisplay: value }))} inputMode="numeric" placeholder="∞" />
    </div></div>;
    const referenceTier = unsupported.find((candidate) => profileKey({ serviceTier: candidate.serviceTier, tierKey: candidate.context }) === profileKey(profile));
    return <div className="price-draft-cell muted price-draft-unsupported" key={profileKey(profile)}>{referenceTier ? `${referenceTier.minInputTokens.toLocaleString()}–${referenceTier.maxInputTokens === null ? "∞" : referenceTier.maxInputTokens.toLocaleString()}` : "—"}</div>;
  })}</div>;
}

function DraftPricesColumn({ profiles, draft, referencePrice, showUnsupported, onChange }: { profiles: SharedProfile[]; draft: PriceDraft; referencePrice: OpenAiReferencePrice | null; showUnsupported: boolean; onChange: (draft: PriceDraft) => void }) {
  const unsupported = referencePrice && showUnsupported ? unsupportedReferenceProfiles(referencePrice) : [];
  return <div className="price-draft-column price-draft-prices-column">{profiles.map((profile) => {
    if (profileKey(profile) === "standard:short_context") return <div className="price-draft-cell" key={profileKey(profile)}><CompactPriceTupleInput label="standard / short prices: Input, Cache read, Cache write, Output" values={[draft.inputPerMillionDisplay, draft.cachedInputPerMillionDisplay, draft.cacheWritePerMillionDisplay, draft.outputPerMillionDisplay]} onChange={([input, cacheRead, cacheWrite, output]) => onChange({ ...draft, inputPerMillionDisplay: input, cachedInputPerMillionDisplay: cacheRead, cacheWritePerMillionDisplay: cacheWrite, outputPerMillionDisplay: output })} /></div>;
    const index = draft.tiers.findIndex((tier) => profileKey(tier) === profileKey(profile));
    const tier = draft.tiers[index];
    if (tier) return <div className="price-draft-cell" key={profileKey(profile)}><CompactPriceTupleInput label={`${tier.serviceTier} / ${tier.tierKey} prices: Input, Cache read, Cache write, Output`} values={[tier.inputPer1M, tier.cachedInputPer1M, tier.cacheWritePer1M, tier.outputPer1M]} onChange={([inputPer1M, cachedInputPer1M, cacheWritePer1M, outputPer1M]) => onChange(updateDraftTier(draft, index, { inputPer1M, cachedInputPer1M, cacheWritePer1M, outputPer1M }))} /></div>;
    const referenceTier = unsupported.find((candidate) => profileKey({ serviceTier: candidate.serviceTier, tierKey: candidate.context }) === profileKey(profile));
    return <div className="price-draft-cell price-draft-unsupported" key={profileKey(profile)}>{referenceTier ? <Tooltip content="This pricing type is not supported yet and cannot be configured." wrapTrigger triggerClassName="w-full"><Input aria-label={`${referenceTier.serviceTier} / ${referenceTier.context} prices (unsupported)`} value={formatPriceTupleDisplay([String(referenceTier.inputPer1M), referenceTier.cachedInputPer1M === null ? "Unavailable" : String(referenceTier.cachedInputPer1M), referenceTier.cacheWritePer1M === null ? "Unavailable" : String(referenceTier.cacheWritePer1M), String(referenceTier.outputPer1M)])} disabled readOnly /></Tooltip> : "—"}</div>;
  })}</div>;
}

function PriceRowActions({ draft, referencePrice = null, onChange, onFillReference, onAdoptReference, onSuggestTarget, suggestTargetDisabled = false, onCreate }: { draft: PriceDraft; referencePrice?: OpenAiReferencePrice | null; onChange: (draft: PriceDraft) => void; onFillReference?: () => void; onAdoptReference?: () => void; onSuggestTarget?: () => void; suggestTargetDisabled?: boolean; onCreate: () => void }) {
  const validation = validatePriceDraft(draft);
  return (
    <div className="price-row-actions">
      <div className="row-actions">
        {onFillReference ? <Button type="button" variant="outline" onClick={onFillReference} disabled={!referencePrice}>Fill Reference</Button> : null}
        {onSuggestTarget ? <Button type="button" variant="outline" onClick={onSuggestTarget} disabled={suggestTargetDisabled}>Suggest</Button> : null}
        <Button type="button" onClick={onCreate} disabled={!numericPricePayload(draft)}>Create</Button>
      </div>
      <PriceProfileMenu
        draft={draft}
        referencePrice={referencePrice}
        onChange={onChange}
        {...(onAdoptReference ? { onAdoptReference } : {})}
      />
      <Tooltip content={validation.errors.length > 0 ? validation.errors.join(" · ") : undefined}>
        <span className={`price-action-validation ${validation.errors.length > 0 ? "price-action-invalid" : "price-action-valid"}`} tabIndex={validation.errors.length > 0 ? 0 : undefined} role={validation.errors.length > 0 ? "alert" : undefined}>
          {validation.errors.length > 0 ? `${validation.errors.length} issue${validation.errors.length === 1 ? "" : "s"}` : "Ready to create"}
        </span>
      </Tooltip>
    </div>
  );
}

export function PriceProfileMenu({
  draft,
  referencePrice = null,
  onChange,
  onAdoptReference,
}: {
  draft: PriceDraft;
  referencePrice?: OpenAiReferencePrice | null;
  onChange: (draft: PriceDraft) => void;
  onAdoptReference?: () => void;
}) {
  const adoptCount = referencePrice ? missingReferenceProfileCount(draft, referencePrice) : 0;
  return (
    <PortalMenu
      className="price-profile-menu"
      triggerClassName="price-profile-menu-trigger"
      contentClassName="price-profile-menu-content"
      triggerContent="Manage Profiles"
      ariaLabel="Manage Profiles"
      menuAriaLabel="Manage Profiles menu"
    >
      <button type="button" role="menuitem" onClick={() => onChange(addDraftTier(draft, "standard", "long_context"))} disabled={hasDraftTier(draft, "standard", "long_context")}>Add Standard Long</button>
      <button type="button" role="menuitem" onClick={() => onChange(addDraftTier(draft, "priority", "short_context"))} disabled={hasDraftTier(draft, "priority", "short_context")}>Add Priority Short</button>
      <button type="button" role="menuitem" onClick={() => onChange(addDraftTier(draft, "priority", "long_context"))} disabled={hasDraftTier(draft, "priority", "long_context")}>Add Priority Long</button>
      {onAdoptReference && adoptCount > 0 ? <button type="button" role="menuitem" onClick={onAdoptReference}>Adopt Reference Structure ({adoptCount})</button> : null}
    </PortalMenu>
  );
}

function hasDraftTier(draft: PriceDraft, serviceTier: PriceTierDraft["serviceTier"], tierKey: string) {
  return draft.tiers.some((tier) => tier.serviceTier === serviceTier && tier.tierKey === tierKey);
}

function CompactPriceInput({
  label,
  value,
  onChange,
  inputMode = "decimal",
  placeholder = "0.00",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  inputMode?: "decimal" | "numeric";
  placeholder?: string;
}) {
  return (
    <Tooltip content={label}>
      <Input
        aria-label={label}
        inputMode={inputMode}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
    </Tooltip>
  );
}

function CompactPriceTupleInput({ label, values, onChange }: { label: string; values: PriceTupleDisplay; onChange: (values: PriceTupleDisplay) => void }) {
  const formatted = formatPriceTupleDisplay(values);
  const [display, setDisplay] = useState(formatted);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDisplay(formatted);
  }, [formatted]);
  return (
    <Tooltip content={label}>
      <Input
        aria-label={label}
        inputMode="text"
        value={display}
        placeholder="Input, Cache read, Cache write or Unavailable, Output"
        onFocus={() => { focused.current = true; }}
        onBlur={() => {
          focused.current = false;
          setDisplay(formatPriceTupleDisplay(values));
        }}
        onChange={(event) => {
          const next = event.target.value;
          setDisplay(next);
          onChange(parsePriceTupleDisplay(next));
        }}
      />
    </Tooltip>
  );
}

function setToRowSelection(selectedIds: Set<string>): RowSelectionState {
  return Object.fromEntries([...selectedIds].map((id) => [id, true]));
}

function rowSelectionToSet(selection: RowSelectionState): Set<string> {
  return new Set(
    Object.entries(selection)
      .filter(([, selected]) => selected)
      .map(([id]) => id),
  );
}
