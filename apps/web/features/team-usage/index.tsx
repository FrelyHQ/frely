"use client";

import Link from "@web/navigation";
import { useRouter } from "@web/navigation";
import React from "react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  TeamMemberPlanUsageItem,
  TeamMemberUsageSort,
  TeamSubscriptionCandidate,
  TeamSubscriptionCandidatePage,
} from "@frely/ui-application/contracts";
import { DataTable, type DataTableProps } from "@frely/console-ui/data-table";
import { MaterialTablePagination } from "@frely/console-ui/material-table-pagination";
import { SearchSelect } from "@frely/console-ui/search-select";
import { Button } from "@frely/ui/components/button";
import { BrowserTime } from "@frely/ui/components/browser-time";
import { Input } from "@frely/ui/components/input";
import { fetchTeamPlanSubscriptionCandidates } from "./api/team-usage-api";
import { teamUsageHref, type TeamUsageUrlState } from "./query";

export { parseTeamUsageUrlState, teamUsageHref } from "./query";

export function TeamUsageControls({
  teamId,
  state,
  candidates,
  selected,
  items,
  page,
  pageSize,
  total,
  totalPages,
  showMemberUsage = true,
}: {
  teamId: string;
  state: TeamUsageUrlState;
  candidates: TeamSubscriptionCandidatePage;
  selected: TeamSubscriptionCandidate | null;
  items: TeamMemberPlanUsageItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  showMemberUsage?: boolean;
}) {
  const router = useRouter();
  const [sourceQuery, setSourceQuery] = useState("");
  const [sourcePage, setSourcePage] = useState(1);
  const [memberQuery, setMemberQuery] = useState(state.query);
  const sourceCandidates = useQuery({
    queryKey: ["team-plan-subscription-candidates", teamId, sourceQuery.trim(), sourcePage],
    queryFn: ({ signal }) => fetchTeamPlanSubscriptionCandidates(teamId, sourceQuery, sourcePage, signal),
    initialData: sourceQuery === "" && sourcePage === 1 ? candidates : undefined,
    staleTime: 15_000,
  });
  const candidateItems = sourceCandidates.data?.items ?? [];
  const options = dedupeCandidates([...(selected ? [selected] : []), ...candidateItems]).map((candidate) => ({
    value: candidate.id,
    label: `${candidate.planName} v${candidate.planVersion}`,
    description: `${candidate.billingMode === "prepaid" ? "Prepaid" : "PayGo"} · effective ${formatDateTime(candidate.effectiveStart)}`,
  }));
  const navigate = (next: Partial<TeamUsageUrlState>) => {
    router.replace(teamUsageHref(teamId, { ...state, ...next }));
  };
  const columns = useMemo<DataTableProps<TeamMemberPlanUsageItem>["columns"]>(() => [
    {
      accessorKey: "email",
      header: "Member",
      cell: ({ row }) => (
        <div>
          <Link href={`/user/${encodeURIComponent(row.original.userId)}?teamId=${encodeURIComponent(teamId)}`}>
            {row.original.email}
          </Link>
          <div className="muted"><code>{row.original.userId}</code></div>
        </div>
      ),
    },
    {
      id: "roleStatus",
      header: "Role / Status",
      enableSorting: false,
      cell: ({ row }) => <span>{row.original.roles.join(", ") || "Member"} · {row.original.status}</span>,
    },
    { accessorKey: "requestCount", header: "Requests" },
    { accessorKey: "totalTokens", header: "Tokens" },
    {
      accessorKey: "billableAmount",
      header: "Plan Usage",
      cell: ({ row }) => formatCurrency(row.original.billableAmount),
    },
    {
      accessorKey: "lastUsedAt",
      header: "Last Used",
      cell: ({ row }) => row.original.lastUsedAt ? <BrowserTime value={row.original.lastUsedAt} /> : "Never",
    },
  ], [teamId]);

  useEffect(() => {
    setMemberQuery(state.query);
  }, [state.query]);

  return (
    <>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Plan Source</h2>
            <p className="muted">Choose one active Team Subscription. Search text is not saved to the URL.</p>
          </div>
        </div>
        <label>
          Active Team Subscription
          <SearchSelect
            value={selected?.id ?? ""}
            options={options}
            onSearchChange={(query) => {
              setSourceQuery(query.slice(0, 100));
              setSourcePage(1);
            }}
            onValueChange={(subscriptionId) => navigate({ subscriptionId, page: 1 })}
            pagination={{
              page: sourceCandidates.data?.page ?? sourcePage,
              totalPages: sourceCandidates.data?.totalPages ?? sourcePage,
              pending: sourceCandidates.isPending,
              onPageChange: setSourcePage,
            }}
            placeholder="Search active Team Plans"
            ariaLabel="Active Team Subscription"
          />
        </label>
      </section>

      {showMemberUsage ? <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Member Usage</h2>
            <p className="muted">Current Team members, including members with zero usage.</p>
          </div>
        </div>
        <form
          className="filter-row"
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            navigate({ query: memberQuery.trim().slice(0, 100), page: 1 });
          }}
        >
          <label>
            Search members
            <Input value={memberQuery} maxLength={100} onChange={(event) => setMemberQuery(event.target.value)} />
          </label>
          <Button type="submit">Search</Button>
          {state.query ? <Button type="button" variant="secondary" onClick={() => { setMemberQuery(""); navigate({ query: "", page: 1 }); }}>Clear</Button> : null}
        </form>
        <DataTable
          serverManaged
          data={items}
          columns={columns}
          getRowId={(row) => row.userId}
          emptyState={{
            title: state.query ? "No members match this search." : "No current members.",
            description: state.query ? "Clear the search to show all current members." : "Usage remains visible in the summary above.",
          }}
          state={{ sorting: [{ id: sortColumnId(state.sort), desc: state.direction === "desc" }] }}
          onStateChange={{
            sorting: (updater) => {
              const current = [{ id: sortColumnId(state.sort), desc: state.direction === "desc" }];
              const next = typeof updater === "function" ? updater(current) : updater;
              const first = next[0];
              if (!first) return;
              const sort = sortFromColumnId(first.id);
              if (sort) navigate({ sort, direction: first.desc ? "desc" : "asc", page: 1 });
            },
          }}
        />
        <MaterialTablePagination
          page={page}
          pageSize={pageSize}
          total={total}
          totalPages={totalPages}
          rangeStart={total ? (page - 1) * pageSize + 1 : 0}
          rangeEnd={Math.min(page * pageSize, total)}
          previousHref={page > 1 ? teamUsageHref(teamId, { ...state, page: page - 1 }) : ""}
          nextHref={page < totalPages ? teamUsageHref(teamId, { ...state, page: page + 1 }) : ""}
          noun="members"
        />
      </section> : null}
    </>
  );
}

function dedupeCandidates(items: TeamSubscriptionCandidate[]): TeamSubscriptionCandidate[] {
  return Array.from(new Map(items.map((item) => [item.id, item])).values());
}

function sortColumnId(sort: TeamMemberUsageSort): string {
  if (sort === "member") return "email";
  if (sort === "tokens") return "totalTokens";
  if (sort === "requests") return "requestCount";
  if (sort === "lastUsed") return "lastUsedAt";
  return "billableAmount";
}

function sortFromColumnId(id: string): TeamMemberUsageSort | null {
  if (id === "email") return "member";
  if (id === "totalTokens") return "tokens";
  if (id === "requestCount") return "requests";
  if (id === "lastUsedAt") return "lastUsed";
  if (id === "billableAmount") return "usage";
  return null;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: value !== 0 && Math.abs(value) < 0.01 ? 6 : 2,
  }).format(value);
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
