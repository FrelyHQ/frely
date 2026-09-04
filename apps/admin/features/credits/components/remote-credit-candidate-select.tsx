"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { SearchSelect } from "../../../pages/owner/_components/search-select";
import { fetchCreditProductCandidates, fetchPaymentChannelCandidates } from "../api/credit-api";
import type { CreditProduct, PaymentChannelCandidate } from "../types";

type Candidate = CreditProduct | PaymentChannelCandidate;

export function RemoteCreditCandidateSelect({
  kind,
  value,
  disabled,
  onChange,
}: {
  kind: "product" | "channel";
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
  const query = useQuery({
    queryKey: ["owner", "credits", `${kind}-candidates`, debounced, page],
    queryFn: async ({ signal }) => kind === "product"
      ? fetchCreditProductCandidates(debounced, page, signal)
      : fetchPaymentChannelCandidates(debounced, page, signal),
    staleTime: 15_000,
    retry: false,
  });
  const candidates: Candidate[] = query.data?.items ?? [];
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
        label: candidate.displayName,
        description: kind === "product"
          ? (candidate as CreditProduct).code
          : `${(candidate as PaymentChannelCandidate).paymentNetwork} / ${(candidate as PaymentChannelCandidate).paymentAsset}`,
      }))}
      placeholder={kind === "product" ? "Search Credit Products" : "Search Payment Channels"}
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
