"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { SearchSelect } from "../../../pages/owner/_components/search-select";
import {
  fetchAdminCardCandidates,
  type AdminCardCreditProductCandidate,
  type AdminCardPlanCandidate,
} from "../api/user-api";

type Candidate = AdminCardPlanCandidate | AdminCardCreditProductCandidate;

export function RemoteAdminCardCandidateSelect({
  kind,
  userId,
  value,
  disabled,
  onChange,
}: {
  kind: "plans" | "credit-products";
  userId: string;
  value: string;
  disabled: boolean;
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
  useEffect(() => {
    setSearch("");
    setDebounced("");
    setPage(1);
    setSelected(null);
  }, [kind]);
  const query = useQuery({
    queryKey: ["owner", "users", userId, "admin-card-candidates", kind, debounced, page],
    queryFn: ({ signal }) => fetchAdminCardCandidates(kind, userId, debounced, page, signal),
    staleTime: 15_000,
    retry: false,
  });
  const candidates = query.data?.items ?? [];
  const options = selected && !candidates.some((candidate) => candidate.id === selected.id)
    ? [selected, ...candidates]
    : candidates;
  return <>
    <SearchSelect
      value={value}
      disabled={disabled}
      onSearchChange={setSearch}
      onValueChange={(nextValue) => {
        setSelected(options.find((candidate) => candidate.id === nextValue) ?? null);
        onChange(nextValue);
      }}
      options={options.map((candidate) => ({
        value: candidate.id,
        label: isPlanCandidate(candidate) ? `${candidate.name} v${candidate.version}` : candidate.displayName,
        description: isPlanCandidate(candidate)
          ? `${formatDuration(candidate.durationSeconds)} entitlement`
          : `${formatCredit(candidate.creditedAmountUnits)} / ${candidate.code}`,
      }))}
      placeholder={kind === "plans" ? "Search eligible Plans" : "Search Credit Products"}
      pagination={{
        page: query.data?.page ?? page,
        totalPages: query.data?.totalPages ?? page,
        pending: query.isPending,
        onPageChange: setPage,
      }}
    />
    {query.error ? <span className="field-error">{query.error.message}</span> : null}
  </>;
}

function isPlanCandidate(candidate: Candidate): candidate is AdminCardPlanCandidate {
  return "durationSeconds" in candidate;
}

function formatDuration(seconds: number) {
  if (seconds % 86_400 === 0) return `${seconds / 86_400} day${seconds === 86_400 ? "" : "s"}`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600} hour${seconds === 3_600 ? "" : "s"}`;
  return `${seconds} seconds`;
}

function formatCredit(units: number) {
  return `${(units / 1_000_000).toFixed(6).replace(/\.?0+$/, "")} USD`;
}
