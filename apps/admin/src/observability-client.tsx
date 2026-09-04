"use client";

import { useLocation } from "@tanstack/react-router";
import { installSurfaceRuntime } from "@frely/observability/client-runtime";
import type { RouteRegistry, WebVitalName } from "@frely/observability/contracts";
import { onCLS, onFCP, onINP, onLCP, onTTFB, type MetricType } from "web-vitals";
import { useEffect, useMemo, useRef, type HTMLAttributes, type ReactNode } from "react";

interface DocumentWebVitalsRegistration {
  initialRoute: string;
  report: ((name: WebVitalName, value: number, initialRoute: string) => void) | null;
}

const documentWebVitalsRegistrations = new WeakMap<Document, DocumentWebVitalsRegistration>();

export function AdminUiSurfaceProvider({
  children,
  endpoint,
  release,
  routeRegistry,
  traceSampleRatio,
}: {
  children: ReactNode;
  endpoint?: string;
  release: string;
  routeRegistry: RouteRegistry;
  traceSampleRatio?: number;
}) {
  const pathname = useLocation({ select: (location) => location.pathname });
  const documentPathname = useRef(pathname).current;
  const installed = useMemo(() => ({ current: null as ReturnType<typeof installSurfaceRuntime> | null }), []);

  useEffect(() => {
    const value = installSurfaceRuntime({
      ...(endpoint === undefined ? {} : { endpoint }),
      release,
      routes: routeRegistry,
      ...(traceSampleRatio === undefined ? {} : { traceSampleRatio }),
    });
    installed.current = value;
    return () => {
      value.dispose();
      installed.current = null;
    };
  }, [endpoint, installed, release, routeRegistry, traceSampleRatio]);

  useEffect(() => {
    installed.current?.runtime.onPathname(pathname);
  }, [installed, pathname]);

  useEffect(() => registerDocumentWebVitals(document, documentPathname, (name, value, initialRoute) => {
    installed.current?.runtime.reportWebVital(name, value, initialRoute);
  }), [documentPathname, installed]);

  return children;
}

export function AdminPageSurfaceContent({
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  const pathname = useLocation({ select: (location) => location.pathname });
  return (
    <div
      data-ui-page-surface-pathname={pathname}
      data-ui-page-surface-ready="true"
      {...props}
    >
      {children}
    </div>
  );
}

function registerDocumentWebVitals(
  ownerDocument: Document,
  initialRoute: string,
  report: NonNullable<DocumentWebVitalsRegistration["report"]>,
): () => void {
  let registration = documentWebVitalsRegistrations.get(ownerDocument);
  if (!registration) {
    registration = { initialRoute, report: null };
    documentWebVitalsRegistrations.set(ownerDocument, registration);
    observeWebVitals(registration);
  }
  registration.report = report;
  return () => {
    if (registration.report === report) registration.report = null;
  };
}

function observeWebVitals(registration: DocumentWebVitalsRegistration): void {
  const callback = (metric: MetricType) => {
    if (Number.isFinite(metric.value)) {
      registration.report?.(metric.name, metric.value, registration.initialRoute);
    }
  };
  onCLS(callback);
  onFCP(callback);
  onINP(callback);
  onLCP(callback);
  onTTFB(callback);
}
