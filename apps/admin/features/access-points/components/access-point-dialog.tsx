"use client";
import { useMemo, useRef, useState } from "react";
import { useRouter } from "@admin/navigation";
import { useForm, useStore } from "@tanstack/react-form";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@frely/ui/components/button";
import { Input } from "@frely/ui/components/input";
import { Textarea } from "@frely/ui/components/textarea";
import {
  SearchSelect,
  type SearchSelectOption,
} from "../../../pages/owner/_components/search-select";
import { AdminDialog, ConsoleDialogFooter } from "../../../pages/owner/_components/ui";
import {
  createAccessPoint,
  fetchAccessPointCandidates,
  fetchAccessPointImpact,
  fetchProviderCandidates,
  fetchProviderModelCandidates,
  fetchScopeCandidates,
  updateAccessPoint,
} from "../api/access-point-api";
import {
  accessPointFormDefaults,
  accessPointDescriptionLength,
  accessPointTargetValue,
  parseTargetValue,
  providerTargetValue,
  targetChangeDefaults,
  toAccessPointInput,
  validateAccessPointDescription,
  validateProviderCatalog,
} from "../form/access-point-form-values";
import { accessPointKeys } from "../query/access-point-query-keys";
import type { AccessPointPageData, AccessPointSummary } from "../types";

export function AccessPointDialog({
  data,
  row,
  onClose,
}: {
  data: AccessPointPageData;
  row?: AccessPointSummary;
  onClose?: () => void;
}) {
  const router = useRouter(),
    editing = Boolean(row);
  const [open, setOpen] = useState(editing);
  const [submitError, setSubmitError] = useState("");
  const [targetSearch, setTargetSearch] = useState("");
  const [targetPage, setTargetPage] = useState(1);
  const [scopeSearch, setScopeSearch] = useState("");
  const [scopePage, setScopePage] = useState(1);
  const createIdempotencyKey = useRef(crypto.randomUUID());
  const form = useForm({
    defaultValues: accessPointFormDefaults(
      row,
      data.currentUserScopeRef,
      "",
    ),
    onSubmit: async ({ value }) => {
      setSubmitError("");
      try {
        const converted = toAccessPointInput(value, row);
        if (!converted.ok) throw new Error(converted.message);
        const catalogError = validateProviderCatalog(
          value,
          [],
          (candidates.data?.items ?? []).map((item) => item.providerModelName),
        );
        if (catalogError) throw new Error(catalogError);
        await mutation.mutateAsync(converted.value);
      } catch (error) {
        setSubmitError(message(error));
      }
    },
  });
  const targetValue = useStore(
    form.store,
    (state) => state.values.targetValue,
  );
  const target = parseTargetValue(targetValue);
  const providerId = target?.kind === "provider" ? target.providerId : "";
  const candidates = useQuery({
    queryKey: accessPointKeys.modelCandidates(providerId),
    queryFn: ({ signal }) => fetchProviderModelCandidates(providerId, signal),
    enabled: open && Boolean(providerId),
    retry: false,
    staleTime: 30_000,
    gcTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const targetCandidates = useQuery({
    queryKey: accessPointKeys.targetCandidates(targetSearch, targetPage),
    queryFn: async ({ signal }) => {
      const [providers, accessPoints] = await Promise.all([
        fetchProviderCandidates(targetSearch, targetPage, signal),
        fetchAccessPointCandidates(targetSearch, targetPage, signal),
      ]);
      return {
        providers: providers.items,
        accessPoints: accessPoints.items,
        page: targetPage,
        totalPages: Math.max(providers.totalPages, accessPoints.totalPages),
      };
    },
    enabled: open,
    staleTime: 15_000,
    retry: false,
  });
  const impact = useQuery({
    queryKey: ["owner", "access-points", "impact", row?.id],
    queryFn: ({ signal }) => fetchAccessPointImpact(row!.id, signal),
    enabled: editing && Boolean(row?.id),
    staleTime: 15_000,
    retry: false,
  });
  const scopeCandidates = useQuery({
    queryKey: ["owner", "access-points", "scope-candidates", scopeSearch, scopePage],
    queryFn: ({ signal }) => fetchScopeCandidates(scopeSearch, scopePage, signal),
    enabled: open,
    staleTime: 15_000,
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: (input: object) =>
      editing ? updateAccessPoint(input) : createAccessPoint(input, createIdempotencyKey.current),
    retry: false,
    onSuccess: () => {
      createIdempotencyKey.current = crypto.randomUUID();
      setOpen(false);
      onClose?.();
      router.refresh();
    },
  });
  const targetOptions = useMemo<SearchSelectOption[]>(
    () => [
      ...(targetCandidates.data?.providers ?? []).map((p) => ({
        value: providerTargetValue(p.id),
        label: `${p.name} / ${p.id}`,
        description: `Provider - ${p.kind}`,
        searchText: `${p.name} ${p.id} ${p.kind}`,
      })),
      ...(targetCandidates.data?.accessPoints ?? [])
        .filter((ap) => ap.id !== row?.id)
        .map((ap) => ({
          value: accessPointTargetValue(ap.id),
          label: `${ap.name} / ${ap.id}`,
          ...(ap.description ? { description: ap.description } : {}),
          metadata: `${ap.description ? "" : "— · "}AccessPoint - ${ap.exposedModel} (scope ${ap.scopeRef})`,
          searchText: `${ap.name} ${ap.id} ${ap.exposedModel}`,
        })),
    ],
    [row?.id, targetCandidates.data],
  );
  const scopes = useMemo<SearchSelectOption[]>(
    () => [
      {
        value: "global:",
        label: "Global",
        description: "Global scope",
        searchText: "global",
      },
      ...(scopeCandidates.data?.teams ?? []).map((x) => ({
        value: `team:${x.id}`,
        label: `Team / ${x.name}`,
        description: x.status,
        searchText: `${x.id} ${x.name}`,
      })),
      ...(scopeCandidates.data?.users ?? []).map((x) => ({
        value: `user:${x.id}`,
        label: `User / ${x.email}`,
        description: "user",
        searchText: `${x.id} ${x.email}`,
      })),
      ...(scopeCandidates.data?.apiKeys ?? []).map((x) => ({
        value: `key:${x.id}`,
        label: `Key / ${x.name}`,
        description: x.keyPrefix,
        searchText: `${x.id} ${x.name} ${x.keyPrefix}`,
      })),
    ],
    [scopeCandidates.data],
  );
  const close = () => {
    if (!mutation.isPending) {
      setOpen(false);
      onClose?.();
    }
  };
  return (
    <>
      {!editing ? (
        <Button
          type="button"
          onClick={() => {
            createIdempotencyKey.current = crypto.randomUUID();
            setOpen(true);
          }}
          disabled={targetOptions.length === 0}
        >
          Add AccessPoint
        </Button>
      ) : null}
      {open ? (
        <AdminDialog
          observabilityKey="access-point-editor"
          titleId="access-point-dialog-title"
          eyebrow="Access"
          title={editing ? "Edit AccessPoint" : "Add AccessPoint"}
          description={
            row?.id ?? "Expose a source model through a selected target."
          }
          onClose={close}
          closeDisabled={mutation.isPending}
        >
          {editing && impact.data ? (
            <div className="notice-box notice-warn">
              This AccessPoint is referenced by {impact.data.plans.length}{" "}
              Plan(s) and {impact.data.activeOrFutureSubscriptionCount}{" "}
              active/future Subscription(s). Changes may affect callers.
            </div>
          ) : null}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void form.handleSubmit();
            }}
          >
            <div className="form-grid">
              <form.Field
                name="targetValue"
                validators={{
                  onSubmit: ({ value }) =>
                    parseTargetValue(value) ? undefined : "Target is required.",
                }}
              >
                {(f) => (
                  <label>
                    Target
                    <SearchSelect
                      value={f.state.value}
                      options={targetOptions}
                      onSearchChange={(query) => {
                        setTargetSearch(query);
                        setTargetPage(1);
                      }}
                      onValueChange={(value) => {
                        f.handleChange(value);
                        const defaults = targetChangeDefaults(
                          value,
                          form.state.values.exposedModel,
                          data.accessPoints,
                          [],
                          [],
                        );
                        form.setFieldValue(
                          "exposedModel",
                          defaults.exposedModel,
                        );
                        form.setFieldValue("targetModel", defaults.targetModel);
                      }}
                      placeholder="Search Provider or AccessPoint"
                      pagination={{
                        page: targetCandidates.data?.page ?? targetPage,
                        totalPages: targetCandidates.data?.totalPages ?? targetPage,
                        pending: targetCandidates.isPending,
                        onPageChange: setTargetPage,
                      }}
                    />
                    <span>
                      Select the Provider or AccessPoint that receives the
                      request.
                    </span>
                    {errors(f.state.meta.errors)}
                  </label>
                )}
              </form.Field>
              <form.Field name="fallbackTargetValue">
                {(f) => (
                  <label>
                    Fallback Target
                    <SearchSelect
                      value={f.state.value}
                      options={targetOptions.filter((option) => option.value !== targetValue)}
                      onSearchChange={(query) => {
                        setTargetSearch(query);
                        setTargetPage(1);
                      }}
                      onValueChange={f.handleChange}
                      placeholder="Optional second target"
                      pagination={{
                        page: targetCandidates.data?.page ?? targetPage,
                        totalPages: targetCandidates.data?.totalPages ?? targetPage,
                        pending: targetCandidates.isPending,
                        onPageChange: setTargetPage,
                      }}
                    />
                    <span>Adding a second target enables ordered fallback before any client output.</span>
                  </label>
                )}
              </form.Field>
              <form.Field name="maxAttempts">
                {(f) => (
                  <label>
                    Maximum Attempts
                    <Input value={f.state.value} onChange={(event) => f.handleChange(event.target.value)} />
                    <span>Use 2 for a new two-target route; existing larger routes keep a value no greater than their enabled target count.</span>
                  </label>
                )}
              </form.Field>
              <form.Field name="retryOn">
                {(f) => (
                  <label>
                    Retry Classes
                    <Input value={f.state.value} onChange={(event) => f.handleChange(event.target.value)} />
                    <span>Comma-separated: connect_error, timeout, rate_limited, upstream_5xx.</span>
                  </label>
                )}
              </form.Field>
              <form.Field name="requestOverridesJson">
                {(f) => (
                  <label className="form-grid-span-2">
                    Request Overrides
                    <Textarea
                      rows={6}
                      value={f.state.value}
                      onChange={(event) => f.handleChange(event.target.value)}
                      placeholder={'{\n  "service_tier": "fast"\n}'}
                    />
                    <span>Fixed JSON parameters applied by this entry AccessPoint. AccessPoint values override caller values; model, content, credentials, transport, stream, and store controls are rejected.</span>
                  </label>
                )}
              </form.Field>
              <form.Field name="name">
                {(f) => (
                  <label>
                    Access Name
                    <Input
                      value={f.state.value}
                      onChange={(e) => f.handleChange(e.target.value)}
                    />
                    <form.Subscribe selector={(state) => state.values}>
                      {(values) => {
                        const suggestion = generatedName(
                          values.targetValue,
                          values.exposedModel,
                          values.targetModel,
                          data,
                        );
                        return !values.name.trim() && suggestion ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => f.handleChange(suggestion)}
                          >
                            {suggestion}
                          </Button>
                        ) : null;
                      }}
                    </form.Subscribe>
                    <span>
                      Choose the generated source-to-target name or type a
                      custom name.
                    </span>
                    {errors(f.state.meta.errors)}
                  </label>
                )}
              </form.Field>
              <form.Field
                name="description"
                validators={{ onSubmit: ({ value }) => validateAccessPointDescription(value) }}
              >
                {(f) => (
                  <label className="form-grid-span-2">
                    Description
                    <Textarea
                      rows={5}
                      value={f.state.value}
                      onChange={(event) => f.handleChange(event.target.value)}
                      placeholder="Optional plain-text description"
                    />
                    <span>{accessPointDescriptionLength(f.state.value)} / 500 Unicode characters. Leading and trailing whitespace is removed when saved.</span>
                    {errors(f.state.meta.errors)}
                  </label>
                )}
              </form.Field>
              <form.Field name="exposedModel">
                {(f) => (
                  <label>
                    Exposed Model
                    <SearchSelect
                      value={f.state.value}
                      options={(candidates.data?.items ?? []).map((x) => ({
                        value: x.providerModelName,
                        label: x.displayName,
                        description: x.providerModelName,
                        searchText: `${x.displayName} ${x.providerModelName}`,
                      }))}
                      onValueChange={f.handleChange}
                      placeholder={
                        candidates.isFetching
                          ? "Loading resolver models..."
                          : "Model callers request"
                      }
                      allowCustomValue
                    />
                    {errors(f.state.meta.errors)}
                  </label>
                )}
              </form.Field>
              <form.Field name="targetModel">
                {(f) => (
                  <label>
                    Target Model
                    <SearchSelect
                      value={f.state.value}
                      options={(candidates.data?.items ?? []).map((x) => ({
                        value: x.providerModelName,
                        label: x.displayName,
                        description: x.providerModelName,
                        searchText: `${x.displayName} ${x.providerModelName}`,
                      }))}
                      onValueChange={f.handleChange}
                      placeholder="Actual upstream model"
                      allowCustomValue
                    />
                  </label>
                )}
              </form.Field>
              <form.Field
                name="scopeRef"
                validators={{ onSubmit: required("Scope") }}
              >
                {(f) => (
                  <label>
                    Scope
                    <SearchSelect
                      value={f.state.value}
                      options={scopes}
                      onSearchChange={(query) => {
                        setScopeSearch(query);
                        setScopePage(1);
                      }}
                      onValueChange={f.handleChange}
                      placeholder="Search scope"
                      pagination={{
                        page: scopeCandidates.data?.page ?? scopePage,
                        totalPages: scopeCandidates.data?.totalPages ?? scopePage,
                        pending: scopeCandidates.isPending,
                        onPageChange: setScopePage,
                      }}
                    />
                    {errors(f.state.meta.errors)}
                  </label>
                )}
              </form.Field>
              {numberField(form, "priority", "Priority")}
              {numberField(form, "weight", "Weight")}
              {numberField(form, "fallbackOrder", "Fallback Order")}
              {numberField(form, "saleInputPer1M", "Sale Input / 1M", true)}
              {numberField(
                form,
                "saleCachedInputPer1M",
                "Sale Cache Read / 1M",
                true,
              )}
              {numberField(
                form,
                "saleCacheWritePer1M",
                "Sale Cache Write / 1M",
                true,
                true,
              )}
              {numberField(form, "saleOutputPer1M", "Sale Output / 1M", true)}
              {editing ? (
                <form.Field name="status">
                  {(f) => (
                    <label>
                      Status
                      <SearchSelect
                        value={f.state.value}
                        onValueChange={f.handleChange}
                        searchable={false}
                        options={[{ value: "enabled", label: "Enabled" }, { value: "disabled", label: "Disabled" }]}
                      />
                    </label>
                  )}
                </form.Field>
              ) : (
                <label>
                  Status
                  <Input value="Disabled on creation" disabled />
                  <span>Enable the AccessPoint explicitly after creation and initial price configuration.</span>
                </label>
              )}
            </div>
            <form.Subscribe selector={(state) => state.values}>
              {(values) => (
                <div className="embedded-section">
                  <div className="rule-table">
                    <div>
                      <strong>Selected target</strong>
                      <span>
                        {selectedTargetLabel(values.targetValue, data)}
                      </span>
                    </div>
                    <div>
                      <strong>Model resolver</strong>
                      <span>
                        {values.exposedModel.trim() || "exposed"} -&gt;{" "}
                        {values.targetModel.trim() ||
                          values.exposedModel.trim() ||
                          "target"}
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </form.Subscribe>
            {candidates.data?.warning ? (
              <div className="notice-box notice-warn">
                Resolver failed: {candidates.data.warning}. Showing fallback
                candidates; custom model names remain allowed.
              </div>
            ) : null}
            {candidates.error ? (
              <div className="notice-box notice-warn">
                {message(candidates.error)} Custom model names remain allowed.
              </div>
            ) : null}
            <ConsoleDialogFooter feedback={submitError ? (
              <div className="notice-box notice-bad" role="alert">{submitError}</div>
            ) : mutation.error ? (
              <div className="notice-box notice-bad" role="alert">
                {message(mutation.error)}
              </div>
            ) : null}>
              <Button
                type="button"
                variant="secondary"
                onClick={close}
                disabled={mutation.isPending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={mutation.isPending}>
                {mutation.isPending ? "Saving..." : "Save AccessPoint"}
              </Button>
            </ConsoleDialogFooter>
          </form>
        </AdminDialog>
      ) : null}
    </>
  );
}
function required(label: string) {
  return ({ value }: { value: string }) =>
    value.trim() ? undefined : `${label} is required.`;
}
function numberField(form: any, name: any, label: string, optional = false, allowUnavailable = false) {
  return (
    <form.Field
      name={name}
      validators={{
        onSubmit: ({ value }: { value: string }) =>
          optional && !value.trim()
            ? undefined
            : allowUnavailable && value.trim().toLowerCase() === "unavailable"
              ? undefined
            : Number.isFinite(Number(value)) && Number(value) >= 0
              ? undefined
              : `${label} must be a non-negative number${allowUnavailable ? " or Unavailable" : ""}.`,
      }}
    >
      {(f: any) => (
        <label>
          {label}
          {optional ? <span className="muted"> (optional)</span> : null}
          <Input
            value={f.state.value}
            onChange={(e) => f.handleChange(e.target.value)}
            inputMode={allowUnavailable ? "text" : "decimal"}
          />
          {errors(f.state.meta.errors)}
        </label>
      )}
    </form.Field>
  );
}
function errors(items: unknown[]) {
  return items.map((x, i) => (
    <span className="field-error" key={i}>
      {String(x)}
    </span>
  ));
}
function message(error: unknown) {
  return error instanceof Error ? error.message : "Request failed";
}
function selectedTargetLabel(value: string, data: AccessPointPageData) {
  const target = parseTargetValue(value);
  if (target?.kind === "provider") return target.providerId;
  if (target?.kind === "access-point") {
    const accessPoint = data.accessPoints.find(
      (row) => row.id === target.accessPointId,
    );
    return accessPoint
      ? `${accessPoint.name} / ${accessPoint.id}`
      : target.accessPointId;
  }
  return "No target selected";
}
function generatedName(
  targetValue: string,
  source: string,
  targetModel: string,
  data: AccessPointPageData,
) {
  const target = parseTargetValue(targetValue);
  if (!target || !source.trim()) return "";
  const targetName =
    target.kind === "provider"
      ? target.providerId
      : (data.accessPoints.find((row) => row.id === target.accessPointId)
          ?.name ?? target.accessPointId);
  const model = targetModel.trim() || source.trim();
  return targetName && model
    ? `${source.trim()} -> ${targetName}.${model}`
    : "";
}
