// @vitest-environment jsdom

import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { TooltipProvider } from "@frely/ui/components/tooltip";
import { RequestHistoryTable, type UserRequestHistoryRow } from "./request-history-table";

afterEach(cleanup);
beforeAll(() => vi.stubGlobal("ResizeObserver", class {
  observe() {}
  unobserve() {}
  disconnect() {}
}));
afterAll(() => vi.unstubAllGlobals());

const availableRow: UserRequestHistoryRow = {
  id: "req_1234567890",
  kind: "chat.completions",
  startedAt: "2026-07-10T06:10:11.000Z",
  endedAt: "2026-07-10T06:10:12.000Z",
  status: "completed",
  errorCode: null,
  requestPath: "/v1/chat/completions",
  model: "gpt-5",
  apiKey: { id: "key_production", name: "Production key", prefix: "fr_live_12" },
  capture: { requestPresent: true, responsePresent: true, downloadable: true },
};

// REQ-MEMBER-009: the request history row exposes the authorized single-capture download.
describe("RequestHistoryTable", () => {
  test("uses the requested column order and keeps request kind in Path", () => {
    render(<TooltipProvider><RequestHistoryTable rows={[availableRow]} /></TooltipProvider>);

    const headers = screen.getAllByRole("columnheader");
    expect(headers.map((header) => header.textContent)).toEqual([
      "Time", "Request", "Status", "Error", "Path", "Model", "API Key", "Duration", "Capture"
    ]);
    expect(headers[0]).toHaveStyle({ minWidth: "190px" });
    expect(headers[1]).toHaveStyle({ width: "96px" });
    expect(headers[5]).toHaveStyle({ width: "120px" });
    expect(headers[6]).toHaveStyle({ minWidth: "220px" });
    expect(screen.getByText("req_1234…")).toBeInTheDocument();
    expect(screen.getByText("chat.completions")).toBeInTheDocument();
    expect(document.querySelectorAll("time")).toHaveLength(1);
  });

  test("copies the full request id and downloads only an available row capture", async () => {
    const unavailableRow = {
      ...availableRow,
      id: "req_unavailable",
      capture: { requestPresent: false, responsePresent: false, downloadable: false },
    };
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    render(<TooltipProvider><RequestHistoryTable rows={[availableRow, unavailableRow]} /></TooltipProvider>);

    await user.click(screen.getByRole("button", { name: `Copy full request ID ${availableRow.id}` }));
    expect(writeText).toHaveBeenCalledWith(availableRow.id);
    expect(screen.getByRole("status")).toHaveTextContent("Request ID copied");

    expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute(
      "href",
      "/api/user/request-logs/req_1234567890/capture/download"
    );
    expect(screen.getByRole("button", { name: "Unavailable" })).toBeDisabled();
  });
});
