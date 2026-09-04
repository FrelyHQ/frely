// @vitest-environment jsdom

import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@frely/ui/components/tooltip";
import type { ReactNode } from "react";
import { createConsoleQueryClient } from "./query-client.js";
import { RequestCaptureDialog, type RequestCaptureView } from "./request-capture-dialog.js";

afterEach(() => {
  cleanup();
});

beforeAll(() => vi.stubGlobal("ResizeObserver", class {
  observe() {}
  unobserve() {}
  disconnect() {}
}));

afterAll(() => vi.unstubAllGlobals());

describe("RequestCaptureDialog", () => {
  test("loads only the active raw view and removes sensitive query data on close", async () => {
    const queryClient = createConsoleQueryClient();
    const loadCapture = captureLoader();
    const user = userEvent.setup();
    const onClose = vi.fn();
    const rendered = render(
      <Providers queryClient={queryClient}>
        <RequestCaptureDialog
          requestId="req_view"
          loadCapture={loadCapture}
          downloadUrl="/api/owner/request-logs/req_view/capture/download"
          queryNamespace={["admin"]}
          detailItems={[]}
          onClose={onClose}
        />
      </Providers>
    );

    expect(await screen.findByText(/original-value/)).toBeInTheDocument();
    expect(requestedViews(loadCapture)).toEqual(["original"]);

    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith(JSON.stringify({ original: "original-value" }, null, 2));

    await user.click(screen.getByRole("tab", { name: "Effective after ingress plugins" }));
    expect(await screen.findByText(/effective-value/)).toBeInTheDocument();
    expect(requestedViews(loadCapture)).toEqual(["original", "effective"]);

    await user.click(screen.getByRole("tab", { name: "Raw response" }));
    expect(await screen.findByText(/response-value/)).toBeInTheDocument();
    expect(requestedViews(loadCapture)).toEqual(["original", "effective", "response"]);

    rendered.unmount();
    await waitFor(() => expect(queryClient.getQueryCache().findAll({ queryKey: ["admin", "request-capture", "req_view"] })).toHaveLength(0));
  });

  test("loads only the response view for error detail", async () => {
    const queryClient = createConsoleQueryClient();
    const loadCapture = captureLoader();
    render(
      <Providers queryClient={queryClient}>
        <RequestCaptureDialog
          mode="error"
          requestId="req_error"
          loadCapture={loadCapture}
          queryNamespace={["admin"]}
          detailItems={[]}
          onClose={() => undefined}
        />
      </Providers>
    );

    expect(await screen.findByText(/response-value/)).toBeInTheDocument();
    expect(requestedViews(loadCapture)).toEqual(["response"]);
  });
});

function Providers({ queryClient, children }: { queryClient: ReturnType<typeof createConsoleQueryClient>; children: ReactNode }) {
  return <QueryClientProvider client={queryClient}><TooltipProvider>{children}</TooltipProvider></QueryClientProvider>;
}

function captureLoader() {
  return vi.fn(async ({ view }: { view: RequestCaptureView }) => {
    const body = view === "original"
      ? { original: "original-value" }
      : view === "effective"
        ? { effective: "effective-value" }
        : { response: "response-value" };
    return { view, body, capturedAt: "2026-07-16T00:00:00.000Z", ...(view === "effective" ? { effectiveStatus: "verified" as const, effectiveRepresentation: "identity" as const } : {}) };
  });
}

function requestedViews(loadCapture: ReturnType<typeof captureLoader>): string[] {
  return loadCapture.mock.calls.map(([input]) => input.view);
}
