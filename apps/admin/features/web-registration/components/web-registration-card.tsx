"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useRouter } from "@admin/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@frely/ui/components/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@frely/ui/components/card";
import { StatusBadge } from "../../../pages/owner/_components/ui";
import { SearchSelect, type SearchSelectOption } from "../../../pages/owner/_components/search-select";
import { fetchWebRegistrationTeamCandidates, updateWebRegistrationSetting } from "../api/web-registration-api";
import type { WebRegistrationSettingView, WebRegistrationTeamView } from "../types";

export function WebRegistrationCard({ initial }: { initial: WebRegistrationSettingView }) {
  const router = useRouter();
  const [teamId, setTeamId] = useState(initial.team?.id ?? "");
  const [selectedTeam, setSelectedTeam] = useState<WebRegistrationTeamView | null>(initial.team);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);
  const [cursorByPage, setCursorByPage] = useState<Record<number, string | null>>({ 1: null });
  const [open, setOpen] = useState(false);
  const mutation = useMutation({
    mutationFn: updateWebRegistrationSetting,
    retry: false,
    onSuccess: (next) => {
      setTeamId(next.team?.id ?? "");
      setSelectedTeam(next.team);
      router.refresh();
    }
  });

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(search.trim().toLowerCase());
      setPage(1);
      setCursorByPage({ 1: null });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [search]);

  const cursor = cursorByPage[page] ?? null;
  const query = useQuery({
    queryKey: ["owner", "web-registration-team-candidates", debouncedSearch, page, cursor],
    queryFn: ({ signal }) => fetchWebRegistrationTeamCandidates(debouncedSearch, cursor, signal),
    enabled: open,
    staleTime: 15_000,
    retry: false
  });

  useEffect(() => {
    if (!query.data) return;
    const nextCursor = query.data.nextCursor;
    setCursorByPage((current) => current[page + 1] === nextCursor ? current : { ...current, [page + 1]: nextCursor });
  }, [page, query.data]);

  const candidates = query.data?.items ?? [];
  const options = useMemo<SearchSelectOption[]>(() => {
    const all = selectedTeam && !candidates.some((candidate) => candidate.id === selectedTeam.id)
      ? [selectedTeam, ...candidates]
      : candidates;
    return all.map((candidate) => ({ value: candidate.id, label: candidate.name, description: candidate.id }));
  }, [candidates, selectedTeam]);
  const enabled = mutation.data?.enabled ?? initial.enabled;
  const currentTeam = mutation.data?.team ?? selectedTeam;

  return (
    <Card className="panel">
      <CardHeader>
        <div className="panel-heading">
          <div>
            <CardTitle>Self-registration</CardTitle>
            <CardDescription>Choose the Team used by the canonical login page for new self-registrations. This is disabled by default.</CardDescription>
          </div>
          <StatusBadge tone={enabled ? "good" : "neutral"}>{enabled ? "Enabled" : "Disabled"}</StatusBadge>
        </div>
      </CardHeader>
      <CardContent className="form-grid">
        <label>
          Registration Team
          <SearchSelect
            ariaLabel="Self-registration Team"
            value={teamId}
            options={options}
            onOpenChange={setOpen}
            onSearchChange={setSearch}
            onValueChange={(value) => {
              const candidate = candidates.find((item) => item.id === value) ?? (selectedTeam?.id === value ? selectedTeam : null);
              setTeamId(value);
              setSelectedTeam(candidate);
              mutation.reset();
            }}
            placeholder="Search enabled Teams"
            pagination={{
              page,
              totalPages: query.data?.nextCursor ? page + 1 : page,
              pending: query.isPending || query.isFetching,
              onPageChange: setPage
            }}
          />
        </label>
        <div className="muted">{currentTeam ? `New accounts will join ${currentTeam.name} with viewer membership.` : "No Team is selected; self-registration remains unavailable."}</div>
        {initial.configured && !enabled ? <div className="notice-box notice-warn" role="status">The saved registration target is currently unavailable. Saving a Team will create or reuse a fresh unlimited registration invite.</div> : null}
        {query.error ? <div className="notice-box notice-bad" role="alert">{query.error instanceof Error ? query.error.message : "Unable to load Teams"}</div> : null}
        {mutation.error ? <div className="notice-box notice-bad" role="alert">{mutation.error instanceof Error ? mutation.error.message : "Unable to save self-registration"}</div> : null}
      </CardContent>
      <CardFooter className="justify-between gap-3">
        <Button type="button" variant="secondary" disabled={mutation.isPending || !teamId} onClick={() => mutation.mutate(null)}>Disable self-registration</Button>
        <Button type="button" disabled={mutation.isPending || !teamId} onClick={() => mutation.mutate(teamId)}>{mutation.isPending ? "Saving…" : "Save Team"}</Button>
      </CardFooter>
    </Card>
  );
}
