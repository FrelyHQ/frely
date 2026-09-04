import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthorityProductManagement } from "./components/authority-product-management";

vi.mock("@admin/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

describe("Authority Owner UI (REQ-MEMBER-020)", () => {
  test("uses typed runtime commercial fields without hard-coded price or validity defaults", () => {
    const markup = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><AuthorityProductManagement /></QueryClientProvider>);

    expect(markup).toContain("Create Draft Version");
    expect(markup).toContain("Purchase amount units");
    expect(markup).toContain("Grant duration seconds");
    expect(markup).toContain("Settlement hold seconds");
    expect(markup).toContain("Seller scope");
    expect(markup).not.toContain("script");
    expect(markup).not.toContain("Capability code");
    expect(markup).not.toContain("Role code");
    expect(markup).not.toMatch(/name="purchaseAmountUnits"[^>]*value=/);
    expect(markup).not.toMatch(/name="grantDurationSeconds"[^>]*value=/);
  });
});
