"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { SearchSelect } from "../../../pages/owner/_components/search-select";
import { fetchBudgetApiKeyCandidates, fetchBudgetPolicyCandidates, fetchGovernanceBudgetPolicyCandidates } from "../api/budget-api";
import { policyLabel } from "../lib/budget-presenters";
import type { ApiKeySummary, BudgetPolicyCandidate, DirectoryPage } from "../types";

type Candidate = ApiKeySummary | BudgetPolicyCandidate;

export function RemoteBudgetCandidateSelect({
  kind,
  value,
  disabled,
  onChange,
}: {
  kind: "api-key" | "policy" | "governance-policy";
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Candidate | null>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebounced(search);
      setPage(1);
    }, 200);
    return () => window.clearTimeout(timer);
  }, [search]);
  const query = useQuery({
    queryKey: ["owner", "budget-policies", `${kind}-candidates`, debounced, page],
    queryFn: async ({ signal }): Promise<DirectoryPage<Candidate>> => kind === "api-key"
      ? fetchBudgetApiKeyCandidates(debounced, page, signal)
      : kind === "policy"
        ? fetchBudgetPolicyCandidates(debounced, page, signal)
        : fetchGovernanceBudgetPolicyCandidates(debounced, page, signal),
    enabled: !disabled,
    staleTime: 15_000,
    retry: false,
  });
  const candidates = query.data?.items ?? [];
  const items = selected && !candidates.some((item) => item.id === selected.id)
    ? [selected, ...candidates]
    : candidates;
  return <>
    <SearchSelect
      value={value}
      options={items.map((item) => candidateOption(kind, item))}
      onSearchChange={setSearch}
      onValueChange={(nextValue) => {
        setSelected(items.find((item) => item.id === nextValue) ?? null);
        onChange(nextValue);
      }}
      placeholder={kind === "api-key" ? "Search API keys" : kind === "policy" ? "Search budget policies" : "Search governance budgets"}
      disabled={disabled ?? false}
      pagination={{
        page: query.data?.page ?? page,
        totalPages: query.data?.totalPages ?? page,
        pending: query.isPending,
        onPageChange: setPage,
      }}
    />
    {query.error ? <span className="field-error">{query.error instanceof Error ? query.error.message : "Unable to load candidates"}</span> : null}
  </>;
}

function candidateOption(kind: "api-key" | "policy" | "governance-policy", candidate: Candidate) {
  if (kind === "api-key") {
    const key = candidate as ApiKeySummary;
    return {
      value: key.id,
      label: `${key.name} (${key.keyPrefix})`,
      description: `${key.status} - ${key.userId}`,
      searchText: key.id,
    };
  }
  const policy = candidate as BudgetPolicyCandidate;
  return {
    value: policy.id,
    label: policyLabel(policy),
    description: policy.id,
    searchText: policy.id,
  };
}
