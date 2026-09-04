"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "@admin/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@frely/ui/components/button";
import { Card } from "@frely/ui/components/card";
import { Input } from "@frely/ui/components/input";
import { MetricCard, PageHeading, StatusBadge } from "../../../pages/owner/_components/ui";
import { SearchSelect } from "../../../pages/owner/_components/search-select";
import {
  createAccessPointPrice,
  createProviderModelCost,
  disableAccessPointPrice,
  disableProviderModelCost,
  loadProviderCandidates,
  loadOpenAiReferencePrices as fetchOpenAiReferencePrices,
} from "../api/pricing-api";
import { adoptReferenceProfile, createPriceDraftFromEnabled, fillSupportedDraftFromReference } from "../form/price-draft";
import type { PriceDraft } from "../form/price-draft";
import { pricingKeys } from "../query/pricing-query";
import { pricingWorkbenchHref } from "../lib/pricing-url-state";
import { AccessPointPriceWorkbenchTable, MaterialWorkbenchPagination, ProviderCostWorkbenchTable } from "./pricing-tables";
import {
  buildReferencePriceMap,
  countChangedDrafts,
  fillAccessPointDraftsFromTargetCosts,
  filterProviderCostRows,
  fillProviderDraftsFromReference,
  formatCurrency,
  normalizeModelName,
  numericPricePayload,
  validMarkupPercent,
} from "../table/pricing-workbench";
import type {
  AccessPointPriceWorkbenchInitialRow,
  AccessPointPriceWorkbenchRow,
  OpenAiReferencePrice,
  OwnerProfitSummary,
  Provider,
  ProviderCostWorkbenchInitialRow,
  ProviderCostWorkbenchRow,
  PricingWorkbenchPage,
  PricingWorkbenchState,
  ReferenceFilter,
  Tone,
} from "../types";

export function PricingView({
  initialState,
  initialProviderRows,
  initialProviderPage,
  initialAccessPointRows,
  initialAccessPointPage,
  initialSelectedProvider,
  initialProviderModelCount,
  initialMissingProviderCostCount,
  initialAccessPointCount,
  initialMissingAccessPointPriceCount,
  initialGlobalOwnerProfit,
}: {
  initialState: PricingWorkbenchState;
  initialProviderRows: ProviderCostWorkbenchInitialRow[];
  initialProviderPage: PricingWorkbenchPage;
  initialAccessPointRows: AccessPointPriceWorkbenchInitialRow[];
  initialAccessPointPage: PricingWorkbenchPage;
  initialSelectedProvider: Provider | null;
  initialProviderModelCount: number;
  initialMissingProviderCostCount: number;
  initialAccessPointCount: number;
  initialMissingAccessPointPriceCount: number;
  initialGlobalOwnerProfit: OwnerProfitSummary;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const navigate = useCallback((changes: Record<string, string | null>) => {
    router.replace(pricingWorkbenchHref(searchParams.toString(), changes));
  }, [router, searchParams]);
  const referenceQuery = useQuery({
    queryKey: pricingKeys.reference(),
    queryFn: ({ signal }) => fetchOpenAiReferencePrices(signal),
    enabled: false,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const openAiReferencePrices = referenceQuery.data ?? null;
  const [providerCandidateSearch, setProviderCandidateSearch] = useState("");
  const [providerCandidatePage, setProviderCandidatePage] = useState(1);
  const providerCandidates = useQuery({
    queryKey: pricingKeys.providerCandidates(providerCandidateSearch, providerCandidatePage),
    queryFn: ({ signal }) => loadProviderCandidates(providerCandidateSearch, providerCandidatePage, signal),
    staleTime: 15_000,
    retry: false,
  });
  const [providerDrafts, setProviderDrafts] = useState<Record<string, PriceDraft>>({});
  const [accessPointDrafts, setAccessPointDrafts] = useState<Record<string, PriceDraft>>({});
  const [selectedProviderRows, setSelectedProviderRows] = useState<Set<string>>(() => new Set());
  const [selectedAccessPointRows, setSelectedAccessPointRows] = useState<Set<string>>(() => new Set());
  const [providerReferenceFilter, setProviderReferenceFilter] = useState<ReferenceFilter>("all");
  const [providerSearch, setProviderSearch] = useState(initialState.providerQuery);
  const [accessPointSearch, setAccessPointSearch] = useState(initialState.accessPointQuery);
  const [providerMarkupPercent, setProviderMarkupPercent] = useState("0");
  const [accessPointMarkupPercent, setAccessPointMarkupPercent] = useState("0");
  const [notice, setNotice] = useState<{ tone: Tone; text: string } | null>(null);
  const [referenceErrorToast, setReferenceErrorToast] = useState<string | null>(null);
  useEffect(() => {
    if (!referenceErrorToast) return;
    const timeout = window.setTimeout(() => setReferenceErrorToast(null), 8_000);
    return () => window.clearTimeout(timeout);
  }, [referenceErrorToast]);
  useEffect(() => {
    if (providerSearch === initialState.providerQuery) return;
    const timeout = window.setTimeout(() => navigate({ providerQuery: providerSearch || null, providerPage: null }), 350);
    return () => window.clearTimeout(timeout);
  }, [providerSearch, initialState.providerQuery, navigate]);
  useEffect(() => {
    if (accessPointSearch === initialState.accessPointQuery) return;
    const timeout = window.setTimeout(() => navigate({ accessQuery: accessPointSearch || null, accessPage: null }), 350);
    return () => window.clearTimeout(timeout);
  }, [accessPointSearch, initialState.accessPointQuery, navigate]);
  const createProviderCostsMutation = useMutation({
    mutationFn: async (rows: ProviderCostWorkbenchRow[]) =>
      Promise.all(
        rows.map(async (row) => {
          const payload = numericPricePayload(row.draft);
          if (!payload) throw new Error(`${row.providerModelName} has incomplete draft prices`);
          return createProviderModelCost({
            providerId: row.providerId,
            providerModelName: row.providerModelName,
            ...payload,
          });
        }),
      ),
    retry: false,
  });
  const createAccessPointPricesMutation = useMutation({
    mutationFn: async (rows: AccessPointPriceWorkbenchRow[]) =>
      Promise.all(
        rows.map(async (row) => {
          const payload = numericPricePayload(row.draft);
          if (!payload) throw new Error(`${row.name} has incomplete draft prices`);
          return createAccessPointPrice({ accessPointId: row.id, ...payload });
        }),
      ),
    retry: false,
  });
  const disableProviderCostsMutation = useMutation({
    mutationFn: (rows: ProviderCostWorkbenchRow[]) => Promise.all(rows.map((row) => disableProviderModelCost(row.enabledCost!.id))),
    retry: false,
  });
  const disableAccessPointPricesMutation = useMutation({
    mutationFn: (rows: AccessPointPriceWorkbenchRow[]) => Promise.all(rows.map((row) => disableAccessPointPrice(row.enabledPrice!.id))),
    retry: false,
  });

  const referenceByModel = useMemo(
    () => (openAiReferencePrices ? buildReferencePriceMap(openAiReferencePrices.items) : new Map<string, OpenAiReferencePrice>()),
    [openAiReferencePrices],
  );

  const providerRows = useMemo<ProviderCostWorkbenchRow[]>(() => {
    return initialProviderRows.map((model) => {
      const referencePrice =
        referenceByModel.get(normalizeModelName(model.providerModelName)) ?? referenceByModel.get(normalizeModelName(model.displayName)) ?? null;
      return {
        ...model,
        referencePrice,
        draft: providerDrafts[model.id] ?? createPriceDraftFromEnabled(model.enabledCost ?? undefined),
      };
    });
  }, [initialProviderRows, providerDrafts, referenceByModel]);

  const visibleProviderRows = useMemo(() => {
    return filterProviderCostRows(providerRows, {
      providerId: "all",
      modelStatus: "all",
      price: "all",
      reference: providerReferenceFilter,
      search: "",
    });
  }, [providerReferenceFilter, providerRows]);

  const accessPointRows = useMemo<AccessPointPriceWorkbenchRow[]>(() => {
    return initialAccessPointRows.map((accessPoint) => {
      return {
        ...accessPoint,
        draft: accessPointDrafts[accessPoint.id] ?? createPriceDraftFromEnabled(accessPoint.enabledPrice ?? undefined),
      };
    });
  }, [accessPointDrafts, initialAccessPointRows]);
  const visibleAccessPointRows = accessPointRows;

  const selectedVisibleProviderRows = visibleProviderRows.filter((row) => selectedProviderRows.has(row.id));
  const selectedVisibleAccessPointRows = visibleAccessPointRows.filter((row) => selectedAccessPointRows.has(row.id));
  const creatableSelectedProviderRows = selectedVisibleProviderRows.filter((row) => numericPricePayload(row.draft));
  const creatableSelectedAccessPointRows = selectedVisibleAccessPointRows.filter((row) => numericPricePayload(row.draft));
  const enabledSelectedProviderRows = selectedVisibleProviderRows.filter((row) => row.enabledCost);
  const enabledSelectedAccessPointRows = selectedVisibleAccessPointRows.filter((row) => row.enabledPrice);
  const providerOptions = [
    { value: "all", label: "All providers" },
    ...new Map(
      [initialSelectedProvider, ...(providerCandidates.data?.items ?? [])]
        .filter((provider): provider is Provider => provider !== null)
        .map((provider) => [provider.id, { value: provider.id, label: provider.name, description: provider.id }]),
    ).values(),
  ];

  async function loadOpenAiReferencePrices() {
    setNotice(null);
    try {
      const result = await referenceQuery.refetch();
      if (result.error) throw result.error;
      const reference = result.data;
      if (!reference) throw new Error("Load OpenAI reference prices failed");
      setNotice({
        tone: "good",
        text: `Loaded ${reference.items.length} OpenAI reference prices as candidates. Draft values and profile structure were not changed.`,
      });
    } catch (error) {
      const message = messageFromError(error);
      setNotice({ tone: "bad", text: message });
      setReferenceErrorToast(message);
    }
  }

  function fillVisibleProviderDraftsFromReference() {
    if (!openAiReferencePrices) {
      setNotice({
        tone: "bad",
        text: "Reference prices must be loaded first.",
      });
      return;
    }
    const markup = validMarkupPercent(providerMarkupPercent);
    if (markup === null) {
      setNotice({
        tone: "bad",
        text: "A valid Provider markup percentage is required.",
      });
      return;
    }
    const visibleIds = new Set(visibleProviderRows.map((row) => row.id));
    const next = fillProviderDraftsFromReference(providerRows, referenceByModel, markup, providerDrafts, visibleIds);
    setProviderDrafts(next);
    setNotice({
      tone: "good",
      text: `Filled ${countChangedDrafts(providerDrafts, next)} visible provider rows from reference prices.`,
    });
  }

  function fillSelectedProviderDraftsFromReference() {
    if (!openAiReferencePrices) {
      setNotice({
        tone: "bad",
        text: "Reference prices must be loaded first.",
      });
      return;
    }
    const markup = validMarkupPercent(providerMarkupPercent);
    if (markup === null) {
      setNotice({
        tone: "bad",
        text: "A valid Provider markup percentage is required.",
      });
      return;
    }
    const next = fillProviderDraftsFromReference(providerRows, referenceByModel, markup, providerDrafts, selectedProviderRows);
    setProviderDrafts(next);
    setNotice({
      tone: "good",
      text: `Filled ${countChangedDrafts(providerDrafts, next)} selected provider rows from reference prices.`,
    });
  }

  function suggestVisibleAccessPointDrafts() {
    const markup = validMarkupPercent(accessPointMarkupPercent);
    if (markup === null) {
      setNotice({
        tone: "bad",
        text: "A valid AccessPoint markup percentage is required.",
      });
      return;
    }
    const visibleIds = new Set(visibleAccessPointRows.map((row) => row.id));
    const next = fillAccessPointDraftsFromTargetCosts(accessPointRows, markup, accessPointDrafts, visibleIds);
    setAccessPointDrafts(next);
    setNotice({
      tone: "good",
      text: `Filled ${countChangedDrafts(accessPointDrafts, next)} visible AccessPoint rows from direct target costs.`,
    });
  }

  function suggestSelectedAccessPointDrafts() {
    const markup = validMarkupPercent(accessPointMarkupPercent);
    if (markup === null) {
      setNotice({
        tone: "bad",
        text: "A valid AccessPoint markup percentage is required.",
      });
      return;
    }
    const next = fillAccessPointDraftsFromTargetCosts(accessPointRows, markup, accessPointDrafts, selectedAccessPointRows);
    setAccessPointDrafts(next);
    setNotice({
      tone: "good",
      text: `Filled ${countChangedDrafts(accessPointDrafts, next)} selected AccessPoint rows from direct target costs.`,
    });
  }

  function suggestAccessPointDraft(row: AccessPointPriceWorkbenchRow) {
    const markup = validMarkupPercent(accessPointMarkupPercent);
    if (markup === null) {
      setNotice({
        tone: "bad",
        text: "A valid AccessPoint markup percentage is required.",
      });
      return;
    }
    const next = fillAccessPointDraftsFromTargetCosts(accessPointRows, markup, accessPointDrafts, new Set([row.id]));
    setAccessPointDrafts(next);
    setNotice({
      tone: "good",
      text: `Filled ${row.name} from its direct target cost.`,
    });
  }

  async function createSelectedProviderCosts() {
    await createProviderCosts(creatableSelectedProviderRows);
  }

  async function createSelectedAccessPointPrices() {
    await createAccessPointPrices(creatableSelectedAccessPointRows);
  }

  async function createProviderCosts(rows: ProviderCostWorkbenchRow[]) {
    if (rows.length === 0) {
      setNotice({
        tone: "bad",
        text: "Select at least one provider row with complete draft prices.",
      });
      return;
    }
    setNotice(null);
    try {
      const savedCosts = await createProviderCostsMutation.mutateAsync(rows);
      setSelectedProviderRows(new Set());
      setNotice({
        tone: "good",
        text: `Created ${savedCosts.length} provider model cost records.`,
      });
      router.refresh();
    } catch (error) {
      setNotice({ tone: "bad", text: messageFromError(error) });
    }
  }

  async function createAccessPointPrices(rows: AccessPointPriceWorkbenchRow[]) {
    if (rows.length === 0) {
      setNotice({
        tone: "bad",
        text: "Select at least one AccessPoint row with complete draft prices.",
      });
      return;
    }
    setNotice(null);
    try {
      const savedPrices = await createAccessPointPricesMutation.mutateAsync(rows);
      setSelectedAccessPointRows(new Set());
      setNotice({
        tone: "good",
        text: `Created ${savedPrices.length} AccessPoint price records.`,
      });
      router.refresh();
    } catch (error) {
      setNotice({ tone: "bad", text: messageFromError(error) });
    }
  }

  async function disableSelectedProviderCosts() {
    const rows = enabledSelectedProviderRows;
    if (rows.length === 0) {
      setNotice({
        tone: "bad",
        text: "Select at least one provider row with an enabled cost.",
      });
      return;
    }
    try {
      const updated = await disableProviderCostsMutation.mutateAsync(rows);
      setSelectedProviderRows(new Set());
      setNotice({
        tone: "good",
        text: `Disabled ${updated.length} provider model costs.`,
      });
      router.refresh();
    } catch (error) {
      setNotice({ tone: "bad", text: messageFromError(error) });
    }
  }

  async function disableSelectedAccessPointPrices() {
    const rows = enabledSelectedAccessPointRows;
    if (rows.length === 0) {
      setNotice({
        tone: "bad",
        text: "Select at least one AccessPoint row with an enabled price.",
      });
      return;
    }
    try {
      const updated = await disableAccessPointPricesMutation.mutateAsync(rows);
      setSelectedAccessPointRows(new Set());
      setNotice({
        tone: "good",
        text: `Disabled ${updated.length} AccessPoint prices.`,
      });
      router.refresh();
    } catch (error) {
      setNotice({ tone: "bad", text: messageFromError(error) });
    }
  }

  return (
    <>
      <PageHeading eyebrow="Pricing" title="Pricing" description="Configure upstream provider model costs and AccessPoint billable prices." />

      {notice ? (
        <div className={`notice-box notice-${notice.tone}`} role={notice.tone === "bad" ? "alert" : "status"}>
          {notice.text}
        </div>
      ) : null}

      {referenceErrorToast ? (
        <div className="pricing-error-toast" role="alert" aria-live="assertive">
          <strong>Reference price load failed</strong>
          <span>{referenceErrorToast}</span>
          <button type="button" aria-label="Dismiss error" onClick={() => setReferenceErrorToast(null)}>×</button>
        </div>
      ) : null}

      <section className="metric-grid" aria-label="Pricing metrics">
        <MetricCard
          label="Provider Costs"
          value={String(initialProviderModelCount)}
          detail={`${initialMissingProviderCostCount} enabled catalog models missing enabled cost`}
          tone={initialMissingProviderCostCount > 0 ? "warn" : "good"}
        />
        <MetricCard
          label="AccessPoint Prices"
          value={String(initialAccessPointCount)}
          detail={`${initialMissingAccessPointPriceCount} enabled AccessPoints missing enabled price`}
          tone={initialMissingAccessPointPriceCount > 0 ? "warn" : "good"}
        />
        <MetricCard
          label="Global Owner P&L"
          value={formatCurrency(initialGlobalOwnerProfit.profitAmount)}
          detail={`${formatCurrency(initialGlobalOwnerProfit.salesAmount)} sales - ${formatCurrency(initialGlobalOwnerProfit.sourceCostAmount + initialGlobalOwnerProfit.providerCostAmount)} costs`}
          tone={initialGlobalOwnerProfit.profitAmount >= 0 ? "good" : "warn"}
        />
      </section>

      <Card className="panel">
        <div className="panel-heading">
          <div>
            <h2>Provider Costs</h2>
            <p className="muted">Every Provider model is listed as a pricing target. Draft values create new price records only after confirmation.</p>
          </div>
          <StatusBadge tone={initialMissingProviderCostCount > 0 ? "warn" : "good"}>{initialMissingProviderCostCount} missing</StatusBadge>
        </div>
        <div className="compact-filter-bar" aria-label="Provider cost filters">
          <label className="compact-filter-field" data-size="provider">
            Provider
            <SearchSelect
              value={initialState.providerId}
              onValueChange={(nextValue) => {
                navigate({ provider: nextValue === "all" ? null : nextValue, providerPage: null });
              }}
              onSearchChange={(query) => {
                setProviderCandidateSearch(query);
                setProviderCandidatePage(1);
              }}
              options={providerOptions}
              pagination={{
                page: providerCandidates.data?.page ?? providerCandidatePage,
                totalPages: providerCandidates.data?.totalPages ?? providerCandidatePage,
                pending: providerCandidates.isPending,
                onPageChange: setProviderCandidatePage,
              }}
            />
          </label>
          <label className="compact-filter-field" data-size="status">
            Model Status
            <SearchSelect
              value={initialState.providerModelStatus}
              onValueChange={(nextValue) => {
                navigate({ providerStatus: nextValue === "enabled" ? null : nextValue, providerPage: null });
              }}
              searchable={false}
              options={[{ value: "all", label: "All statuses" }, { value: "enabled", label: "enabled" }, { value: "disabled", label: "disabled" }]}
            />
          </label>
          <label className="compact-filter-field" data-size="price">
            Price
            <SearchSelect
              value={initialState.providerPrice}
              onValueChange={(nextValue) => {
                navigate({ providerPrice: nextValue === "all" ? null : nextValue, providerPage: null });
              }}
              searchable={false}
              options={[{ value: "all", label: "All price states" }, { value: "missing", label: "Missing enabled cost" }, { value: "has-enabled", label: "Has enabled cost" }]}
            />
          </label>
          <label className="compact-filter-field" data-size="reference">
            Reference (current page)
            <SearchSelect
              value={providerReferenceFilter}
              onValueChange={(nextValue) => {
                setProviderReferenceFilter(nextValue as ReferenceFilter);
              }}
              searchable={false}
              options={[{ value: "all", label: "All reference states" }, { value: "matched", label: "Matched reference" }, { value: "unmatched", label: "No reference match" }]}
            />
          </label>
          <label className="compact-filter-field" data-size="model">
            Search
            <Input
              value={providerSearch}
              onChange={(event) => {
                setProviderSearch(event.target.value);
              }}
              placeholder="provider or model"
            />
          </label>
          <label className="compact-filter-field" data-size="markup">
            Markup %
            <Input inputMode="decimal" value={providerMarkupPercent} onChange={(event) => setProviderMarkupPercent(event.target.value)} placeholder="10" />
          </label>
        </div>
        <div className="toolbar access-point-toolbar" aria-label="Provider cost actions">
          <div className="row-actions">
            <StatusBadge tone="info">{visibleProviderRows.length} current-page rows / {initialProviderPage.total} total</StatusBadge>
            {selectedVisibleProviderRows.length > 0 ? <StatusBadge tone="info">{selectedVisibleProviderRows.length} selected</StatusBadge> : null}
            {openAiReferencePrices ? (
              <StatusBadge tone="neutral">reference loaded</StatusBadge>
            ) : referenceQuery.isError ? (
              <StatusBadge tone="warn">reference load failed</StatusBadge>
            ) : (
              <StatusBadge tone="neutral">reference not loaded</StatusBadge>
            )}
          </div>
          <div className="row-actions">
            <Button type="button" variant="outline" onClick={loadOpenAiReferencePrices} disabled={referenceQuery.isFetching}>
              {referenceQuery.isFetching ? "Loading..." : referenceQuery.isError ? "Load Failed — Retry" : "Load Reference Prices"}
            </Button>
            <Button type="button" variant="secondary" onClick={fillVisibleProviderDraftsFromReference} disabled={!openAiReferencePrices}>
              Fill Visible
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={fillSelectedProviderDraftsFromReference}
              disabled={!openAiReferencePrices || selectedVisibleProviderRows.length === 0}
            >
              Fill Selected
            </Button>
            <Button
              type="button"
              onClick={createSelectedProviderCosts}
              disabled={createProviderCostsMutation.isPending || creatableSelectedProviderRows.length === 0}
            >
              {createProviderCostsMutation.isPending ? "Creating..." : `Create ${creatableSelectedProviderRows.length}`}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={disableSelectedProviderCosts}
              disabled={disableProviderCostsMutation.isPending || enabledSelectedProviderRows.length === 0}
            >
              {disableProviderCostsMutation.isPending ? "Updating..." : `Disable ${enabledSelectedProviderRows.length}`}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setSelectedProviderRows(new Set())} disabled={selectedProviderRows.size === 0}>
              Clear
            </Button>
          </div>
        </div>
        <ProviderCostWorkbenchTable
          rows={visibleProviderRows}
          selectedIds={selectedProviderRows}
          onSelectedIdsChange={setSelectedProviderRows}
          onDraftChange={(rowId, draft) => setProviderDrafts((current) => ({ ...current, [rowId]: draft }))}
          onFillReference={(row) => {
            const markup = validMarkupPercent(providerMarkupPercent);
            if (!row.referencePrice || markup === null) {
              setNotice({
                tone: "bad",
                text: markup === null ? "A valid Provider markup percentage is required." : "No reference candidate matches this model.",
              });
              return;
            }
            setProviderDrafts((current) => ({
              ...current,
              [row.id]: fillSupportedDraftFromReference(row.draft, row.referencePrice!, markup),
            }));
          }}
          onAdoptReference={(row) => {
            if (!row.referencePrice) return;
            setProviderDrafts((current) => ({
              ...current,
              [row.id]: adoptReferenceProfile(row.draft, row.referencePrice!),
            }));
          }}
          onCreateRow={(row) => void createProviderCosts([row])}
        />
        <MaterialWorkbenchPagination
          label="Provider costs"
          page={initialProviderPage.page - 1}
          pageCount={initialProviderPage.totalPages}
          pageSize={initialProviderPage.pageSize}
          totalRows={initialProviderPage.total}
          onPageChange={(page) => navigate({ providerPage: page === 0 ? null : String(page + 1) })}
          onPageSizeChange={(pageSize) => navigate({ providerPage: null, providerPageSize: pageSize === 20 ? null : String(pageSize) })}
        />
      </Card>

      <Card className="panel">
        <div className="panel-heading">
          <div>
            <h2>AccessPoint Prices</h2>
            <p className="muted">AccessPoint rows can be suggested from their direct target costs and applied as new billable price records.</p>
          </div>
          <StatusBadge tone={initialMissingAccessPointPriceCount > 0 ? "warn" : "good"}>{initialMissingAccessPointPriceCount} missing</StatusBadge>
        </div>
        <div className="compact-filter-bar" aria-label="AccessPoint price filters">
          <label className="compact-filter-field" data-size="status">
            AccessPoint Status
            <SearchSelect value={initialState.accessPointStatus} onValueChange={(nextValue) => navigate({ accessStatus: nextValue === "enabled" ? null : nextValue, accessPage: null })} searchable={false} options={[{ value: "all", label: "All statuses" }, { value: "enabled", label: "enabled" }, { value: "disabled", label: "disabled" }]} />
          </label>
          <label className="compact-filter-field" data-size="price">
            Target Cost
            <SearchSelect value={initialState.accessPointTargetCost} onValueChange={(nextValue) => navigate({ targetCost: nextValue === "all" ? null : nextValue, accessPage: null })} searchable={false} options={[{ value: "all", label: "All target cost states" }, { value: "missing", label: "Missing enabled target cost" }, { value: "has-enabled", label: "Has enabled target cost" }]} />
          </label>
          <label className="compact-filter-field" data-size="price">
            Price
            <SearchSelect value={initialState.accessPointPrice} onValueChange={(nextValue) => navigate({ accessPrice: nextValue === "all" ? null : nextValue, accessPage: null })} searchable={false} options={[{ value: "all", label: "All price states" }, { value: "missing", label: "Missing enabled price" }, { value: "has-enabled", label: "Has enabled price" }]} />
          </label>
          <label className="compact-filter-field" data-size="model">
            Search
            <Input value={accessPointSearch} onChange={(event) => setAccessPointSearch(event.target.value)} placeholder="access point, scope, target" />
          </label>
          <label className="compact-filter-field" data-size="markup">
            Markup %
            <Input
              inputMode="decimal"
              value={accessPointMarkupPercent}
              onChange={(event) => setAccessPointMarkupPercent(event.target.value)}
              placeholder="20"
            />
          </label>
        </div>
        <div className="toolbar access-point-toolbar" aria-label="AccessPoint price actions">
          <div className="row-actions">
            <StatusBadge tone="info">{visibleAccessPointRows.length} current-page rows / {initialAccessPointPage.total} total</StatusBadge>
            {selectedVisibleAccessPointRows.length > 0 ? <StatusBadge tone="info">{selectedVisibleAccessPointRows.length} selected</StatusBadge> : null}
          </div>
          <div className="row-actions">
            <Button type="button" variant="secondary" onClick={suggestVisibleAccessPointDrafts}>
              Suggest Visible
            </Button>
            <Button type="button" variant="secondary" onClick={suggestSelectedAccessPointDrafts} disabled={selectedVisibleAccessPointRows.length === 0}>
              Suggest Selected
            </Button>
            <Button
              type="button"
              onClick={createSelectedAccessPointPrices}
              disabled={createAccessPointPricesMutation.isPending || creatableSelectedAccessPointRows.length === 0}
            >
              {createAccessPointPricesMutation.isPending ? "Creating..." : `Create ${creatableSelectedAccessPointRows.length}`}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={disableSelectedAccessPointPrices}
              disabled={disableAccessPointPricesMutation.isPending || enabledSelectedAccessPointRows.length === 0}
            >
              {disableAccessPointPricesMutation.isPending ? "Updating..." : `Disable ${enabledSelectedAccessPointRows.length}`}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setSelectedAccessPointRows(new Set())} disabled={selectedAccessPointRows.size === 0}>
              Clear
            </Button>
          </div>
        </div>
        <AccessPointPriceWorkbenchTable
          rows={visibleAccessPointRows}
          selectedIds={selectedAccessPointRows}
          onSelectedIdsChange={setSelectedAccessPointRows}
          onDraftChange={(rowId, draft) => setAccessPointDrafts((current) => ({ ...current, [rowId]: draft }))}
          onSuggestRow={suggestAccessPointDraft}
          onCreateRow={(row) => void createAccessPointPrices([row])}
        />
        <MaterialWorkbenchPagination
          label="AccessPoint prices"
          page={initialAccessPointPage.page - 1}
          pageCount={initialAccessPointPage.totalPages}
          pageSize={initialAccessPointPage.pageSize}
          totalRows={initialAccessPointPage.total}
          onPageChange={(page) => navigate({ accessPage: page === 0 ? null : String(page + 1) })}
          onPageSizeChange={(pageSize) => navigate({ accessPage: null, accessPageSize: pageSize === 20 ? null : String(pageSize) })}
        />
      </Card>
    </>
  );
}

function messageFromError(error: unknown) {
  return error instanceof Error ? error.message : "Request failed";
}
