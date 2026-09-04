// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, test, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UserAuthority } from "./components/user-authority";

const refresh = vi.fn();
vi.mock("@web/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  refresh.mockReset();
});

describe("personal Provider renewal confirmation", () => {
  test("does not purchase before a Dialog shows the exact slot and current product terms", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } }));
    render(<QueryClientProvider client={new QueryClient()}><UserAuthority
      products={{ items: [], page: 1, pageSize: 20, total: 0, totalPages: 1 }}
      grants={{ items: [], page: 1, pageSize: 20, total: 0, totalPages: 1 }}
      canCreateTeam={false}
      personalCreditBalanceUnits={1_000}
      personalProviderProduct={{ id: "product_provider", code: "personal-provider", version: 3, displayName: "Personal Provider", effectCode: "user_custom_provider_access", grantUnits: 1, purchaseAmountUnits: 500, grantDurationSeconds: 31_536_000, refundMode: "none", refundDeadlineSeconds: null, maxCurrentOwnedTeams: null, maxLifetimeCreatedTeams: null }}
      providerSlots={[{ id: "provider_slot_1", providerId: "prv_1", lifecycle: "expired_hot", latestEffectiveEnd: "2027-01-01T00:00:00.000Z", renewalCutoff: "2027-06-30T00:00:00.000Z", usedAccessPoints: 42, maxAccessPoints: 100 }]}
      providerSlotTotal={1}
    /></QueryClientProvider>);

    fireEvent.click(screen.getByRole("button", { name: "Review renewal" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toHaveTextContent("provider_slot_1");
    expect(screen.getByRole("dialog")).toHaveTextContent("2027-01-01T00:00:00.000Z");
    expect(screen.getByRole("dialog")).toHaveTextContent("2027-06-30T00:00:00.000Z");
    expect(screen.getByRole("dialog")).toHaveTextContent("500 units");
    expect(screen.getByRole("dialog")).toHaveTextContent("365 days");
    expect(screen.getByRole("dialog")).toHaveTextContent("Estimated period");

    fireEvent.click(screen.getByRole("button", { name: "Confirm renewal" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/user/authority-products/product_provider/renew");
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body))).toEqual({ slotId: "provider_slot_1" });
  });
});
