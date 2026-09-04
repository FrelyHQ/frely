"use client";
import { useState } from "react";
import { useRouter } from "@admin/navigation";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@frely/ui/components/button";
import { Input } from "@frely/ui/components/input";
import {
  SearchSelect,
  type SearchSelectOption,
} from "../../../pages/owner/_components/search-select";
import { AdminDialog, ConsoleDialogFooter } from "../../../pages/owner/_components/ui";
import { fetchScopeCandidates, patchAccessPoint } from "../api/access-point-api";
import { parseNonNegativeNumber } from "../form/access-point-form-values";
import {
  bulkAccessPointPreview,
  isAllowedScope,
} from "../table/access-point-table-state";
import type { AccessPointSummary } from "../types";
type Operation =
  | "status"
  | "scopeRef"
  | "priority"
  | "weight"
  | "fallbackOrder";
export function BulkAccessPointsDialog({
  rows,
  onClose,
  onSaved,
}: {
  rows: AccessPointSummary[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const router = useRouter();
  const [scopeSearch, setScopeSearch] = useState("");
  const [scopePage, setScopePage] = useState(1);
  const scopeCandidates = useQuery({ queryKey: ["owner", "access-points", "bulk-scope-candidates", scopeSearch, scopePage], queryFn: ({ signal }) => fetchScopeCandidates(scopeSearch, scopePage, signal), staleTime: 15_000, retry: false });
  const scopeOptions: SearchSelectOption[] = [
    {
      value: "global:",
      label: "Global",
      description: "Global scope",
      searchText: "global",
    },
    ...(scopeCandidates.data?.teams ?? []).map((row) => ({
      value: `team:${row.id}`,
      label: `Team / ${row.name}`,
      description: row.status,
      searchText: `${row.id} ${row.name}`,
    })),
    ...(scopeCandidates.data?.users ?? []).map((row) => ({
      value: `user:${row.id}`,
      label: `User / ${row.email}`,
      description: "user",
      searchText: `${row.id} ${row.email}`,
    })),
    ...(scopeCandidates.data?.apiKeys ?? []).map((row) => ({
      value: `key:${row.id}`,
      label: `Key / ${row.name}`,
      description: row.keyPrefix,
      searchText: `${row.id} ${row.name}`,
    })),
  ];
  const allowedScopes = scopeOptions.map((row) => row.value);
  const mutation = useMutation({
    mutationFn: async (value: { operation: Operation; value: string }) => {
      const validation = validate(value.operation, value.value, allowedScopes);
      if (validation) throw new Error(validation);
      const patch = toPatch(value);
      await Promise.all(
        rows
          .filter((row) => row[value.operation] !== patch[value.operation])
          .map((row) => patchAccessPoint(row, patch)),
      );
    },
    retry: false,
    onSuccess: () => {
      onSaved();
      router.refresh();
    },
  });
  const form = useForm({
    defaultValues: { operation: "status" as Operation, value: "enabled" },
    onSubmit: ({ value }) => mutation.mutateAsync(value),
  });
  return (
    <AdminDialog
      observabilityKey="access-point-bulk-edit"
      titleId="bulk-access-points-title"
      eyebrow="Access"
      title="Bulk edit"
      description={`${rows.length} selected AccessPoints`}
      onClose={onClose}
      closeDisabled={mutation.isPending}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void form.handleSubmit();
        }}
      >
        <div className="form-grid single">
          <form.Field name="operation">
            {(field) => (
              <label>
                Operation
                <SearchSelect
                  value={field.state.value}
                  onValueChange={(nextValue) => {
                    const op = nextValue as Operation;
                    field.handleChange(op);
                    form.setFieldValue(
                      "value",
                      op === "status" ? "enabled" : "",
                    );
                  }}
                  searchable={false}
                  options={[{ value: "status", label: "Enable / Disable" }, { value: "scopeRef", label: "Scope" }, { value: "priority", label: "Priority" }, { value: "weight", label: "Weight" }, { value: "fallbackOrder", label: "Fallback Order" }]}
                />
              </label>
            )}
          </form.Field>
          <form.Subscribe selector={(state) => state.values.operation}>
            {(operation) => (
              <form.Field
                name="value"
                validators={{
                  onSubmit: ({ value }) =>
                    validate(operation, value, allowedScopes),
                }}
              >
                {(field) => (
                  <label>
                    {label(operation)}
                    {operation === "status" ? (
                      <SearchSelect
                        value={field.state.value}
                        onValueChange={field.handleChange}
                        searchable={false}
                        options={[{ value: "enabled", label: "Enable" }, { value: "disabled", label: "Disable" }]}
                      />
                    ) : operation === "scopeRef" ? (
                      <SearchSelect
                        value={field.state.value}
                        options={scopeOptions}
                        onSearchChange={(query) => {
                          setScopeSearch(query);
                          setScopePage(1);
                        }}
                        onValueChange={field.handleChange}
                        placeholder="Search global, team, user, or key"
                        pagination={{
                          page: scopeCandidates.data?.page ?? scopePage,
                          totalPages: scopeCandidates.data?.totalPages ?? scopePage,
                          pending: scopeCandidates.isPending,
                          onPageChange: setScopePage,
                        }}
                      />
                    ) : (
                      <Input
                        value={field.state.value}
                        onChange={(e) => field.handleChange(e.target.value)}
                        inputMode="decimal"
                      />
                    )}{" "}
                    {field.state.meta.errors.map((x, i) => (
                      <span className="field-error" key={i}>
                        {String(x)}
                      </span>
                    ))}
                  </label>
                )}
              </form.Field>
            )}
          </form.Subscribe>
        </div>
        <form.Subscribe selector={(state) => state.values}>
          {(values) => (
            <div className="embedded-section bulk-selection-summary">
              <strong>Selected AccessPoints</strong>
              {rows.map((row) => (
                <div key={row.id}>
                  <span>{row.name}</span>
                  <code>
                    {bulkAccessPointPreview(
                      row,
                      values.operation,
                      values.value,
                    )}
                  </code>
                </div>
              ))}
            </div>
          )}
        </form.Subscribe>
        <ConsoleDialogFooter feedback={mutation.error ? (
          <div className="notice-box notice-bad" role="alert">
            {mutation.error instanceof Error
              ? mutation.error.message
              : "Bulk update failed"}
          </div>
        ) : null}>
          <Button
            type="button"
            variant="secondary"
            onClick={onClose}
            disabled={mutation.isPending}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={mutation.isPending || rows.length === 0}
          >
            {mutation.isPending ? "Saving..." : "Save Changes"}
          </Button>
        </ConsoleDialogFooter>
      </form>
    </AdminDialog>
  );
}
export function validate(
  operation: Operation,
  value: string,
  allowedScopes: string[],
) {
  if (operation === "scopeRef")
    return isAllowedScope(value, allowedScopes)
      ? undefined
      : "Select Scope from the available scopes.";
  if (operation === "status")
    return value === "enabled" || value === "disabled"
      ? undefined
      : "Status is invalid.";
  return parseNonNegativeNumber(value) === null
    ? "Enter a non-negative number."
    : undefined;
}
function toPatch({
  operation,
  value,
}: {
  operation: Operation;
  value: string;
}): Partial<AccessPointSummary> {
  return operation === "priority" ||
    operation === "weight" ||
    operation === "fallbackOrder"
    ? { [operation]: Number(value) }
    : { [operation]: value };
}
function label(operation: Operation) {
  return operation === "scopeRef"
    ? "Scope"
    : operation === "fallbackOrder"
      ? "Fallback Order"
      : operation[0]!.toUpperCase() + operation.slice(1);
}
