"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@frely/ui/components/button";
import { Tooltip } from "@frely/ui/components/tooltip";
import { ConsoleDialog } from "./console-dialog.js";

export interface RequestCaptureDetail {
  requestPayload: unknown | null;
  originalRequestPayload?: unknown | null;
  effectiveRequestPayload?: unknown | null;
  effectiveCaptureStatus?: "verified" | "unavailable";
  effectiveRepresentation?: "identity" | "rfc6902" | "full" | null;
  effectiveUnavailableReason?: string | null;
  requestCapturedAt: string | null;
  responseBody: unknown | null;
  responseStatus: number | null;
  responseErrorCode: string | null;
  responseCapturedAt: string | null;
  errorMessage: string;
}

export type RequestCaptureView = "original" | "effective" | "response";

export interface RequestCaptureViewResponse {
  view: RequestCaptureView;
  body: unknown | null;
  capturedAt: string | null;
  status?: number | null;
  errorCode?: string | null;
  effectiveStatus?: "verified" | "unavailable";
  effectiveRepresentation?: "identity" | "rfc6902" | "full" | null;
  effectiveUnavailableReason?: string | null;
}

export function parseRequestCaptureViewResponse(value: unknown): RequestCaptureViewResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Request Capture response");
  const record = value as Record<string, unknown>;
  if (
    !["original", "effective", "response"].includes(String(record.view))
    || (record.capturedAt !== null && typeof record.capturedAt !== "string")
    || (record.status !== undefined && record.status !== null && typeof record.status !== "number")
    || (record.errorCode !== undefined && record.errorCode !== null && typeof record.errorCode !== "string")
    || (record.effectiveStatus !== undefined && !["verified", "unavailable"].includes(String(record.effectiveStatus)))
    || (record.effectiveRepresentation !== undefined && record.effectiveRepresentation !== null && !["identity", "rfc6902", "full"].includes(String(record.effectiveRepresentation)))
    || (record.effectiveUnavailableReason !== undefined && record.effectiveUnavailableReason !== null && typeof record.effectiveUnavailableReason !== "string")
  ) throw new Error("Invalid Request Capture response");
  return {
    view: record.view as RequestCaptureView,
    body: record.body ?? null,
    capturedAt: record.capturedAt as string | null,
    ...(record.status === undefined ? {} : { status: record.status as number | null }),
    ...(record.errorCode === undefined ? {} : { errorCode: record.errorCode as string | null }),
    ...(record.effectiveStatus === undefined ? {} : { effectiveStatus: record.effectiveStatus as "verified" | "unavailable" }),
    ...(record.effectiveRepresentation === undefined ? {} : { effectiveRepresentation: record.effectiveRepresentation as "identity" | "rfc6902" | "full" | null }),
    ...(record.effectiveUnavailableReason === undefined ? {} : { effectiveUnavailableReason: record.effectiveUnavailableReason as string | null }),
  };
}

export interface RequestCaptureDetailItem {
  label: string;
  value: ReactNode;
  code?: boolean;
}

export interface LoadRequestCaptureInput {
  requestId: string;
  view: RequestCaptureView;
  signal?: AbortSignal;
}

export type LoadRequestCapture = (
  input: LoadRequestCaptureInput,
) => Promise<RequestCaptureViewResponse>;

export function RequestCaptureDownloadLink({ downloadUrl, children = "Download Capture v3" }: { downloadUrl: string; children?: ReactNode }) {
  return (
    <Button asChild size="sm" className="request-log-download-button">
      <a href={downloadUrl}>{children}</a>
    </Button>
  );
}

export function RequestCaptureDialog({
  mode = "raw",
  requestId,
  loadCapture,
  downloadUrl,
  queryNamespace,
  title,
  detailItems,
  onClose
}: {
  mode?: "raw" | "error";
  requestId: string;
  loadCapture: LoadRequestCapture;
  downloadUrl?: string;
  queryNamespace: readonly string[];
  title?: string;
  detailItems: RequestCaptureDetailItem[];
  onClose: () => void;
}) {
  const resolvedTitle = title ?? (mode === "raw" ? "Raw Request" : "Error Detail");
  const queryClient = useQueryClient();
  const initialView: RequestCaptureView = mode === "error" ? "response" : "original";
  const [requestView, setRequestView] = useState<RequestCaptureView>(initialView);
  const queryPrefix = [...queryNamespace, "request-capture", requestId] as const;
  const queryKey = [...queryPrefix, requestView] as const;
  const detailQuery = useQuery({
    queryKey,
    queryFn: ({ signal }) => loadCapture({ requestId, view: requestView, signal }),
    staleTime: 0,
    gcTime: 15_000,
    retry: false,
    refetchOnWindowFocus: false
  });
  const detail = detailQuery.data ?? null;
  const error = detailQuery.error instanceof Error ? detailQuery.error.message : detailQuery.error ? "Failed to load request detail" : "";

  useEffect(() => {
    setRequestView(initialView);
    return () => {
      void queryClient.cancelQueries({ queryKey: queryPrefix });
      queryClient.removeQueries({ queryKey: queryPrefix });
    };
  }, [queryClient, requestId, mode]);

  return (
    <ConsoleDialog
      observabilityKey="request-capture-detail"
      titleId="request-log-detail-dialog-title"
      eyebrow="Gateway Request"
      title={resolvedTitle}
      description={<code data-clarity-mask="true">{requestId}</code>}
      onClose={onClose}
    >
      <div className="request-log-detail">
        {mode === "raw" && downloadUrl ? (
          <div className="request-log-detail-actions">
            <RequestCaptureDownloadLink downloadUrl={downloadUrl} />
          </div>
        ) : null}
        <div className="request-log-detail-grid">
          {detailItems.map((item) => (
            <DetailItem key={item.label} label={item.label} value={item.value} code={item.code ?? false} />
          ))}
        </div>

        {mode === "error" ? (
          <>
            <DetailItem label="Message" value={errorMessageFromBody(detail?.body) || (detail || error ? "No captured error message" : "Loading...")} />
            <RawBlock title="Error Body" value={detail?.body ?? null} emptyText={error || (detail ? "No captured error body." : "Loading request detail...")} />
          </>
        ) : (
          <>
            <div className="request-log-detail-actions" role="tablist" aria-label="Captured request view">
              <ViewTab view="original" current={requestView} onSelect={setRequestView}>Original request</ViewTab>
              <ViewTab view="effective" current={requestView} onSelect={setRequestView}>Effective after ingress plugins</ViewTab>
              <ViewTab view="response" current={requestView} onSelect={setRequestView}>Raw response</ViewTab>
            </div>
            <RawBlock
              title={requestCaptureViewTitle(requestView, detail)}
              value={detail?.body ?? null}
              emptyText={error || requestCaptureViewEmptyText(requestView, detail)}
            />
          </>
        )}
      </div>
    </ConsoleDialog>
  );
}

function ViewTab({ view, current, onSelect, children }: { view: RequestCaptureView; current: RequestCaptureView; onSelect: (view: RequestCaptureView) => void; children: ReactNode }) {
  const selected = current === view;
  return <Button type="button" role="tab" aria-selected={selected} size="sm" variant={selected ? "default" : "secondary"} onClick={() => onSelect(view)}>{children}</Button>;
}

function requestCaptureViewTitle(view: RequestCaptureView, detail: RequestCaptureViewResponse | null): string {
  if (view === "original") return "Original request";
  if (view === "response") return "Raw Response";
  return `Effective after ingress plugins${detail?.effectiveRepresentation ? ` · ${representationLabel(detail.effectiveRepresentation)}` : ""}`;
}

function requestCaptureViewEmptyText(view: RequestCaptureView, detail: RequestCaptureViewResponse | null): string {
  if (!detail) return "Loading request detail...";
  if (view === "original") return "Request Capture was disabled or this request happened before capture.";
  if (view === "response") return "No captured response body.";
  return effectiveUnavailableText(detail.effectiveUnavailableReason);
}

function representationLabel(value: NonNullable<RequestCaptureViewResponse["effectiveRepresentation"]>): string {
  if (value === "identity") return "Verified · Identity";
  if (value === "rfc6902") return "Verified · JSON Patch";
  return "Verified · Full fallback";
}

function effectiveUnavailableText(reason?: string | null): string {
  if (reason === "legacy_original_only") return "Unavailable · This historical Capture did not save the request after ingress plugins.";
  if (reason === "ingress_plugin_failed") return "Unavailable · An ingress plugin failed before a complete effective request was produced.";
  return "Unavailable · The effective request could not be captured safely.";
}

function DetailItem({ label, value, code = false }: RequestCaptureDetailItem) {
  const textValue = typeof value === "string" || typeof value === "number";
  return (
    <div className="request-log-detail-item">
      <span>{label}</span>
      {code && textValue
        ? <code data-clarity-mask="true">{value}</code>
        : textValue
          ? <strong data-clarity-mask="true">{value}</strong>
          : <div className="request-log-detail-value" data-clarity-mask="true">{value}</div>}
    </div>
  );
}

function RawBlock({ title, value, emptyText }: { title: string; value: unknown | null; emptyText: string }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const content = useMemo(() => value === null ? null : formatJson(value), [value]);

  useEffect(() => {
    setCopyState("idle");
  }, [content]);

  function copyContent() {
    if (content === null) return;
    void navigator.clipboard.writeText(content).then(
      () => setCopyState("copied"),
      () => setCopyState("failed")
    );
  }

  return (
    <section className="request-log-raw-block">
      <div className="request-log-raw-heading">
        <h3>{title}</h3>
        <Tooltip content={`Copy ${title}`} wrapTrigger={content === null}>
          <Button type="button" variant="secondary" size="sm" disabled={content === null} onClick={copyContent}>
            {copyState === "copied" ? "Copied" : copyState === "failed" ? "Failed" : "Copy"}
          </Button>
        </Tooltip>
      </div>
      {value === null ? (
        <div className="empty-inline">{emptyText}</div>
      ) : (
        <pre data-clarity-mask="true">{content}</pre>
      )}
    </section>
  );
}

function formatJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function errorMessageFromBody(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const record = body as Record<string, unknown>;
  const error = record.error;
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const message = (error as Record<string, unknown>).message;
    return typeof message === "string" ? message : "";
  }
  return typeof record.message === "string" ? record.message : "";
}
