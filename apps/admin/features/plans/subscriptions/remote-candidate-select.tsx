"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { SearchSelect } from "../../../pages/owner/_components/search-select";
import { fetchSubscriptionCandidates, type SubscriptionCandidate } from "./api";

export function RemoteCandidateSelect({ kind, label, value, subscriptionId, disabled, onChange }: {
  kind: "plans" | "scopes" | "accounts" | "users" | "grant-users" | "grant-credit-products";
  label: string;
  value: string;
  subscriptionId?: string;
  disabled?: boolean;
  onChange: (value: string, candidate: SubscriptionCandidate | null) => void;
}) {
  const [search, setSearch] = useState(value);
  const [debounced, setDebounced] = useState(value);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<SubscriptionCandidate | null>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => { setDebounced(search); setPage(1); }, 200);
    return () => window.clearTimeout(timer);
  }, [search]);
  const query = useQuery({
    queryKey: ["subscription-candidates", kind, subscriptionId ?? "", debounced, page],
    queryFn: ({ signal }) => fetchSubscriptionCandidates(kind, debounced, page, subscriptionId, signal),
    enabled: !disabled && (kind !== "users" || Boolean(subscriptionId)),
    staleTime: 15_000,
    retry: false
  });
  const items = selected && !(query.data?.items ?? []).some(({ value: id }) => id === selected.value) ? [selected, ...(query.data?.items ?? [])] : query.data?.items ?? [];
  return <label className="request-log-filter-field" data-size="owner">
    {label}
    <SearchSelect ariaLabel={label} value={value} disabled={disabled ?? false} placeholder={`Search ${label.toLowerCase()}`} options={[{ value: "", label: "Select…" }, ...items]} onSearchChange={setSearch} onValueChange={(nextValue) => { const candidate = items.find(({ value: id }) => id === nextValue) ?? null; setSelected(candidate); onChange(nextValue, candidate); }} pagination={{ page: query.data?.page ?? page, totalPages: query.data?.totalPages ?? page, pending: query.isPending, onPageChange: setPage }} />
    {query.error ? <span className="field-error">{query.error instanceof Error ? query.error.message : "Unable to load candidates"}</span> : null}
  </label>;
}
