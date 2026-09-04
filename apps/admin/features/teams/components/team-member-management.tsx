"use client";

import React, { useEffect, useState } from "react";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRouter } from "@admin/navigation";
import type { TeamUserRow } from "@frely/team-console-ui";
import { Button } from "@frely/ui/components/button";
import { Input } from "@frely/ui/components/input";
import { Tooltip } from "@frely/ui/components/tooltip";
import { SearchSelect } from "../../../pages/owner/_components/search-select";
import { addTeamMember, changeTeamOwner, fetchTeamMemberCandidates, removeTeamMember, type TeamMemberCandidate } from "../api/team-api";

export interface AdminTeamUserOption { id: string; email: string; status: string }
export interface TeamMembershipRoleRow { userId: string; email: string; roles: string[] }

export function AddTeamMemberControl({ teamId }: { teamId: string }) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<TeamMemberCandidate | null>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebounced(search);
      setPage(1);
    }, 200);
    return () => window.clearTimeout(timer);
  }, [search]);
  const candidateQuery = useQuery({
    queryKey: ["owner", "teams", teamId, "member-candidates", debounced, page],
    queryFn: ({ signal }) => fetchTeamMemberCandidates(teamId, debounced, page, signal),
    staleTime: 15_000,
    retry: false,
  });
  const candidates = candidateQuery.data?.items ?? [];
  const options = selected && !candidates.some((candidate) => candidate.id === selected.id)
    ? [selected, ...candidates]
    : candidates;
  const mutation = useMutation({ mutationFn: (userId: string) => addTeamMember(teamId, userId), retry: false, onSuccess: () => { form.reset(); router.refresh(); } });
  const form = useForm({ defaultValues: { userId: "" }, onSubmit: ({ value }) => { if (options.some((user) => user.id === value.userId)) return mutation.mutateAsync(value.userId); } });
  return <form onSubmit={(event) => { event.preventDefault(); void form.handleSubmit(); }}>
    <div className="row-actions">
      <form.Field name="userId">{(field) => <SearchSelect value={field.state.value} onSearchChange={setSearch} onValueChange={(value) => { setSelected(options.find((user) => user.id === value) ?? null); field.handleChange(value); }} options={options.map((user) => ({ value: user.id, label: user.email, description: user.status, searchText: user.id }))} placeholder="Search users" disabled={mutation.isPending} pagination={{ page: candidateQuery.data?.page ?? page, totalPages: candidateQuery.data?.totalPages ?? page, pending: candidateQuery.isPending, onPageChange: setPage }} />}</form.Field>
      <Button type="submit" variant="secondary" size="sm" disabled={mutation.isPending || !form.state.values.userId}>{mutation.isPending ? "Adding..." : "Add Member"}</Button>
    </div>
    {candidateQuery.error ? <span className="text-bad">{candidateQuery.error.message}</span> : null}
    {mutation.error ? <span className="text-bad">{mutation.error.message}</span> : null}
  </form>;
}

export function ChangeTeamOwnerControl({ teamId, ownerId, members }: { teamId: string; ownerId: string; members: TeamUserRow[] }) {
  const router = useRouter();
  const enabledMembers = members.filter((member) => member.status === "Active");
  const mutation = useMutation({ mutationFn: (nextOwnerId: string) => changeTeamOwner(teamId, nextOwnerId), retry: false, onSuccess: () => router.refresh() });
  const form = useForm({ defaultValues: { ownerId }, onSubmit: ({ value }) => mutation.mutateAsync(value.ownerId) });
  return <div className="embedded-section"><strong>Change Owner</strong><form className="row-actions" onSubmit={(event) => { event.preventDefault(); void form.handleSubmit(); }}><form.Field name="ownerId">{(field) => <><SearchSelect value={field.state.value} onValueChange={field.handleChange} disabled={mutation.isPending || enabledMembers.length === 0} options={enabledMembers.map((member) => ({ value: member.id, label: member.email, searchText: member.id }))} /><Button type="submit" size="sm" disabled={mutation.isPending || !field.state.value || field.state.value === ownerId}>{mutation.isPending ? "Saving..." : "Save Owner"}</Button></>}</form.Field></form>{mutation.error ? <div className="notice-box notice-bad">{mutation.error.message}</div> : null}</div>;
}

export function RemoveTeamMemberButton({ teamId, ownerId, user }: { teamId: string; ownerId: string; user: TeamUserRow }) {
  const router = useRouter();
  const mutation = useMutation({ mutationFn: () => removeTeamMember(teamId, user.id), retry: false, onSuccess: () => router.refresh() });
  const isOwner = user.id === ownerId;
  return <div className="row-actions"><Tooltip content={isOwner ? "Change the team owner before removing this member." : undefined} wrapTrigger={isOwner}><Button type="button" variant="destructive" size="sm" disabled={mutation.isPending || isOwner} onClick={() => mutation.mutate()}>{mutation.isPending ? "Removing..." : "Remove"}</Button></Tooltip>{mutation.error ? <span className="text-bad">{mutation.error.message}</span> : null}</div>;
}
