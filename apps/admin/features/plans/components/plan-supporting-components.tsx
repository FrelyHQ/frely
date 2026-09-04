"use client";

import { useEffect, useMemo, useState } from "react";
import { DataTable, type ColumnDef, type RowSelectionState } from "@frely/console-ui/data-table";
import { AccessPointDescription } from "@frely/console-ui/access-point-description";
import { MaterialTable } from "@frely/console-ui/material-table";
import { useForm, useStore } from "@tanstack/react-form";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@frely/ui/components/button";
import { Card } from "@frely/ui/components/card";
import { Input } from "@frely/ui/components/input";
import { Textarea } from "@frely/ui/components/textarea";
import { Tooltip } from "@frely/ui/components/tooltip";
import { useRouter } from "@admin/navigation";
import { SearchSelect, type SearchSelectOption } from "../../../pages/owner/_components/search-select";
import { AdminDialog, ConsoleDialogFooter, PageHeading, StatusBadge } from "../../../pages/owner/_components/ui";
import { createBudgetPolicy, createPlanTemplate, fetchPlanAccessPointCandidates, updatePlanTemplate } from "../api/plan-api";
import { reconcilePlanTemplateSelection, selectedPlanTemplateIds } from "../table/plan-table-state";
import * as planModel from "../form/plan-model";

const {
  basePriceSource,
  copiedPriceMultiplier,
  copyPriceDraftsFromTemplate, defaultBudgetLimitDraft, defaultTemplateDraft, effectivePriceSource,
  emptyPriceDraft, formatBasePrice,
  formatCurrency, formatDateTime, formatDuration, formatEffectivePrice, formatPlanDuration,
  hasTemplatePriceDraftChanges,
  messageFromError, budgetLimitPreview,
  normalizeLimitScope, omitRecordKey, priceDraftsFromTemplate,
  priceMultiplierHint, sameBudgetLimits, sameStringSet, secondsFromDraft, templateDraftFromTemplate,
  titleCase, truncateText,
  uniqueStrings, validateBudgetLimits, validateTemplatePriceDrafts
} = planModel;

type Tone = "good" | "warn" | "bad" | "neutral" | "info";
type DurationUnit = "seconds" | "hours" | "days" | "years";
type WindowUnit = "seconds" | "hours" | "days";
type BudgetLimitScope = "subscription" | "user";

interface BudgetPolicy {
  id: string;
  metric: string;
  limitValue: number;
  windowType: string;
  windowSeconds: number | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

interface AccessPointSummary {
  id: string;
  ownerId: string;
  scopeRef: string;
  name: string;
  description: string | null;
  apiFamily: string;
  exposedModel: string;
  status: string;
  basePrice?: PriceSummary | null;
  effectivePrice?: EffectivePriceSummary | null;
}

interface PriceSummary {
  id: string;
  inputPer1M: number;
  cachedInputPer1M: number;
  cacheWritePer1M: number | null;
  outputPer1M: number;
  tiers?: PriceTierSummary[];
}

interface PriceTierSummary {
  serviceTier?: string;
  tierKey: string;
  minInputTokens: number;
  maxInputTokens: number | null;
  inputPer1M: number;
  cachedInputPer1M: number;
  cacheWritePer1M: number | null;
  outputPer1M: number;
  status: string;
}

interface EffectivePriceSummary {
  source: "access_point" | "plan_access_point";
  price: PriceSummary;
  basePrice: PriceSummary | null;
  planAccessPointPrice: PriceSummary | null;
}

interface PlanTemplate {
  id: string;
  ownerId: string;
  scopeRef: string;
  name: string;
  version: number;
  description: string | null;
  adminNote: string | null;
  billingMode: "prepaid" | "paygo";
  purchaseAmount: number;
  durationSeconds: number;
  status: "enabled" | "closed" | "disabled";
  catalogStatus: "listed" | "unlisted";
  statusImpact: { availableCardCount: number; activeOrFutureSubscriptionCount: number };
  createdAt: string;
  updatedAt: string;
  budgetLimits: Array<{ limitScope: BudgetLimitScope; metric: "tokens" | "amount"; limitValue: number; windowType: "fixed" | "cumulative"; windowSeconds: number | null }>;
  accessPoints: AccessPointSummary[];
}

interface Plan {
  id: string;
  planTemplateId: string;
  source: string;
  scopeRef: string;
  purchasedByUserId: string | null;
  fundingAccountId: string | null;
  priority: number;
  effectiveStart: string;
  effectiveEnd: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

interface TeamSummary {
  id: string;
  name: string;
  status: string;
}

interface UserSummary {
  id: string;
  email: string;
  role: string;
  status: string;
}

interface CreditAccountSummary {
  id: string;
  scopeRef: string;
  status: string;
  balance: number;
}

interface BudgetLimitDraft {
  localId: string;
  metric: string;
  limitValue: string;
  windowType: string;
  windowValue: string;
  windowUnit: WindowUnit;
  limitScope: BudgetLimitScope;
}

interface PriceDraft {
  multiplier: string;
}

interface TemplateDraft {
  name: string;
  description: string;
  adminNote: string;
  billingMode: "prepaid" | "paygo";
  purchaseAmount: string;
  noDurationLimit: boolean;
  durationValue: string;
  durationUnit: DurationUnit;
  budgetLimits: BudgetLimitDraft[];
  accessPointIds: string[];
  accessPointPriceDrafts: Record<string, PriceDraft>;
}

interface ApiError {
  error?: { message?: string };
}

interface PlanCreateBatchResponse {
  items: Plan[];
  ledgerEventIds?: string[];
  nextCursor?: null;
}

interface BudgetPolicyPayload {
  metric: string;
  limitValue: number;
  windowType: string;
  windowSeconds: number | null;
  status: string;
  limitScope: BudgetLimitScope;
}

interface PlanAccessPointPriceDraftPayload {
  accessPointId: string;
  inputPer1M: number;
  cachedInputPer1M: number;
  cacheWritePer1M: number | null;
  outputPer1M: number;
}


export function PlanTemplateAccessPointEditor({
  accessPoints,
  selectedAccessPointIds,
  priceDrafts,
  mode,
  disabled,
  templateAccessPoints = [],
  onAddAccessPoint,
  onRemoveAccessPoint,
  onPriceDraftChange
}: {
  accessPoints: AccessPointSummary[];
  selectedAccessPointIds: string[];
  priceDrafts: Record<string, PriceDraft>;
  mode: "create" | "edit";
  disabled: boolean;
  templateAccessPoints?: AccessPointSummary[];
  onAddAccessPoint: (accessPoint: AccessPointSummary) => void;
  onRemoveAccessPoint: (accessPointId: string) => void;
  onPriceDraftChange: (accessPointId: string, patch: Partial<PriceDraft>) => void;
}) {
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [page, setPage] = useState(1);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebounced(search);
      setPage(1);
    }, 200);
    return () => window.clearTimeout(timer);
  }, [search]);
  const candidates = useQuery({
    queryKey: ["owner", "plans", "access-point-candidates", debounced, page],
    queryFn: ({ signal }) => fetchPlanAccessPointCandidates(debounced, page, signal),
    enabled: !disabled,
    staleTime: 15_000,
    retry: false,
  });
  const accessPointById = useMemo(() => new Map(accessPoints.map((accessPoint) => [accessPoint.id, accessPoint])), [accessPoints]);
  const templateAccessPointById = useMemo(() => new Map(templateAccessPoints.map((accessPoint) => [accessPoint.id, accessPoint])), [templateAccessPoints]);
  const isNewVersion = mode === "create" && templateAccessPointById.size > 0;
  const selectedIds = uniqueStrings(selectedAccessPointIds);
  const selectedAccessPoints = selectedIds
    .map((accessPointId) => templateAccessPointById.get(accessPointId) ?? accessPointById.get(accessPointId))
    .filter((accessPoint): accessPoint is AccessPointSummary => Boolean(accessPoint));
  const candidateItems = candidates.data?.items ?? [];
  const candidateOptions = candidateItems
    .filter((accessPoint) => !selectedIds.includes(accessPoint.id))
    .map((accessPoint) => ({
      value: accessPoint.id,
      label: accessPoint.name,
      ...(accessPoint.description ? { description: accessPoint.description } : {}),
      metadata: `${accessPoint.description ? "" : "— · "}${accessPoint.scopeRef} / ${accessPoint.exposedModel}`,
      searchText: accessPoint.id,
    }));

  return (
    <>
      <div className="template-rule-section">
        <div className="template-rule-heading">
          <div>
            <strong>Included AccessPoints</strong>
            <p className="muted">{mode === "edit" ? "Changing this list replaces the template entitlement set." : "Plans grant runtime access only to selected entry AccessPoints."}</p>
          </div>
          <StatusBadge tone="info">{selectedIds.length} selected</StatusBadge>
        </div>
        {!disabled ? <>
          <SearchSelect
            value=""
            options={candidateOptions}
            onSearchChange={setSearch}
            onValueChange={(id) => {
              const candidate = candidateItems.find((item) => item.id === id);
              if (candidate) onAddAccessPoint(candidate);
            }}
            placeholder="Search AccessPoints"
            pagination={{
              page: candidates.data?.page ?? page,
              totalPages: candidates.data?.totalPages ?? page,
              pending: candidates.isPending,
              onPageChange: setPage,
            }}
          />
          {candidates.error ? <span className="field-error">{candidates.error instanceof Error ? candidates.error.message : "Unable to load AccessPoints"}</span> : null}
        </> : null}
        {selectedAccessPoints.length > 0 ? (
          <div className="template-policy-list">
            {selectedAccessPoints.map((accessPoint) => (
              <div className="template-policy-option" key={accessPoint.id}>
                <span>
                  <strong>{accessPoint.name}</strong>
                  <AccessPointDescription description={accessPoint.description} />
                  <code>{accessPoint.scopeRef} / {accessPoint.exposedModel}</code>
                </span>
                <StatusBadge tone={accessPoint.status === "enabled" ? "good" : "neutral"}>{accessPoint.status}</StatusBadge>
                {!disabled ? <Button type="button" size="sm" variant="secondary" onClick={() => onRemoveAccessPoint(accessPoint.id)}>Remove</Button> : null}
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-inline">No AccessPoints are available.</div>
        )}
      </div>
      <MaterialTable
        columns={["AccessPoint", "Scope", "Model", "API Family", mode === "edit" ? "Effective Price" : isNewVersion ? "Current Price" : "Base Price", "Source", "Multiplier", "Status"].map((header) => ({ header }))}
        rows={selectedAccessPoints.map((accessPoint) => {
            const priceDraft = priceDrafts[accessPoint.id] ?? emptyPriceDraft();
            const usesSourceProfile = mode === "edit" || templateAccessPointById.has(accessPoint.id);
            const multiplierAccessPoint = isNewVersion && templateAccessPointById.has(accessPoint.id) ? accessPointById.get(accessPoint.id) ?? accessPoint : accessPoint;
            const multiplierHint = priceMultiplierHint(multiplierAccessPoint);
            const source = usesSourceProfile ? effectivePriceSource(accessPoint) : basePriceSource(accessPoint);
            return {
              id: accessPoint.id,
              cells: [
                <><strong>{accessPoint.name}</strong><AccessPointDescription description={accessPoint.description} /><code>{accessPoint.id}</code></>,
                <code>{accessPoint.scopeRef}</code>,
                accessPoint.exposedModel,
                accessPoint.apiFamily,
                usesSourceProfile ? formatEffectivePrice(accessPoint.effectivePrice ?? null) : formatBasePrice(accessPoint.basePrice ?? null),
                <StatusBadge tone={source.tone}>{source.label}</StatusBadge>,
                <div className="template-price-inputs"><Tooltip content={multiplierHint.title} wrapTrigger={disabled} triggerClassName="w-full"><Input inputMode="decimal" aria-label={`${accessPoint.name} plan price multiplier`} placeholder={multiplierHint.placeholder} value={priceDraft.multiplier} onChange={(event) => onPriceDraftChange(accessPoint.id, { multiplier: event.target.value })} disabled={disabled} /></Tooltip></div>,
                <StatusBadge tone={accessPoint.status === "enabled" ? "good" : "neutral"}>{accessPoint.status}</StatusBadge>
              ]
            };
          })}
        emptyState={{ title: "No AccessPoints", description: "This template does not grant model access." }}
        table={{ wrapperClassName: "compact-table" }}
      />
    </>
  );
}

export function BudgetLimitsEditor({ limits, disabled, onAdd, onRemove, onChange }: { limits: BudgetLimitDraft[]; disabled: boolean; onAdd: () => void; onRemove: (localId: string) => void; onChange: (localId: string, patch: Partial<BudgetLimitDraft>) => void }) {
  return (
    <div className="template-rule-section">
      <div className="template-rule-heading">
        <div><strong>Budget Limits</strong><p className="muted">Limits belong only to this Plan version.</p></div>
        <Button type="button" variant="secondary" onClick={onAdd} disabled={disabled}>Add Limit</Button>
      </div>
      {limits.length > 0 ? <div className="template-new-policy-list">
        {limits.map((limit, index) => <div className="template-new-policy" key={limit.localId}>
          <div className="template-new-policy-title"><strong>Limit {index + 1}</strong><Button type="button" variant="secondary" onClick={() => onRemove(limit.localId)} disabled={disabled}>Remove</Button></div>
          <div className="form-grid">
            <label>Limit Scope<SearchSelect value={limit.limitScope} onValueChange={(value) => onChange(limit.localId, { limitScope: normalizeLimitScope(value) })} disabled={disabled} searchable={false} options={[{ value: "subscription", label: "Subscription limit" }, { value: "user", label: "User limit" }]} /></label>
            <label>Metric<SearchSelect value={limit.metric} onValueChange={(value) => onChange(limit.localId, { metric: value })} disabled={disabled} searchable={false} options={[{ value: "amount", label: "Amount" }, { value: "tokens", label: "Tokens" }]} /></label>
            <label>Limit<Input inputMode="decimal" value={limit.limitValue} placeholder={limit.metric === "amount" ? "50" : "1000000"} onChange={(event) => onChange(limit.localId, { limitValue: event.target.value })} disabled={disabled} /></label>
            <label>Window Type<SearchSelect value={limit.windowType} onValueChange={(value) => onChange(limit.localId, { windowType: value })} disabled={disabled} searchable={false} options={[{ value: "fixed", label: "Fixed reset" }, { value: "cumulative", label: "Plan cumulative" }]} /></label>
            {limit.windowType === "fixed" ? <>
              <label>Window<Input inputMode="decimal" value={limit.windowValue} placeholder="4" onChange={(event) => onChange(limit.localId, { windowValue: event.target.value })} disabled={disabled} /></label>
              <label>Window Unit<SearchSelect value={limit.windowUnit} onValueChange={(value) => onChange(limit.localId, { windowUnit: value as WindowUnit })} disabled={disabled} searchable={false} options={[{ value: "seconds", label: "Seconds" }, { value: "hours", label: "Hours" }, { value: "days", label: "Days" }]} /></label>
            </> : null}
          </div>
          <div className="template-rule-preview">{budgetLimitPreview(limit)}</div>
        </div>)}
      </div> : <div className="empty-inline">No budget limits configured.</div>}
    </div>
  );
}

export function BulkPlanTemplatesDialog({ templates, onClose, onSaved }: { templates: Array<Omit<PlanTemplate, "budgetLimits" | "accessPoints">>; onClose: () => void; onSaved: (updatedTemplates: Array<Pick<PlanTemplate, "id" | "status" | "updatedAt">>) => void }) {
  const router = useRouter();
  const [error, setError] = useState("");
  const mutation = useMutation({ mutationFn: updatePlanTemplate, retry: false });
  const form = useForm({ defaultValues: { status: "enabled" }, onSubmit: async ({ value }) => save(value.status) });
  const status = useStore(form.store, (state) => state.values.status);
  const saving = form.state.isSubmitting || mutation.isPending;
  const disabledReason = templates.length === 0
    ? "Select at least one plan template."
    : status === "disabled" && templates.some((template) => template.status === "enabled")
      ? "Enabled Plans must be closed before they can be disabled."
      : status === "closed" && templates.some((template) => template.status === "disabled")
        ? "Disabled Plans must be enabled before they can be closed."
        : "";

  return (
    <AdminDialog
      observabilityKey="plan-template-bulk-edit"
      titleId="bulk-plan-templates-dialog-title"
      eyebrow="Plan Templates"
      title="Bulk edit"
      description={`${templates.length} selected templates`}
      onClose={onClose}
      closeDisabled={saving}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <div className="form-grid single">
          <label>
            Status
            <SearchSelect value={status} onValueChange={(nextValue) => form.setFieldValue("status", nextValue)} disabled={saving} searchable={false} options={[{ value: "enabled", label: "Enabled" }, { value: "closed", label: "Closed" }, { value: "disabled", label: "Disabled" }]} />
            <span>Closed stops new entitlements but keeps existing subscriptions available at runtime.</span>
          </label>
        </div>
        <div className="embedded-section bulk-selection-summary">
          <strong>Selected Plan Templates</strong>
          <div className="bulk-selection-list">
            {templates.map((template) => (
              <div key={template.id}>
                <span>{template.name} v{template.version}</span>
                <code>{template.status}{" -> "}{status}</code>
                {status === "disabled" && template.status === "closed" ? <small>{template.statusImpact.availableCardCount} available Card(s), {template.statusImpact.activeOrFutureSubscriptionCount} active/future Subscription(s)</small> : null}
              </div>
            ))}
          </div>
        </div>
        <ConsoleDialogFooter feedback={error ? <div className="notice-box notice-bad" role="alert">{error}</div> : null}>
          <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Tooltip content={disabledReason} wrapTrigger><Button type="submit" disabled={saving || Boolean(disabledReason)}>{saving ? "Saving..." : "Save Changes"}</Button></Tooltip>
        </ConsoleDialogFooter>
      </form>
    </AdminDialog>
  );

  async function save(nextStatus: string) {
    if (disabledReason) {
      setError(disabledReason);
      return;
    }
    setError("");
    try {
      const updatedTemplates = await Promise.all(templates.map(async (template) => {
        const updated = await mutation.mutateAsync({ id: template.id, status: nextStatus as "enabled" | "closed" | "disabled" });
        return { id: updated.id, status: updated.status, updatedAt: updated.updatedAt };
      }));
      onSaved(updatedTemplates);
      router.refresh();
    } catch (saveError) {
      setError(messageFromError(saveError));
    }
  }
}
