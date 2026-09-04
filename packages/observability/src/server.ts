import {
  SpanKind,
  SpanStatusCode,
  context,
  metrics,
  propagation,
  trace,
  type Attributes,
  type Histogram,
  type Meter,
  type Span,
} from "@opentelemetry/api";
import { readBoundedRequestText, RelayError, resolveExternalRequestOrigin } from "@frely/core";
import { normalizeRelease, parseBrowserMeasurement, type BrowserMeasurement } from "./contracts.js";

export interface BrowserTelemetryHandlerOptions {
  dialogNames: readonly string[];
  release: string;
  routeNames: readonly string[];
  service: "admin" | "web";
}

export interface RepositoryCollectionAttributes {
  itemsReturned?: number;
  pageSize?: number;
  returnedRows?: number;
}

export type RepositoryOperation = "queries.teams.pageDirectory";

export async function traceHttpRequest(
  request: Request,
  work: () => Promise<Response>,
): Promise<Response> {
  let parent = context.active();
  try {
    parent = propagation.extract(parent, request.headers, {
      get(carrier, key) {
        return carrier.get(key) ?? undefined;
      },
      keys(carrier) {
        return [...carrier.keys()];
      },
    });
  } catch {
    // Malformed external propagation is ignored without reflecting header data.
  }
  const tracer = trace.getTracer("@frely/observability");
  return context.with(parent, () => tracer.startActiveSpan("friday.http.request", {
    kind: SpanKind.SERVER,
    attributes: { "http.request.method": request.method },
  }, async (span) => {
    let ended = false;
    const finish = (terminal: "success" | "cancelled" | "failed") => {
      if (ended) return;
      ended = true;
      span.setAttribute("terminal", terminal);
      if (terminal === "failed") span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
    };
    try {
      const response = await work();
      span.setAttribute("http.response.status_code", response.status);
      if (response.status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      if (!response.body) {
        finish("success");
        return response;
      }
      return responseWithHttpSpanLifecycle(response, finish);
    } catch (error) {
      finish("failed");
      throw error;
    }
  }));
}

function responseWithHttpSpanLifecycle(
  response: Response,
  finish: (terminal: "success" | "cancelled" | "failed") => void,
): Response {
  const source = response.body;
  if (!source) return response;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let cancelRequested = false;
  const sourceReader = () => reader ??= source.getReader();
  const releaseReader = () => {
    try {
      reader?.releaseLock();
    } catch {
      // A pending read owns the lock until it settles.
    }
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await sourceReader().read();
        if (cancelRequested) return;
        if (next.done) {
          releaseReader();
          controller.close();
          finish("success");
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        if (cancelRequested) return;
        releaseReader();
        finish("failed");
        controller.error(error);
      }
    },
    async cancel(reason) {
      cancelRequested = true;
      try {
        await sourceReader().cancel(reason);
        finish("cancelled");
      } catch (error) {
        finish("failed");
        throw error;
      } finally {
        releaseReader();
      }
    },
  }, { highWaterMark: 0 });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

const MAX_BODY_BYTES = 2_048;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT_PER_PROCESS = 1_200;
let rateWindowStartedAt = 0;
let rateWindowCount = 0;
const histogramCache = new Map<string, Histogram>();

export function createBrowserTelemetryHandler(options: BrowserTelemetryHandlerOptions) {
  const routeNames = new Set(options.routeNames);
  const dialogNames = new Set(options.dialogNames);
  const normalizedOptions = { ...options, release: normalizeRelease(options.release) };

  return async function POST(request: Request): Promise<Response> {
    if (!isSameOrigin(request)) return new Response(null, { status: 403 });
    if (!takeRateToken()) return new Response(null, { status: 429 });
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      return new Response(null, { status: 415 });
    }
    let raw = "";
    try {
      raw = await readBoundedRequestText(request, MAX_BODY_BYTES);
    } catch (error) {
      if (error instanceof RelayError && error.status === 413) return new Response(null, { status: 413 });
      return new Response(null, { status: 400 });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return new Response(null, { status: 400 });
    }
    const measurement = parseBrowserMeasurement(parsed, { dialogNames, routeNames });
    if (!measurement) return new Response(null, { status: 400 });

    try {
      const extracted = propagation.extract(context.active(), request.headers, {
        get(carrier, key) {
          return carrier.get(key) ?? undefined;
        },
        keys(carrier) {
          return [...carrier.keys()];
        },
      });
      context.with(extracted, () => recordBrowserMeasurement(measurement, normalizedOptions));
    } catch {
      // Export failures are deliberately detached from the UI outcome.
    }
    return new Response(null, { status: 202 });
  };
}

export function recordRepositoryOperation<T>(
  operation: RepositoryOperation,
  work: (span: Span) => T,
  collection: RepositoryCollectionAttributes = {},
): T {
  const tracer = trace.getTracer("@frely/observability");
  return tracer.startActiveSpan("friday.repository.operation", {
    attributes: repositoryAttributes(operation, collection),
  }, (span) => {
    try {
      const result = work(span);
      if (isPromiseLike(result)) {
        return result.then(
          (value) => {
            finishRepositorySpan(span, collection, true);
            return value;
          },
          (error) => {
            finishRepositorySpan(span, collection, false);
            throw error;
          },
        ) as T;
      }
      finishRepositorySpan(span, collection, true);
      return result;
    } catch (error) {
      finishRepositorySpan(span, collection, false);
      throw error;
    }
  });
}

export async function traceRscPreparation<T>(
  route: string,
  work: () => Promise<T> | T,
): Promise<T> {
  const tracer = trace.getTracer("@frely/observability");
  return tracer.startActiveSpan("friday.rsc.prepare", {
    attributes: { route },
  }, async (span) => {
    try {
      const result = await work();
      span.setAttribute("terminal", "success");
      return result;
    } catch (error) {
      span.setAttribute("terminal", "failed");
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

function recordBrowserMeasurement(
  measurement: BrowserMeasurement,
  options: BrowserTelemetryHandlerOptions,
): void {
  const meter = metrics.getMeter("@frely/observability");
  if (measurement.kind === "ui_surface") {
    const attributes = {
      service: options.service,
      surface_type: measurement.surfaceType,
      surface_name: measurement.surfaceName,
      result: measurement.result,
      release: options.release,
    };
    histogram(meter, "ui_surface_open_duration_ms", "ms")
      .record(measurement.durationMs, attributes);
    const tracer = trace.getTracer("@frely/observability");
    const endedAt = Date.now();
    const span = tracer.startSpan("friday.ui.surface.open", {
      startTime: new Date(endedAt - measurement.durationMs),
      attributes,
    });
    span.setAttribute("browser.duration_ms", measurement.durationMs);
    if (measurement.result === "failed" || measurement.result === "timeout") {
      span.setStatus({ code: SpanStatusCode.ERROR });
    }
    span.end(new Date(endedAt));
    return;
  }

  const metricName = `web_vital_${measurement.name.toLowerCase()}_${measurement.name === "CLS" ? "score" : "ms"}`;
  histogram(meter, metricName, measurement.name === "CLS" ? "1" : "ms").record(
    measurement.value,
    {
      service: options.service,
      route: measurement.routeName,
      release: options.release,
    },
  );
}

function histogram(
  meter: Meter,
  name: string,
  unit: string,
) {
  const existing = histogramCache.get(name);
  if (existing) return existing;
  const created = meter.createHistogram(name, { unit });
  histogramCache.set(name, created);
  return created;
}

function repositoryAttributes(operation: string, collection: RepositoryCollectionAttributes): Attributes {
  return {
    operation,
    ...(collection.pageSize === undefined ? {} : { "friday.collection.page_size": collection.pageSize }),
    ...(collection.itemsReturned === undefined ? {} : { "friday.collection.items_returned": collection.itemsReturned }),
    ...(collection.returnedRows === undefined ? {} : { "db.response.returned_rows": collection.returnedRows }),
  };
}

function applyCollectionAttributes(span: Span, collection: RepositoryCollectionAttributes): void {
  if (collection.pageSize !== undefined) span.setAttribute("friday.collection.page_size", collection.pageSize);
  if (collection.itemsReturned !== undefined) span.setAttribute("friday.collection.items_returned", collection.itemsReturned);
  if (collection.returnedRows !== undefined) span.setAttribute("db.response.returned_rows", collection.returnedRows);
}

function finishRepositorySpan(
  span: Span,
  collection: RepositoryCollectionAttributes,
  succeeded: boolean,
): void {
  span.setAttribute("terminal", succeeded ? "success" : "failed");
  if (succeeded) applyCollectionAttributes(span, collection);
  else span.setStatus({ code: SpanStatusCode.ERROR });
  span.end();
}

function isPromiseLike<T>(value: T): value is T & PromiseLike<Awaited<T>> {
  return (typeof value === "object" || typeof value === "function")
    && value !== null
    && typeof (value as { then?: unknown }).then === "function";
}

function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const expectedOrigin = trustedRequestOrigin(request);
  if (!origin || !expectedOrigin || origin.includes(",") || origin !== expectedOrigin) return false;
  const fetchSite = request.headers.get("sec-fetch-site");
  return fetchSite === null || fetchSite === "same-origin";
}

function trustedRequestOrigin(request: Request): string | null {
  return resolveExternalRequestOrigin(request);
}

function takeRateToken(): boolean {
  const now = Date.now();
  if (now - rateWindowStartedAt >= RATE_WINDOW_MS) {
    rateWindowStartedAt = now;
    rateWindowCount = 0;
  }
  rateWindowCount += 1;
  return rateWindowCount <= RATE_LIMIT_PER_PROCESS;
}
