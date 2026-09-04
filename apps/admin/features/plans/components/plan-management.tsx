"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { DataTable, type RowSelectionState } from "@frely/console-ui/data-table";
import { MaterialTablePagination } from "@frely/console-ui/material-table-pagination";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@frely/ui/components/button";
import { Card } from "@frely/ui/components/card";
import { Input } from "@frely/ui/components/input";
import { Textarea } from "@frely/ui/components/textarea";
import { useRouter } from "@admin/navigation";
import { SearchSelect } from "../../../pages/owner/_components/search-select";
import { AdminDialog, ConsoleDialogFooter, PageHeading, StatusBadge } from "../../../pages/owner/_components/ui";
import { createPlanTemplate, fetchPlanTemplateDetail, replaceAvailablePlanCards, updatePlanTemplate } from "../api/plan-api";
import { reconcilePlanTemplateSelection, selectedPlanTemplateIds, stablePlanTemplateRowId } from "../table/plan-table-state";
import { createPlanTemplateColumns } from "../table/plan-columns";
import { BudgetLimitsEditor, BulkPlanTemplatesDialog, PlanTemplateAccessPointEditor } from "./plan-supporting-components";
import { PlanTokenLimitPreview } from "./plan-token-limit-preview";
import { RemotePlanReplacementSelect } from "./remote-plan-replacement-select";
import { usePlanFormControllers } from "../form/use-plan-form-controllers";
import * as planModel from "../form/plan-model";
import { plansHref, type PlansUrlState } from "../lib/plan-url-state";

const {
  budgetLimitDraftsFromTemplate, buildPlanTokenLimitPreview,
  buildCopiedPlanPriceOverrides, buildEditedPlanVersionCreateInput, buildEditedPlanVersionPriceOverrides,
  defaultBudgetLimitDraft, defaultTemplateDraft,
  emptyPriceDraft,
  formatCurrency, formatDateTime, formatPlanDuration,
  hasTemplatePriceDraftChanges, messageFromError,
  omitRecordKey, priceDraftsFromTemplate,
  PLAN_VERSION_CONFIRM_TITLE, planCreateDialogPresentation, sameBudgetLimits,
  sameStringSet, secondsFromDraft, shouldOfferPlanVersionCreation, templateDraftFromTemplate,
  uniqueStrings, validateBudgetLimits, validateTemplatePriceDrafts
} = planModel;

type Tone = "good" | "warn" | "bad" | "neutral" | "info";
type DurationUnit = "seconds" | "hours" | "days" | "years";
type WindowUnit = "seconds" | "hours" | "days";
type BudgetLimitScope = "subscription" | "user";

interface PlanBudgetLimit {
  limitScope: BudgetLimitScope;
  metric: "tokens" | "amount";
  limitValue: number;
  windowType: "fixed" | "cumulative";
  windowSeconds: number | null;
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
  budgetLimits: PlanBudgetLimit[];
  accessPoints: AccessPointSummary[];
}

interface PlanDirectoryRow extends Omit<PlanTemplate, "budgetLimits" | "accessPoints"> {
  budgetLimitCount: number;
  accessPointCount: number;
  accessPointNames: string[];
}

interface DirectoryPage<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
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

export interface PlanManagementProps {
  state: PlansUrlState;
  directory: DirectoryPage<PlanDirectoryRow>;
}

export function PlanManagement({
  state,
  directory,
}: PlanManagementProps) {
  const router = useRouter();
  const templates = directory.items;
  const [accessPoints, setAccessPoints] = useState<AccessPointSummary[]>([]);
  const [templateDialogOpen, setTemplateDialogOpen] = useState(false);
  const [sourceTemplate, setSourceTemplate] = useState<PlanTemplate | null>(null);
  const [bulkTemplateDialogOpen, setBulkTemplateDialogOpen] = useState(false);
  const [viewTemplateId, setViewTemplateId] = useState<string | null>(null);
  const [viewTemplate, setViewTemplate] = useState<PlanTemplate | null>(null);
  const initializedDetailId = useRef<string | null>(null);
  const [budgetPage, setBudgetPage] = useState(1);
  const [budgetPageSize, setBudgetPageSize] = useState(20);
  const [accessPage, setAccessPage] = useState(1);
  const [accessPageSize, setAccessPageSize] = useState(20);
  const [versionCreateConfirming, setVersionCreateConfirming] = useState(false);
  const [replacementConfirming, setReplacementConfirming] = useState(false);
  const [replacementTargetPlanId, setReplacementTargetPlanId] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ tone: Tone; text: string } | null>(null);
  const [templateSelection, setTemplateSelection] = useState<RowSelectionState>({});
  const { templateForm, templateDraft, detailForm, detailDraft, setTemplateDescriptionDraft, setTemplateAdminNoteDraft, setTemplateStatusDraft, setTemplateCatalogStatusDraft, setTemplateAccessPointIdsDraft, setTemplateBudgetLimitsDraft, setTemplatePriceDrafts } = usePlanFormControllers({ onCreateTemplate: createTemplate, onEditTemplate: saveTemplateMetadata });
  const { description: templateDescriptionDraft, adminNote: templateAdminNoteDraft, status: templateStatusDraft, catalogStatus: templateCatalogStatusDraft, accessPointIds: templateAccessPointIdsDraft, budgetLimits: templateBudgetLimitsDraft, priceDrafts: templatePriceDrafts } = detailDraft;
  const tokenLimitPreview = useMemo(() => buildPlanTokenLimitPreview({ budgetLimits: templateDraft.budgetLimits }), [templateDraft.budgetLimits]);
  const detailTokenLimitPreview = useMemo(() => buildPlanTokenLimitPreview({ budgetLimits: templateBudgetLimitsDraft }), [templateBudgetLimitsDraft]);
  const createTemplateMutation = useMutation({ mutationFn: createPlanTemplate, retry: false });
  const updateTemplateMutation = useMutation({ mutationFn: updatePlanTemplate, retry: false });
  const replaceCardsMutation = useMutation({ mutationFn: replaceAvailablePlanCards, retry: false });
  const detailQuery = useQuery({
    queryKey: ["owner", "plans", "detail", viewTemplateId ?? "", budgetPage, budgetPageSize, accessPage, accessPageSize],
    queryFn: ({ signal }) => fetchPlanTemplateDetail(viewTemplateId!, budgetPage, budgetPageSize, accessPage, accessPageSize, signal),
    enabled: Boolean(viewTemplateId),
    staleTime: 10_000,
    retry: false,
  });
  const createDialogPresentation = planCreateDialogPresentation(sourceTemplate);
  const selectedTemplateIds = useMemo(() => selectedPlanTemplateIds(templateSelection), [templateSelection]);
  const selectedTemplates = useMemo(() => templates.filter((template) => selectedTemplateIds.has(template.id)), [templates, selectedTemplateIds]);
  const relationsComplete = detailQuery.data?.budgetLimits.totalPages === 1
    && detailQuery.data.accessPoints.totalPages === 1;
  const templateDetailsDirty = viewTemplate
    ? templateDescriptionDraft.trim() !== (viewTemplate.description ?? "")
      || templateAdminNoteDraft.trim() !== (viewTemplate.adminNote ?? "")
      || templateStatusDraft !== viewTemplate.status
      || templateCatalogStatusDraft !== viewTemplate.catalogStatus
      || (relationsComplete && (
        !sameBudgetLimits(templateBudgetLimitsDraft, budgetLimitDraftsFromTemplate(viewTemplate))
        || !sameStringSet(templateAccessPointIdsDraft, viewTemplate.accessPoints.map((accessPoint) => accessPoint.id))
        || hasTemplatePriceDraftChanges(viewTemplate, templateAccessPointIdsDraft, templatePriceDrafts)
      ))
    : false;

  useEffect(() => {
    setTemplateSelection((current) => reconcilePlanTemplateSelection(current, templates));
  }, [templates]);

  useEffect(() => {
    const detail = detailQuery.data;
    if (!detail || !viewTemplateId) return;
    setAccessPoints((current) => mergeAccessPoints(current, detail.accessPoints.items));
    if (initializedDetailId.current === viewTemplateId) return;
    initializedDetailId.current = viewTemplateId;
    const template: PlanTemplate = {
      ...detail.template,
      budgetLimits: detail.budgetLimits.items,
      accessPoints: detail.accessPoints.items,
    };
    setViewTemplate(template);
    setTemplateDescriptionDraft(template.description ?? "");
    setTemplateAdminNoteDraft(template.adminNote ?? "");
    setTemplateStatusDraft(template.status);
    setTemplateCatalogStatusDraft(template.catalogStatus);
    setTemplateAccessPointIdsDraft(template.accessPoints.map((accessPoint) => accessPoint.id));
    setTemplateBudgetLimitsDraft(budgetLimitDraftsFromTemplate(template));
    setTemplatePriceDrafts(priceDraftsFromTemplate(template));
  }, [detailQuery.data, viewTemplateId]);

  async function createTemplate() {
    const durationSeconds = secondsFromDraft(templateDraft.durationValue, templateDraft.durationUnit);
    const purchaseAmount = Number(templateDraft.purchaseAmount);
    const selectedAccessPointIds = uniqueStrings(templateDraft.accessPointIds);
    const validation = validateBudgetLimits(templateDraft.budgetLimits);
    if (!templateDraft.name.trim() || selectedAccessPointIds.length === 0 || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      setNotice({ tone: "bad", text: "Template name, duration, and at least one AccessPoint are required." });
      return;
    }
    if (!Number.isFinite(purchaseAmount) || purchaseAmount < 0) {
      setNotice({ tone: "bad", text: "Purchase amount must be a non-negative number." });
      return;
    }
    if (templateDraft.catalogStatus === "listed" && (templateDraft.billingMode !== "prepaid" || purchaseAmount <= 0 || Math.round(purchaseAmount * 1_000_000) <= 0)) {
      setNotice({ tone: "bad", text: "Listed plans must be prepaid with a positive chargeable unit price." });
      return;
    }
    if (!validation.ok) {
      setNotice({ tone: "bad", text: validation.message });
      return;
    }
    const priceValidation = sourceTemplate
      ? buildCopiedPlanPriceOverrides(sourceTemplate, selectedAccessPointIds, templateDraft.accessPointPriceDrafts, accessPoints)
      : validateTemplatePriceDrafts(null, selectedAccessPointIds, templateDraft.accessPointPriceDrafts, accessPoints);
    if (!priceValidation.ok) {
      setNotice({ tone: "bad", text: priceValidation.message });
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      const created = await createTemplateMutation.mutateAsync({
          ...(sourceTemplate ? { ownerId: sourceTemplate.ownerId, scopeRef: sourceTemplate.scopeRef } : {}),
          name: templateDraft.name.trim(),
          description: templateDraft.description.trim(),
          adminNote: templateDraft.adminNote.trim(),
          billingMode: templateDraft.billingMode,
          purchaseAmount,
          catalogStatus: templateDraft.catalogStatus,
          durationSeconds,
          budgetLimits: validation.payloads,
          accessPointIds: selectedAccessPointIds,
          accessPointPriceOverrides: priceValidation.payloads
      });
      setTemplateSelection({});
      setTemplateDialogOpen(false);
      setSourceTemplate(null);
      templateForm.reset(defaultTemplateDraft());
      setNotice({ tone: "good", text: priceValidation.payloads.length > 0 ? `Created Plan ${created.name} v${created.version} (${created.id}) with ${priceValidation.payloads.length} AccessPoint price override${priceValidation.payloads.length === 1 ? "" : "s"}.` : `Created Plan ${created.name} v${created.version} (${created.id}).` });
      router.refresh();
    } catch (error) {
      setNotice({ tone: "bad", text: messageFromError(error) });
    } finally {
      setSaving(false);
    }
  }

  async function confirmCreatePlanVersion() {
    if (!viewTemplate) return;
    const selectedAccessPointIds = uniqueStrings(templateAccessPointIdsDraft);
    if (selectedAccessPointIds.length === 0) {
      setNotice({ tone: "bad", text: "Select at least one AccessPoint for the new Plan version." });
      return;
    }
    const priceValidation = buildEditedPlanVersionPriceOverrides(viewTemplate, selectedAccessPointIds, templatePriceDrafts, accessPoints);
    if (!priceValidation.ok) {
      setNotice({ tone: "bad", text: priceValidation.message });
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      const created = await createTemplateMutation.mutateAsync(buildEditedPlanVersionCreateInput(viewTemplate, {
        description: templateDescriptionDraft,
        adminNote: templateAdminNoteDraft,
        budgetLimits: templateBudgetLimitsDraft,
        accessPointIds: selectedAccessPointIds
      }, priceValidation.payloads));
      resetTemplateDetails();
      setTemplateSelection({});
      setNotice({ tone: "good", text: `Created Plan version ${created.name} v${created.version} (${created.id}).` });
      router.refresh();
    } catch (error) {
      setNotice({ tone: "bad", text: messageFromError(error) });
    } finally {
      setSaving(false);
    }
  }

  async function saveTemplateMetadata() {
    if (!viewTemplate) return;
    let relationInput: {
      budgetLimits?: PlanBudgetLimit[];
      accessPointIds?: string[];
      accessPointPriceOverrides?: Array<{ accessPointId: string; inputPer1M: number; cachedInputPer1M: number; cacheWritePer1M: number | null; outputPer1M: number; tiers?: Array<{ serviceTier?: string; tierKey: string; minInputTokens: number; maxInputTokens: number | null; inputPer1M: number; cachedInputPer1M: number; cacheWritePer1M: number | null; outputPer1M: number }> }>;
    } = {};
    let priceOverrideCount = 0;
    if (relationsComplete) {
      const selectedAccessPointIds = uniqueStrings(templateAccessPointIdsDraft);
      if (selectedAccessPointIds.length === 0) {
        setNotice({ tone: "bad", text: "Select at least one AccessPoint for this template." });
        return;
      }
      const priceValidation = validateTemplatePriceDrafts(viewTemplate, selectedAccessPointIds, templatePriceDrafts, accessPoints);
      if (!priceValidation.ok) {
        setNotice({ tone: "bad", text: priceValidation.message });
        return;
      }
      const budgetValidation = validateBudgetLimits(templateBudgetLimitsDraft);
      if (!budgetValidation.ok) {
        setNotice({ tone: "bad", text: budgetValidation.message });
        return;
      }
      relationInput = {
        budgetLimits: budgetValidation.payloads,
        accessPointIds: selectedAccessPointIds,
        accessPointPriceOverrides: priceValidation.payloads,
      };
      priceOverrideCount = priceValidation.payloads.length;
    }
    setSaving(true);
    setNotice(null);
    try {
      const updated = await updateTemplateMutation.mutateAsync({
          id: viewTemplate.id,
          description: templateDescriptionDraft,
          adminNote: templateAdminNoteDraft,
          status: templateStatusDraft,
          catalogStatus: templateCatalogStatusDraft,
          ...relationInput,
      });
      const nextTemplate: PlanTemplate = {
        ...viewTemplate,
        ...updated,
        budgetLimits: updated.budgetLimits ?? viewTemplate.budgetLimits,
        accessPoints: updated.accessPoints ?? viewTemplate.accessPoints,
      };
      setViewTemplate(nextTemplate);
      setTemplateDescriptionDraft(nextTemplate.description ?? "");
      setTemplateAdminNoteDraft(nextTemplate.adminNote ?? "");
      setTemplateStatusDraft(nextTemplate.status);
      setTemplateCatalogStatusDraft(nextTemplate.catalogStatus);
      setTemplateAccessPointIdsDraft(nextTemplate.accessPoints.map((accessPoint) => accessPoint.id));
      setTemplateBudgetLimitsDraft(budgetLimitDraftsFromTemplate(nextTemplate));
      setTemplatePriceDrafts(priceDraftsFromTemplate(nextTemplate));
      setNotice({ tone: "good", text: priceOverrideCount > 0 ? `Updated template details and ${priceOverrideCount} AccessPoint price override${priceOverrideCount === 1 ? "" : "s"}.` : "Updated template details." });
      router.refresh();
    } catch (error) {
      if (shouldOfferPlanVersionCreation(error)) {
        setVersionCreateConfirming(true);
        setNotice(null);
      } else {
        setNotice({ tone: "bad", text: messageFromError(error) });
      }
    } finally {
      setSaving(false);
    }
  }

  async function confirmCardReplacement() {
    if (!viewTemplate || !replacementTargetPlanId) return;
    setSaving(true);
    setNotice(null);
    try {
      const result = await replaceCardsMutation.mutateAsync({ sourcePlanId: viewTemplate.id, targetPlanId: replacementTargetPlanId });
      setViewTemplate((current) => current ? { ...current, statusImpact: { ...current.statusImpact, availableCardCount: 0 } } : current);
      setReplacementConfirming(false);
      setReplacementTargetPlanId("");
      setNotice({ tone: "good", text: `Replaced ${result.replacedCount} available Card${result.replacedCount === 1 ? "" : "s"} with target Plan ${result.targetPlanId}.` });
      router.refresh();
    } catch (error) {
      setNotice({ tone: "bad", text: messageFromError(error) });
    } finally {
      setSaving(false);
    }
  }

  function beginCardReplacement() {
    setReplacementTargetPlanId("");
    setReplacementConfirming(true);
    setNotice(null);
  }

  function openTemplateDetails(template: PlanDirectoryRow) {
    setViewTemplate(null);
    setViewTemplateId(template.id);
    setBudgetPage(1);
    setAccessPage(1);
    setReplacementConfirming(false);
    setReplacementTargetPlanId("");
    setVersionCreateConfirming(false);
    setNotice(null);
  }

  function resetTemplateDetails() {
    initializedDetailId.current = null;
    setViewTemplateId(null);
    setViewTemplate(null);
    setTemplateDescriptionDraft("");
    setTemplateAdminNoteDraft("");
    setTemplateStatusDraft("enabled");
    setTemplateCatalogStatusDraft("unlisted");
    setTemplateAccessPointIdsDraft([]);
    setTemplateBudgetLimitsDraft([]);
    setTemplatePriceDrafts({});
    setReplacementConfirming(false);
    setReplacementTargetPlanId("");
    setVersionCreateConfirming(false);
  }

  function closeTemplateDetails() {
    if (saving) return;
    resetTemplateDetails();
  }

  function closeTemplateDialog() {
    if (saving) return;
    setTemplateDialogOpen(false);
    setSourceTemplate(null);
    templateForm.reset(defaultTemplateDraft());
  }

  function openBlankTemplateDialog() {
    setSourceTemplate(null);
    setAccessPoints([]);
    templateForm.reset(defaultTemplateDraft());
    setTemplateSelection({});
    setNotice(null);
    setTemplateDialogOpen(true);
  }

  function openCopiedTemplateDialog(source: PlanTemplate) {
    setSourceTemplate(source);
    setAccessPoints(source.accessPoints);
    templateForm.reset(templateDraftFromTemplate(source), { keepDefaultValues: true });
    setNotice(null);
    setTemplateDialogOpen(true);
  }

  function addBudgetLimit() {
    templateForm.setFieldValue("budgetLimits", (current) => [...current, defaultBudgetLimitDraft(`limit_${Date.now()}_${current.length}`)]);
  }

  function updateBudgetLimit(localId: string, patch: Partial<BudgetLimitDraft>) {
    templateForm.setFieldValue("budgetLimits", (current) => current.map((limit) => limit.localId === localId ? { ...limit, ...patch } : limit));
  }

  function removeBudgetLimit(localId: string) {
    templateForm.setFieldValue("budgetLimits", (current) => current.filter((limit) => limit.localId !== localId));
  }

  function addTemplateBudgetLimit() {
    setTemplateBudgetLimitsDraft((current) => [...current, defaultBudgetLimitDraft(`detail_limit_${Date.now()}_${current.length}`)]);
  }

  function updateTemplateBudgetLimit(localId: string, patch: Partial<BudgetLimitDraft>) {
    setTemplateBudgetLimitsDraft((current) => current.map((limit) => limit.localId === localId ? { ...limit, ...patch } : limit));
  }

  function removeTemplateBudgetLimit(localId: string) {
    setTemplateBudgetLimitsDraft((current) => current.filter((limit) => limit.localId !== localId));
  }

  function addAccessPoint(accessPoint: AccessPointSummary) {
    setAccessPoints((current) => mergeAccessPoints(current, [accessPoint]));
    templateForm.setFieldValue("accessPointIds", (current) => uniqueStrings([...current, accessPoint.id]));
    templateForm.setFieldValue("accessPointPriceDrafts", (current) => ({
      ...current,
      [accessPoint.id]: current[accessPoint.id] ?? emptyPriceDraft(),
    }));
  }

  function removeAccessPoint(accessPointId: string) {
    templateForm.setFieldValue("accessPointIds", (current) => current.filter((id) => id !== accessPointId));
    templateForm.setFieldValue("accessPointPriceDrafts", (current) => omitRecordKey(current, accessPointId));
  }

  function addTemplateAccessPoint(accessPoint: AccessPointSummary) {
    setAccessPoints((current) => mergeAccessPoints(current, [accessPoint]));
    setTemplateAccessPointIdsDraft((current) => uniqueStrings([...current, accessPoint.id]));
    setTemplatePriceDrafts((current) => ({
      ...current,
      [accessPoint.id]: current[accessPoint.id] ?? emptyPriceDraft(),
    }));
  }

  function removeTemplateAccessPoint(accessPointId: string) {
    setTemplateAccessPointIdsDraft((current) => current.filter((id) => id !== accessPointId));
    setTemplatePriceDrafts((current) => omitRecordKey(current, accessPointId));
  }

  function updateTemplatePriceDraft(accessPointId: string, patch: Partial<PriceDraft>) {
    setTemplatePriceDrafts((current) => ({
      ...current,
      [accessPointId]: { ...emptyPriceDraft(), ...(current[accessPointId] ?? {}), ...patch }
    }));
  }

  function updateTemplateDraftPriceDraft(accessPointId: string, patch: Partial<PriceDraft>) {
    templateForm.setFieldValue("accessPointPriceDrafts", (current) => ({
      ...current,
      [accessPointId]: { ...emptyPriceDraft(), ...(current[accessPointId] ?? {}), ...patch }
    }));
  }

  const templateColumns = createPlanTemplateColumns(openTemplateDetails);
  return (
    <>
      <PageHeading
        eyebrow="Plans & Budgets"
        title="Plans"
        description="Manage Plan templates, versions, and commercial terms."
      >
        <Button type="button" variant="secondary" onClick={openBlankTemplateDialog} disabled={saving}>
          Create Plan
        </Button>
      </PageHeading>

      {notice && !templateDialogOpen && !bulkTemplateDialogOpen && !viewTemplate ? (
        <div className={`notice-box notice-${notice.tone}`} role="status">
          {notice.text}
        </div>
      ) : null}

      <Card className="panel">
        <div className="panel-heading">
          <div>
            <h2>Plan Templates</h2>
            <p className="muted">Template edits update current configuration and affect attached plan records.</p>
          </div>
          <form className="directory-tools" action="/owner/plans-and-budgets/plans">
            {state.pageSize !== 20 ? <input type="hidden" name="pageSize" value={state.pageSize} /> : null}
            <label className="search-field"><span className="search-icon">S</span><Input name="q" defaultValue={state.query} placeholder="Search Plans" /></label>
            <SearchSelect name="status" defaultValue={state.status} searchable={false} options={[
              { value: "all", label: "All statuses" },
              { value: "enabled", label: "Enabled" },
              { value: "closed", label: "Closed" },
              { value: "disabled", label: "Disabled" },
            ]} />
            <Button type="submit" variant="secondary">Search</Button>
          </form>
          <div className="row-actions">
            <StatusBadge tone="info">{directory.total} templates</StatusBadge>
          </div>
        </div>
        <div className="compact-table">
          <DataTable
            serverManaged
            data={templates}
            columns={templateColumns}
            getRowId={stablePlanTemplateRowId}
            emptyState={{ title: "No Plans", description: "Create a Plan and configure its private limits." }}
            state={{ rowSelection: templateSelection }}
            onStateChange={{ rowSelection: setTemplateSelection }}
            selection={{
              selectedLabel: "plan template",
              bulkAction: { onClick: () => setBulkTemplateDialogOpen(true) }
            }}
          />
          <MaterialTablePagination
            page={directory.page}
            pageSize={directory.pageSize}
            total={directory.total}
            totalPages={directory.totalPages}
            rangeStart={directory.total ? (directory.page - 1) * directory.pageSize + 1 : 0}
            rangeEnd={Math.min(directory.page * directory.pageSize, directory.total)}
            previousHref={directory.page > 1 ? plansHref({ ...state, page: directory.page - 1 }) : ""}
            nextHref={directory.page < directory.totalPages ? plansHref({ ...state, page: directory.page + 1 }) : ""}
            noun="plan templates"
          />
        </div>
      </Card>

      {bulkTemplateDialogOpen ? (
        <BulkPlanTemplatesDialog
          templates={selectedTemplates}
          onClose={() => setBulkTemplateDialogOpen(false)}
          onSaved={(updatedTemplates) => {
            setBulkTemplateDialogOpen(false);
            setTemplateSelection({});
            setNotice({ tone: "good", text: `Updated ${updatedTemplates.length} plan templates.` });
          }}
        />
      ) : null}

      {viewTemplateId && !viewTemplate ? (
        <AdminDialog observabilityKey="plan-template-loading" titleId="plan-template-loading-dialog-title" eyebrow="Plan Template" title="Loading Plan" description="Loading bounded detail pages" onClose={closeTemplateDetails}>
          {detailQuery.error ? <div className="notice-box notice-bad" role="alert">{detailQuery.error instanceof Error ? detailQuery.error.message : "Unable to load Plan details."}</div> : <div className="empty-inline">Loading Plan details…</div>}
        </AdminDialog>
      ) : null}

      {viewTemplate ? (
        <AdminDialog
          observabilityKey="plan-template-view"
          titleId="plan-template-view-dialog-title"
          eyebrow="Plan Template"
          title={`${viewTemplate.name} v${viewTemplate.version}`}
          description="Template version details"
          onClose={closeTemplateDetails}
          closeDisabled={saving}
        >
          <div className="detail-list">
            <div><span>ID</span><code>{viewTemplate.id}</code></div>
            <div><span>Owner</span><code>{viewTemplate.ownerId}</code></div>
            <div><span>Scope</span><code>{viewTemplate.scopeRef}</code></div>
            <div><span>Name</span><strong>{viewTemplate.name}</strong></div>
            <div><span>Version</span><strong>{viewTemplate.version}</strong></div>
            <div><span>Billing</span><strong>{viewTemplate.billingMode === "paygo" ? "PayGo" : "Prepaid"}</strong></div>
            <div><span>Catalog</span><strong>{viewTemplate.catalogStatus === "listed" ? "Listed" : "Unlisted"}</strong></div>
            <div><span>Unit Price</span><strong>{formatCurrency(viewTemplate.purchaseAmount)}</strong></div>
            <div><span>Duration</span><strong>{formatPlanDuration(viewTemplate)}</strong></div>
            <div><span>Created</span><strong>{formatDateTime(viewTemplate.createdAt)}</strong></div>
            <div><span>Updated</span><strong>{formatDateTime(viewTemplate.updatedAt)}</strong></div>
          </div>
          <label className="template-description-editor">
            Status
            <SearchSelect value={templateStatusDraft} onValueChange={(nextValue) => { setTemplateStatusDraft(nextValue); if (nextValue !== "enabled") setTemplateCatalogStatusDraft("unlisted"); }} disabled={saving} searchable={false} options={[
              { value: "enabled", label: "Enabled" },
              ...(viewTemplate.status === "disabled" ? [] : [{ value: "closed", label: "Closed" }]),
              ...(viewTemplate.status === "enabled" ? [] : [{ value: "disabled", label: "Disabled" }])
            ]} />
            <span>Closed stops new sales, subscriptions, and Plan Card sends while existing subscriptions and the current Card holder keep their rights.</span>
          </label>
          <label className="template-description-editor">
            User Catalog
            <SearchSelect value={templateCatalogStatusDraft} onValueChange={setTemplateCatalogStatusDraft} disabled={saving || templateStatusDraft !== "enabled"} searchable={false} options={[{ value: "unlisted", label: "Unlisted" }, { value: "listed", label: "Listed" }]} />
            <span>Unlisted only exits direct user sales; authorized Admin grants, rewards, and Partner fulfillment may still use an enabled Plan.</span>
          </label>
          {viewTemplate.status === "closed" && templateStatusDraft === "disabled" ? (
            <div className="notice-box notice-warn">Disable requires 0 available Plan Cards and 0 active/future Subscriptions. Current snapshot: {viewTemplate.statusImpact.availableCardCount} Card(s), {viewTemplate.statusImpact.activeOrFutureSubscriptionCount} Subscription(s). The server checks again when saving.</div>
          ) : null}
          {viewTemplate.status === "closed" && viewTemplate.billingMode === "prepaid" && viewTemplate.statusImpact.availableCardCount > 0 ? (
            <div className="template-rule-section">
              <div className="template-rule-heading">
                <div>
                  <strong>Replace available Cards</strong>
                  <p className="muted">Move every currently available Card for this closed Plan to one compatible newer version.</p>
                </div>
                <StatusBadge tone="warn">{viewTemplate.statusImpact.availableCardCount} affected</StatusBadge>
              </div>
              {replacementConfirming ? (
                <>
                  <label className="template-description-editor">
                    Target version
                    <RemotePlanReplacementSelect sourcePlanId={viewTemplate.id} value={replacementTargetPlanId} onChange={setReplacementTargetPlanId} disabled={saving} />
                    <span>The target must be an enabled prepaid higher version with the same Plan name, owner, and scope.</span>
                  </label>
                  <div className="notice-box notice-warn">
                    This will make all {viewTemplate.statusImpact.availableCardCount} source Card(s) unusable by creating replacement Cards for their current owners. The operation is immediate and cannot be undone.
                  </div>
                  <div className="drawer-actions">
                    <Button type="button" variant="secondary" onClick={() => { setReplacementConfirming(false); setReplacementTargetPlanId(""); }} disabled={saving}>Cancel</Button>
                    <Button type="button" variant="warning" onClick={() => void confirmCardReplacement()} disabled={saving || !replacementTargetPlanId}>
                      {saving ? "Replacing..." : `Replace ${viewTemplate.statusImpact.availableCardCount} Card(s)`}
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <Button type="button" variant="warning" onClick={beginCardReplacement} disabled={saving || templateDetailsDirty}>Replace available Cards</Button>
                </>
              )}
            </div>
          ) : null}
          <label className="template-description-editor">
            Description
            <Textarea value={templateDescriptionDraft} onChange={(event) => setTemplateDescriptionDraft(event.target.value)} disabled={saving} />
            <span>Changing status, description, or admin note does not create a new template version.</span>
          </label>
          <label className="template-description-editor">
            Admin Note
            <Textarea value={templateAdminNoteDraft} onChange={(event) => setTemplateAdminNoteDraft(event.target.value)} disabled={saving} />
            <span>Visible only in Admin template management.</span>
          </label>
          {!relationsComplete ? <div className="notice-box notice-warn">This Plan has more than 50 Budget Limits or AccessPoint relations. Relations are shown in independent pages and remain read-only here; metadata and lifecycle fields can still be saved safely.</div> : null}
          <PlanTemplateAccessPointEditor
            accessPoints={relationsComplete ? accessPoints : detailQuery.data?.accessPoints.items ?? []}
            selectedAccessPointIds={relationsComplete ? templateAccessPointIdsDraft : detailQuery.data?.accessPoints.items.map((item) => item.id) ?? []}
            priceDrafts={templatePriceDrafts}
            mode="edit"
            disabled={saving || !relationsComplete}
            templateAccessPoints={relationsComplete ? viewTemplate.accessPoints : detailQuery.data?.accessPoints.items ?? []}
            onAddAccessPoint={addTemplateAccessPoint}
            onRemoveAccessPoint={removeTemplateAccessPoint}
            onPriceDraftChange={updateTemplatePriceDraft}
          />
          {detailQuery.data ? <MaterialTablePagination
            page={detailQuery.data.accessPoints.page}
            pageSize={detailQuery.data.accessPoints.pageSize}
            total={detailQuery.data.accessPoints.total}
            totalPages={detailQuery.data.accessPoints.totalPages}
            {...(detailQuery.data.accessPoints.page > 1 ? { onPrevious: () => setAccessPage((current) => current - 1) } : {})}
            {...(detailQuery.data.accessPoints.page < detailQuery.data.accessPoints.totalPages ? { onNext: () => setAccessPage((current) => current + 1) } : {})}
            onPageSizeChange={(pageSize) => { setAccessPage(1); setAccessPageSize(pageSize); }}
            noun="Plan AccessPoint relations"
          /> : null}
          <BudgetLimitsEditor limits={relationsComplete ? templateBudgetLimitsDraft : pagedBudgetLimitDrafts(viewTemplate, detailQuery.data?.budgetLimits.items ?? [])} disabled={saving || !relationsComplete} onAdd={addTemplateBudgetLimit} onRemove={removeTemplateBudgetLimit} onChange={updateTemplateBudgetLimit} />
          {detailQuery.data ? <MaterialTablePagination
            page={detailQuery.data.budgetLimits.page}
            pageSize={detailQuery.data.budgetLimits.pageSize}
            total={detailQuery.data.budgetLimits.total}
            totalPages={detailQuery.data.budgetLimits.totalPages}
            {...(detailQuery.data.budgetLimits.page > 1 ? { onPrevious: () => setBudgetPage((current) => current - 1) } : {})}
            {...(detailQuery.data.budgetLimits.page < detailQuery.data.budgetLimits.totalPages ? { onNext: () => setBudgetPage((current) => current + 1) } : {})}
            onPageSizeChange={(pageSize) => { setBudgetPage(1); setBudgetPageSize(pageSize); }}
            noun="Plan Budget Limits"
          /> : null}
          {relationsComplete ? <PlanTokenLimitPreview preview={detailTokenLimitPreview} /> : null}
          <ConsoleDialogFooter feedback={notice ? <div className={`notice-box notice-${notice.tone}`} role={notice.tone === "bad" ? "alert" : "status"}>{notice.text}</div> : null}>
            <Button type="button" variant="secondary" onClick={() => { const source = viewTemplate; closeTemplateDetails(); openCopiedTemplateDialog(source); }} disabled={saving || !relationsComplete}>Create from copy</Button>
            <Button type="button" variant="secondary" onClick={() => { closeTemplateDetails(); openBlankTemplateDialog(); }} disabled={saving}>Create Plan</Button>
            <Button type="button" variant="secondary" onClick={() => { setNotice(null); setVersionCreateConfirming(true); }} disabled={saving || !relationsComplete}>Create version</Button>
            <Button type="button" variant="secondary" onClick={closeTemplateDetails} disabled={saving}>Done</Button>
            <Button type="button" onClick={() => void detailForm.handleSubmit()} disabled={saving || !templateDetailsDirty}>
              {saving ? "Saving..." : "Save Changes"}
            </Button>
          </ConsoleDialogFooter>
        </AdminDialog>
      ) : null}

      {versionCreateConfirming && viewTemplate ? (
        <AdminDialog
          observabilityKey="plan-version-create-confirmation"
          titleId="plan-version-create-confirm-title"
          eyebrow="Plans"
          title={PLAN_VERSION_CONFIRM_TITLE}
          description={`Create a new version of ${viewTemplate.name} from the current edited values.`}
          onClose={() => { if (!saving) setVersionCreateConfirming(false); }}
          closeDisabled={saving}
        >
          <div className="notice-box notice-warn">
            The new version will use the current edited values and default to Unlisted. The existing version remains unchanged.
          </div>
          <ConsoleDialogFooter feedback={notice ? <div className={`notice-box notice-${notice.tone}`} role={notice.tone === "bad" ? "alert" : "status"}>{notice.text}</div> : null}>
            <Button type="button" variant="secondary" onClick={() => setVersionCreateConfirming(false)} disabled={saving}>Continue editing</Button>
            <Button type="button" onClick={() => void confirmCreatePlanVersion()} disabled={saving}>
              {saving ? "Creating..." : "Create version"}
            </Button>
          </ConsoleDialogFooter>
        </AdminDialog>
      ) : null}

      {templateDialogOpen ? (
        <AdminDialog observabilityKey="plan-template-editor" titleId="plan-template-dialog-title" eyebrow="Plans" title={createDialogPresentation.title} description={createDialogPresentation.description} onClose={closeTemplateDialog} closeDisabled={saving}>
          <form onSubmit={(event) => { event.preventDefault(); void templateForm.handleSubmit(); }}>
            <div className="form-grid single">
              {sourceTemplate ? <div className="notice-box">Copied from <strong>{sourceTemplate.name} v{sourceTemplate.version}</strong> <code>{sourceTemplate.id}</code></div> : null}
              <label>Name<Input value={templateDraft.name} readOnly={createDialogPresentation.nameReadOnly} onChange={(event) => templateForm.setFieldValue("name", event.target.value)} /></label>
              <label>Description<Input value={templateDraft.description} onChange={(event) => templateForm.setFieldValue("description", event.target.value)} /></label>
              <label>Admin Note<Textarea value={templateDraft.adminNote} onChange={(event) => templateForm.setFieldValue("adminNote", event.target.value)} /></label>
              <label>
                Billing Mode
                <SearchSelect value={templateDraft.billingMode} onValueChange={(nextValue) => {
                  const billingMode = nextValue as "prepaid" | "paygo";
                  templateForm.setFieldValue("billingMode", billingMode);
                  templateForm.setFieldValue("noDurationLimit", false);
                }} searchable={false} options={[{ value: "prepaid", label: "Prepaid / included" }, { value: "paygo", label: "PayGo" }]} />
                <span>Prepaid consumes plan quota only; PayGo charges the requesting user balance per request.</span>
              </label>
              <label>
                Unit Price
                <Input inputMode="decimal" value={templateDraft.purchaseAmount} onChange={(event) => templateForm.setFieldValue("purchaseAmount", event.target.value)} />
                <span>One subscription unit covers exactly this template duration.</span>
              </label>
              <label>
                User Catalog
                <SearchSelect value={templateDraft.catalogStatus} onValueChange={(nextValue) => templateForm.setFieldValue("catalogStatus", nextValue as "listed" | "unlisted")} searchable={false} options={[{ value: "unlisted", label: "Unlisted" }, { value: "listed", label: "Listed" }]} />
                <span>New and copied Plans default to Unlisted. Listed means visible and directly purchasable in the user store.</span>
              </label>
              <div className="form-grid">
                <label>
                  Duration
                  <Input inputMode="decimal" value={templateDraft.durationValue} onChange={(event) => templateForm.setFieldValue("durationValue", event.target.value)} />
                </label>
                <label>
                  Duration Unit
                  <SearchSelect value={templateDraft.durationUnit} onValueChange={(nextValue) => templateForm.setFieldValue("durationUnit", nextValue as DurationUnit)} searchable={false} options={[{ value: "seconds", label: "Seconds" }, { value: "hours", label: "Hours" }, { value: "days", label: "Days" }, { value: "years", label: "Years" }]} />
                </label>
              </div>
              <div className="notice-box">Plan duration is the real Subscription usage and budget lifecycle. Seller revenue remains frozen on independent fixed 30-day settlement windows.</div>
              <PlanTemplateAccessPointEditor
                accessPoints={accessPoints}
                selectedAccessPointIds={templateDraft.accessPointIds}
                priceDrafts={templateDraft.accessPointPriceDrafts}
                mode="create"
                disabled={saving}
                {...(sourceTemplate ? { templateAccessPoints: sourceTemplate.accessPoints } : {})}
                onAddAccessPoint={addAccessPoint}
                onRemoveAccessPoint={removeAccessPoint}
                onPriceDraftChange={updateTemplateDraftPriceDraft}
              />
              <BudgetLimitsEditor limits={templateDraft.budgetLimits} disabled={saving} onAdd={addBudgetLimit} onRemove={removeBudgetLimit} onChange={updateBudgetLimit} />
              <PlanTokenLimitPreview preview={tokenLimitPreview} />
            </div>
            <ConsoleDialogFooter feedback={notice ? <div className={`notice-box notice-${notice.tone}`} role={notice.tone === "bad" ? "alert" : "status"}>{notice.text}</div> : null}>
              <Button type="button" variant="secondary" onClick={closeTemplateDialog} disabled={saving}>Discard</Button>
              <Button type="submit" disabled={saving}>{saving ? "Creating..." : createDialogPresentation.submitLabel}</Button>
            </ConsoleDialogFooter>
          </form>
        </AdminDialog>
      ) : null}

    </>
  );
}

function mergeAccessPoints(current: AccessPointSummary[], next: AccessPointSummary[]) {
  return [...new Map([...current, ...next].map((accessPoint) => [accessPoint.id, accessPoint])).values()];
}

function pagedBudgetLimitDrafts(template: PlanTemplate, limits: PlanBudgetLimit[]) {
  return budgetLimitDraftsFromTemplate({ ...template, budgetLimits: limits });
}
