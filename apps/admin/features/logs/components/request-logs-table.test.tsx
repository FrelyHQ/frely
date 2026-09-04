// @vitest-environment jsdom

import React, { type ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@frely/ui/components/tooltip";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import type { RequestLogRow } from "../lib/request-log-display";
import { RequestErrorDiagnosticDialog } from "./request-logs-table";

afterEach(cleanup);

beforeAll(() => vi.stubGlobal("ResizeObserver", class {
  observe() {}
  unobserve() {}
  disconnect() {}
}));

afterAll(() => vi.unstubAllGlobals());

describe("Request Logs Capture actions (REQ-GA-007)", () => {
  it("downloads a Capture directly from Error Detail without opening Raw Request", async () => {
    render(
      <RequestErrorDiagnosticDialog
        row={requestLogRow()}
        downloadUrl="/api/owner/request-logs/req_error/capture/download"
        onViewRaw={() => undefined}
        onClose={() => undefined}
      />,
      { wrapper: TestProviders }
    );

    expect(screen.getByRole("heading", { name: "Error Detail" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View raw capture" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download Capture" })).toHaveAttribute(
      "href",
      "/api/owner/request-logs/req_error/capture/download"
    );
    expect(screen.queryByRole("heading", { name: "Raw Request" })).not.toBeInTheDocument();
  });
});

function TestProviders({ children }: { children: ReactNode }) {
  return <TooltipProvider>{children}</TooltipProvider>;
}

function requestLogRow(): RequestLogRow {
  return {
    id: "req_error",
    startedAt: "2026-07-19T00:00:00.000Z",
    time: "2026-07-19 08:00:00",
    duration: "1.25s",
    status: "Failed",
    statusTone: "bad",
    errorCode: "provider_error",
    ingressPlugins: [],
    ingressHostname: "relay.example.test",
    ingressRouteId: "edge:relay.hk-v1",
    pipelinePlugins: [],
    requestPath: "/v1/responses",
    provider: "Example Provider",
    model: "example-model",
    apiKey: "sk-example",
    user: "user@example.com",
    team: "Example Team"
  };
}
