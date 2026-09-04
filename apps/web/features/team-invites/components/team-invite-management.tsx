"use client";

import { useState } from "react";
import { MaterialTablePagination } from "@frely/console-ui/material-table-pagination";
import {
  TeamInviteManagement as SharedTeamInviteManagement,
} from "@frely/team-console-ui/client";
import type { TeamInviteActions } from "@frely/team-console-ui/models";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createWebTeamInvite,
  disableWebTeamInvite,
  updateWebTeamInviteSettings,
} from "../api/team-invite-api";
import { teamInviteQueryOptions } from "../query/team-invite-query";
import { teamInviteKeys } from "../query/team-invite-query-keys";

export function TeamInviteManagement({
  teamId,
  teamName,
  viewerUserId,
  inviteRegistrationBaseUrl,
}: {
  teamId: string;
  teamName: string;
  viewerUserId: string;
  inviteRegistrationBaseUrl: string;
}) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const queryClient = useQueryClient();
  const query = useQuery(teamInviteQueryOptions(teamId, teamName, viewerUserId, page, pageSize));
  const actions: TeamInviteActions = {
    createInvite: createWebTeamInvite,
    disableInvite: disableWebTeamInvite,
    updateInviteSettings: updateWebTeamInviteSettings,
    onSuccess: () => queryClient.invalidateQueries({
      queryKey: teamInviteKeys.audience(teamId, viewerUserId),
    }),
  };
  const state = query.isPending
    ? { status: "loading" as const }
    : query.error
      ? {
          status: "error" as const,
          message: query.error instanceof Error ? query.error.message : "Failed to load invitation settings",
        }
      : { status: "ready" as const, model: query.data };

  return <SharedTeamInviteManagement
    state={state}
    interactionMode="active"
    inviteRegistrationBaseUrl={inviteRegistrationBaseUrl}
    actions={actions}
    fetching={query.isFetching}
    onRetry={() => void query.refetch()}
    onPageChange={setPage}
    pagination={query.data ? <MaterialTablePagination
      page={query.data.links.page}
      pageSize={query.data.links.pageSize}
      total={query.data.links.total}
      totalPages={query.data.links.totalPages}
      onPageSizeChange={(nextPageSize) => { setPage(1); setPageSize(nextPageSize); }}
      {...(query.data.links.page > 1 ? { onPrevious: () => setPage((current) => current - 1) } : {})}
      {...(query.data.links.page < query.data.links.totalPages ? { onNext: () => setPage((current) => current + 1) } : {})}
      noun="invite links"
    /> : null}
  />;
}
