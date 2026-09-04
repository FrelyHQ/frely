"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { SearchSelect } from "../../../pages/owner/_components/search-select";
import { fetchPlanReplacementCandidates, type PlanReplacementCandidate } from "../api/plan-api";

export function RemotePlanReplacementSelect({
  sourcePlanId,
  value,
  disabled,
  onChange,
}: {
  sourcePlanId: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<PlanReplacementCandidate | null>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebounced(search);
      setPage(1);
    }, 200);
    return () => window.clearTimeout(timer);
  }, [search]);
  const query = useQuery({
    queryKey: ["owner", "plans", "replacement-candidates", sourcePlanId, debounced, page],
    queryFn: ({ signal }) => fetchPlanReplacementCandidates(sourcePlanId, debounced, page, signal),
    enabled: !disabled,
    staleTime: 15_000,
    retry: false,
  });
  const candidates = query.data?.items ?? [];
  const items = selected && !candidates.some((candidate) => candidate.id === selected.id)
    ? [selected, ...candidates]
    : candidates;
  return <>
    <SearchSelect
      value={value}
      options={items.map((candidate) => ({
        value: candidate.id,
        label: `${candidate.name} v${candidate.version}`,
        description: candidate.id,
      }))}
      onSearchChange={setSearch}
      onValueChange={(nextValue) => {
        setSelected(items.find((candidate) => candidate.id === nextValue) ?? null);
        onChange(nextValue);
      }}
      disabled={disabled}
      placeholder="Search compatible Plan versions"
      pagination={{
        page: query.data?.page ?? page,
        totalPages: query.data?.totalPages ?? page,
        pending: query.isPending,
        onPageChange: setPage,
      }}
    />
    {query.data && query.data.total === 0 ? <span>No compatible replacement Plan is available.</span> : null}
    {query.error ? <span className="field-error">{query.error instanceof Error ? query.error.message : "Unable to load replacement Plans"}</span> : null}
  </>;
}
