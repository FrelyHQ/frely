"use client";

import React, { useState } from "react";
import { Badge } from "@frely/ui/components/badge";
import { Button } from "@frely/ui/components/button";
import { BrowserTime } from "@frely/ui/components/browser-time";
import { Tooltip } from "@frely/ui/components/tooltip";
import { formatUtcDateTime } from "@frely/ui/lib/date-time";
import { MaterialTable } from "./material-table.js";
import {
  RequestCaptureDialog,
  type LoadRequestCapture,
} from "./request-capture-dialog.js";

type Tone = "good" | "warn" | "bad" | "neutral" | "info";

export interface UserRequestHistoryTableRow {
  id: string;
  kind: string;
  startedAt: string;
  endedAt: string | null;
  status: string;
  errorCode: string | null;
  requestPath: string | null;
  model: string;
  apiKey: {
    id: string;
    name: string;
    prefix: string;
  };
  capture: {
    requestPresent: boolean;
    responsePresent: boolean;
    downloadable: boolean;
  };
}

export interface UserRequestHistoryCapturePort {
  loadCapture: LoadRequestCapture;
  downloadHref: (requestId: string) => string;
  queryNamespace: readonly string[];
}

export function UserRequestHistoryTable({
  rows,
  interactionMode,
  capturePort,
}: {
  rows: UserRequestHistoryTableRow[];
  interactionMode: "active" | "preview";
  capturePort?: UserRequestHistoryCapturePort;
}) {
  const [dialogRow, setDialogRow] = useState<UserRequestHistoryTableRow | null>(null);
  const [copyFeedback, setCopyFeedback] = useState("");
  const captureActive = interactionMode === "active" && capturePort !== undefined;

  async function copyRequestId(requestId: string) {
    try {
      await navigator.clipboard.writeText(requestId);
      setCopyFeedback("Request ID copied");
    } catch {
      setCopyFeedback("Unable to copy request ID");
    }
  }

  return (
    <>
      <MaterialTable
        columns={[
          { header: "Time", minWidth: 190 },
          { header: "Request", width: 96 },
          { header: "Status" },
          { header: "Error", width: 88 },
          { header: "Path", minWidth: 190 },
          { header: "Model", width: 120 },
          { header: "API Key", minWidth: 220 },
          { header: "Duration" },
          { header: "Capture", width: 112 },
        ]}
        rows={rows.map((row) => ({
          id: row.id,
          cells: [
            <span data-clarity-mask="true"><BrowserTime value={row.startedAt} seconds /></span>,
            <Tooltip content="Copy full request ID">
              <Button
                type="button"
                variant="link"
                aria-label={`Copy full request ID ${row.id}`}
                onClick={() => void copyRequestId(row.id)}
              >
                <code data-clarity-mask="true">{shortRequestId(row.id)}</code>
              </Button>
            </Tooltip>,
            <Badge variant={statusTone(row.status)}>{row.status}</Badge>,
            <code data-clarity-mask="true">{row.errorCode ?? "None"}</code>,
            captureActive ? (
              <Tooltip content="View captured request and response">
                <Button
                  type="button"
                  variant="link"
                  className="request-log-cell-button"
                  disabled={!row.capture.requestPresent && !row.capture.responsePresent}
                  onClick={() => setDialogRow(row)}
                >
                  <span className="flex flex-col items-start gap-1">
                    <code data-clarity-mask="true">{row.requestPath ?? "Unknown"}</code>
                    <span className="muted" data-clarity-mask="true">{row.kind}</span>
                  </span>
                </Button>
              </Tooltip>
            ) : (
              <span className="flex flex-col items-start gap-1">
                <code data-clarity-mask="true">{row.requestPath ?? "Unknown"}</code>
                <span className="muted" data-clarity-mask="true">{row.kind}</span>
              </span>
            ),
            <span data-clarity-mask="true">{row.model}</span>,
            <span data-clarity-mask="true">{row.apiKey.name}<br /><code>{row.apiKey.prefix || row.apiKey.id}</code></span>,
            <span data-clarity-mask="true">{formatDuration(row.startedAt, row.endedAt)}</span>,
            captureActive && row.capture.downloadable ? (
              <Button asChild size="sm">
                <a href={capturePort.downloadHref(row.id)} download>Download</a>
              </Button>
            ) : interactionMode === "preview" && row.capture.downloadable ? (
              <Button type="button" size="sm" variant="secondary" disabled title="Capture actions are disabled in audience preview">
                Preview only
              </Button>
            ) : (
              <Button type="button" size="sm" variant="secondary" disabled title="Capture is unavailable">
                Unavailable
              </Button>
            ),
          ],
        }))}
        emptyState={{ title: "No request logs match the current filters." }}
        table={{ minWidth: 1180, stickyHeader: true }}
      />

      <span className="sr-only" role="status" aria-live="polite">{copyFeedback}</span>

      {dialogRow && capturePort ? (
        <RequestCaptureDialog
          requestId={dialogRow.id}
          queryNamespace={capturePort.queryNamespace}
          loadCapture={capturePort.loadCapture}
          downloadUrl={capturePort.downloadHref(dialogRow.id)}
          detailItems={[
            { label: "Time", value: formatUtcDateTime(dialogRow.startedAt, { seconds: true }) },
            { label: "Status", value: dialogRow.status },
            { label: "Error", value: dialogRow.errorCode ?? "None" },
            { label: "Path", value: dialogRow.requestPath ?? "Unknown", code: true },
            { label: "Model", value: dialogRow.model },
            { label: "API Key", value: dialogRow.apiKey.prefix || dialogRow.apiKey.id, code: true },
            { label: "Duration", value: formatDuration(dialogRow.startedAt, dialogRow.endedAt) },
          ]}
          onClose={() => setDialogRow(null)}
        />
      ) : null}
    </>
  );
}

function shortRequestId(requestId: string) {
  return requestId.length > 8 ? `${requestId.slice(0, 8)}…` : requestId;
}

function statusTone(status: string): Tone {
  if (status === "completed") return "good";
  if (status === "failed") return "bad";
  if (status === "started") return "warn";
  return "neutral";
}

function formatDuration(startedAt: string, endedAt: string | null) {
  if (!endedAt) return "Open";
  const startMs = Date.parse(startedAt);
  const endMs = Date.parse(endedAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return "Unknown";
  return `${endMs - startMs}ms`;
}
