"use client";

import React, { useEffect, useMemo, useState } from "react";
import { RequestCaptureDialog, RequestCaptureDownloadLink } from "@frely/console-ui/request-capture-dialog";
import { ConsoleDialog } from "@frely/console-ui/console-dialog";
import { DataTable } from "@frely/console-ui/data-table";
import { PipelinePluginChips } from "@frely/console-ui/pipeline-plugin-chips";
import { Button } from "@frely/ui/components/button";
import type { RequestLogRow } from "../lib/request-log-display";
import { requestLogColumns } from "../table/request-log-columns";
import { loadAdminRequestCapture } from "../api/request-log-api";

export function RequestLogsTable({ rows }: { rows: RequestLogRow[] }) {
  const [dialog, setDialog] = useState<{ mode: "raw" | "error"; row: RequestLogRow } | null>(null);
  const [copyToast, setCopyToast] = useState<{ message: string; tone: "success" | "error" } | null>(null);
  useEffect(() => {
    let requestId = "";
    try { requestId = decodeURIComponent(window.location.hash.replace(/^#/, "")); } catch { return; }
    const row = rows.find((item) => item.id === requestId);
    if (row) setDialog({ mode: "error", row });
  }, [rows]);
  useEffect(() => {
    if (!copyToast) return;
    const timer = window.setTimeout(() => setCopyToast(null), 1800);
    return () => window.clearTimeout(timer);
  }, [copyToast]);
  const columns = useMemo(() => requestLogColumns({
    copyId: (id) => void navigator.clipboard.writeText(id).then(() => setCopyToast({ message: "Request ID copied", tone: "success" }), () => setCopyToast({ message: "Copy failed", tone: "error" })),
    openCapture: (mode, row) => setDialog({ mode, row })
  }), []);
  const captureUrls = dialog ? requestCaptureUrls(dialog.row.id) : null;

  return <>
    <DataTable data={rows} columns={columns} getRowId={(row) => row.id} serverManaged emptyState={{ title: "No request logs match this filter." }} />
    {dialog?.mode === "raw" ? <RequestCaptureDialog
      mode="raw"
      requestId={dialog.row.id}
      queryNamespace={["owner"]}
      loadCapture={loadAdminRequestCapture}
      downloadUrl={captureUrls!.download}
      detailItems={[
        { label: "Time", value: dialog.row.time }, { label: "Status", value: dialog.row.status },
        { label: "Error", value: dialog.row.errorCode }, { label: "Path", value: dialog.row.requestPath, code: true },
        { label: "Provider", value: dialog.row.provider }, { label: "Model", value: dialog.row.model },
        { label: "Pipeline Plugins", value: <PipelinePluginChips plugins={dialog.row.pipelinePlugins} /> }
      ]}
      onClose={() => setDialog(null)}
    /> : null}
    {dialog?.mode === "error" ? <RequestErrorDiagnosticDialog row={dialog.row} downloadUrl={captureUrls!.download} onViewRaw={() => setDialog({ mode: "raw", row: dialog.row })} onClose={() => setDialog(null)} /> : null}
    {copyToast ? <div className="request-log-copy-toast" data-tone={copyToast.tone} role="status" aria-live="polite">{copyToast.message}</div> : null}
  </>;
}

export function RequestErrorDiagnosticDialog({ row, downloadUrl, onViewRaw, onClose }: { row: RequestLogRow; downloadUrl: string; onViewRaw: () => void; onClose: () => void }) {
  const details: Array<{ label: string; value: string; code?: boolean }> = [
    { label: "Code", value: row.errorCode, code: true },
    { label: "Elapsed", value: row.duration }
  ];
  return (
    <ConsoleDialog observabilityKey="request-log-error" titleId="request-log-error-dialog-title" eyebrow="Gateway Request" title="Error Detail" description={<code>{row.id}</code>} onClose={onClose}>
      <div className="request-log-detail">
        <p>Structured diagnostics are available only in operational Gateway logs.</p>
        <div className="request-log-detail-grid">
          {details.map((item) => <div className="request-log-detail-item" key={item.label}><span>{item.label}</span>{item.code ? <code>{item.value}</code> : <strong>{item.value}</strong>}</div>)}
        </div>
        <div className="request-log-detail-actions">
          <Button type="button" variant="secondary" size="sm" onClick={onViewRaw}>View raw capture</Button>
          <RequestCaptureDownloadLink downloadUrl={downloadUrl}>Download Capture</RequestCaptureDownloadLink>
        </div>
      </div>
    </ConsoleDialog>
  );
}

function requestCaptureUrls(requestId: string) {
  const base = `/api/owner/request-logs/${encodeURIComponent(requestId)}/capture`;
  return { view: base, download: `${base}/download` };
}
