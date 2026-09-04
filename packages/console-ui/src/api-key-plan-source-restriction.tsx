"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@frely/ui/components/button";
import { SearchSelect } from "./search-select.js";

export type ApiKeyPlanSourceRestriction = {
  mode: "all" | "restricted";
  apiKeyId: string;
  sourceKeys: readonly SourceKey[];
  teamScopeRefs: readonly string[];
};

export type SourceKey = { planId: string; subscriptionScopeRef: string };

export type ApiKeyPlanSourceRestrictionCandidatePage = {
  sources: Array<{ planId: string; planName: string; planVersion: number; subscriptionScopeRef: string; current: boolean; selected: boolean }>;
  teams: Array<{ teamId: string; teamName: string; scopeRef: string; current: boolean; selected: boolean }>;
  page: number;
  pageSize: number;
  hasMoreSources: boolean;
  hasMoreTeams: boolean;
  nextPage: number | null;
};

export interface ApiKeyPlanSourceRestrictionApi {
  pageCandidates(input: { query: string; page: number; pageSize: number }, signal?: AbortSignal): Promise<ApiKeyPlanSourceRestrictionCandidatePage>;
  replace(input: { mode: "all" | "restricted"; sourceKeys: readonly SourceKey[]; teamScopeRefs: readonly string[] }): Promise<ApiKeyPlanSourceRestriction>;
}

export function ApiKeyPlanSourceRestrictionEditor({ apiKeyId, initial, api, onSaved }: {
  apiKeyId: string;
  initial: ApiKeyPlanSourceRestriction;
  api: ApiKeyPlanSourceRestrictionApi;
  onSaved?: () => void;
}) {
  const [mode, setMode] = useState<ApiKeyPlanSourceRestriction["mode"]>(initial.mode);
  const [sources, setSources] = useState<SourceKey[]>([...initial.sourceKeys]);
  const [teams, setTeams] = useState<string[]>([...initial.teamScopeRefs]);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const candidates = useQuery({
    queryKey: ["api-key", "plan-source-restriction-candidates", apiKeyId, search.trim(), page],
    queryFn: ({ signal }) => api.pageCandidates({ query: search.trim(), page, pageSize: 50 }, signal),
    enabled: mode === "restricted",
    staleTime: 15_000,
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: () => api.replace({ mode, sourceKeys: sources, teamScopeRefs: teams }),
    retry: false,
    onSuccess: (saved) => {
      if (saved.mode === "all") {
        setSources([]);
        setTeams([]);
      }
      onSaved?.();
    },
  });
  const candidatePage = candidates.data;
  const sourceOptions = (candidatePage?.sources ?? [])
    .filter((source) => !sources.some((selected) => sameSource(selected, source)))
    .map((source) => ({
      value: `${source.planId}\u0000${source.subscriptionScopeRef}`,
      label: `${source.planName} v${source.planVersion}`,
      description: source.subscriptionScopeRef,
      metadata: source.current ? "Current" : "Unavailable; retained selection",
      searchText: `${source.planId} ${source.subscriptionScopeRef}`,
    }));
  const teamOptions = (candidatePage?.teams ?? [])
    .filter((team) => !teams.includes(team.scopeRef))
    .map((team) => ({
      value: team.scopeRef,
      label: team.teamName,
      description: team.scopeRef,
      metadata: team.current ? "Current" : "Unavailable; retained selection",
      searchText: team.teamId,
    }));
  const candidateTotalPages = candidatePage
    ? (candidatePage.hasMoreSources || candidatePage.hasMoreTeams ? page + 1 : page)
    : page;

  function selectSource(value: string) {
    const [planId, subscriptionScopeRef] = value.split("\u0000", 2);
    if (planId && subscriptionScopeRef) setSources((current) => [...current, { planId, subscriptionScopeRef }]);
  }

  return (
    <div className="api-key-plan-source-editor">
      <div className="button-row">
        <Button type="button" variant={mode === "all" ? "default" : "secondary"} onClick={() => { setMode("all"); setSources([]); setTeams([]); mutation.reset(); }}>All current sources</Button>
        <Button type="button" variant={mode === "restricted" ? "default" : "secondary"} onClick={() => { setMode("restricted"); mutation.reset(); }}>Restrict sources</Button>
        <Button type="button" variant="secondary" onClick={() => mutation.mutate()} disabled={mutation.isPending}>{mutation.isPending ? "Saving..." : "Save policy"}</Button>
      </div>
      {mutation.isSuccess && <p className="muted" role="status">Policy saved.</p>}
      {mode === "restricted" && (candidates.error || mutation.error) ? <p className="muted" role="alert">Policy or candidate data could not be loaded. Refresh and try again.</p> : null}
      {mode === "restricted" && (
        <div className="detail-list">
          <strong>Exact Plan sources</strong>
          <SearchSelect
            value=""
            onValueChange={selectSource}
            onSearchChange={(value) => { setSearch(value); setPage(1); }}
            options={sourceOptions}
            placeholder="Search Plan name, ID, or scope"
            ariaLabel="Search exact Plan sources"
            pagination={{ page, totalPages: candidateTotalPages, pending: candidates.isPending, onPageChange: setPage }}
          />
          {sources.map((source) => {
            const candidate = candidatePage?.sources.find((item) => sameSource(item, source));
            const label = candidate
              ? `${candidate.planName} v${candidate.planVersion} · ${candidate.subscriptionScopeRef}${candidate.current ? "" : " (currently unavailable; retained unless removed)"}`
              : `${source.planId} · ${source.subscriptionScopeRef}`;
            return <SelectedItem key={`${source.planId}:${source.subscriptionScopeRef}`} label={label} onRemove={() => setSources((current) => current.filter((item) => !sameSource(item, source)))} />;
          })}
          <strong>Dynamic Team scopes</strong>
          <SearchSelect
            value=""
            onValueChange={(value) => setTeams((current) => current.includes(value) ? current : [...current, value])}
            onSearchChange={(value) => { setSearch(value); setPage(1); }}
            options={teamOptions}
            placeholder="Search Team name or scope"
            ariaLabel="Search dynamic Team scopes"
            pagination={{ page, totalPages: candidateTotalPages, pending: candidates.isPending, onPageChange: setPage }}
          />
          {teams.map((scopeRef) => {
            const candidate = candidatePage?.teams.find((item) => item.scopeRef === scopeRef);
            const label = candidate
              ? `${candidate.teamName} · ${candidate.scopeRef}${candidate.current ? "" : " (currently unavailable; retained unless removed)"}`
              : scopeRef;
            return <SelectedItem key={scopeRef} label={label} onRemove={() => setTeams((current) => current.filter((item) => item !== scopeRef))} />;
          })}
          {sources.length === 0 && teams.length === 0 && <p className="muted">No selected sources: Plan access through this key is disabled; direct key limits remain independent.</p>}
        </div>
      )}
    </div>
  );
}

function SelectedItem({ label, onRemove }: { label: string; onRemove: () => void }) {
  return <div className="row-actions"><span>{label}</span><Button type="button" variant="ghost" size="sm" onClick={onRemove}>Remove</Button></div>;
}

function sameSource(left: SourceKey, right: SourceKey): boolean {
  return left.planId === right.planId && left.subscriptionScopeRef === right.subscriptionScopeRef;
}
