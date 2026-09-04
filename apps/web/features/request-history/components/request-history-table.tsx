"use client";

import React from "react";
import {
  UserRequestHistoryTable,
  type UserRequestHistoryTableRow,
} from "@frely/console-ui/request-history-table";
import { loadWebRequestCapture } from "../api/request-history-api";

export type UserRequestHistoryRow = UserRequestHistoryTableRow;

export function RequestHistoryTable({ rows }: { rows: UserRequestHistoryRow[] }) {
  return (
    <UserRequestHistoryTable
      rows={rows}
      interactionMode="active"
      capturePort={{
        loadCapture: loadWebRequestCapture,
        downloadHref: (requestId) => `/api/user/request-logs/${encodeURIComponent(requestId)}/capture/download`,
        queryNamespace: ["web", "user"],
      }}
    />
  );
}
