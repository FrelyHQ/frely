import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { TooltipProvider } from "@frely/ui/components/tooltip";
import { UserRequestHistoryTable } from "./request-history-table.js";

describe("UserRequestHistoryTable", () => {
  test("keeps capture facts visible but disables sensitive ports in preview", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <UserRequestHistoryTable
          interactionMode="preview"
          rows={[{
            id: "req_preview",
            kind: "responses",
            startedAt: "2026-07-27T12:00:00.000Z",
            endedAt: "2026-07-27T12:00:01.000Z",
            status: "completed",
            errorCode: null,
            requestPath: "/v1/responses",
            model: "gpt-test",
            apiKey: { id: "key_preview", name: "Preview", prefix: "sk-preview" },
            capture: { requestPresent: true, responsePresent: true, downloadable: true },
          }]}
        />
      </TooltipProvider>,
    );

    expect(html).toContain("Preview only");
    expect(html).toContain("/v1/responses");
    expect(html).not.toContain("/api/user");
    expect(html).not.toContain("/api/owner");
    expect(html).not.toContain("View captured request and response");
    expect(html).toContain('<code data-clarity-mask="true">/v1/responses</code>');
    expect(html).toContain('<span data-clarity-mask="true">Preview<br/><code>sk-preview</code></span>');
    expect(html).toContain("<th");
    expect(html).not.toContain('<th data-clarity-mask="true"');
  });
});
