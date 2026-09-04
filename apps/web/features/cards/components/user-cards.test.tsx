// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@frely/ui/components/tooltip";
import { UserCards } from "./user-cards";

const routerReplace = vi.fn();

vi.mock("@web/navigation", () => ({
  useRouter: () => ({ replace: routerReplace }),
  useSearchParams: () => new URLSearchParams(),
}));

afterEach(() => {
  cleanup();
  routerReplace.mockReset();
  vi.unstubAllGlobals();
});

describe("User Cards inventory", () => {
  test("defaults to available Cards and links All Cards history", async () => {
    const fetchMock = stubCardApi({
      inventoryItems: [{ kind: "credit", card: creditCard }],
      planCards: [],
      canSetReferenceCode: false,
    });
    renderCards();

    const statusFilter = await screen.findByRole("combobox", { name: "Card inventory status" });
    expect(statusFilter).toHaveValue("Available");
    expect(fetchMock.mock.calls.some(([request]) => String(request).startsWith("/api/user/card-inventory?status=available&page=1&pageSize=20"))).toBe(true);
    await userEvent.click(statusFilter);
    await userEvent.click(screen.getByRole("option", { name: "All Cards" }));
    expect(routerReplace).toHaveBeenCalledWith("/user/cards?status=all");
  });

  test("shows one named Plan item and opens its paged Card detail with server capabilities", async () => {
    stubCardApi({
      inventoryItems: [planInventory],
      planCards: [closedPlanCard],
      canSetReferenceCode: false,
    });
    renderCards();

    expect(await screen.findByText("Visible Plan · v3")).toBeInTheDocument();
    expect(screen.getByText("2 individual Cards in this Plan.")).toBeInTheDocument();
    expect(screen.getByText("Earliest available expiry")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Open Visible Plan · v3 Cards" }));

    expect(await screen.findByRole("dialog")).toHaveTextContent("Visible Plan · v3");
    expect(screen.getByText("card_plan_closed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send" })).not.toBeInTheDocument();
    expect(screen.getByText("Plan closed")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Use" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("Use Visible Plan · v3?");
    expect(screen.getByRole("dialog")).toHaveTextContent("card_plan_closed");
  });

  test("omits Reference code for ordinary users and exposes it to current Team Owners", async () => {
    stubCardApi({
      inventoryItems: [{ kind: "credit", card: creditCard }],
      planCards: [],
      canSetReferenceCode: false,
    });
    const first = renderCards();

    await userEvent.click(await screen.findByRole("button", { name: "Send" }));
    expect(screen.getByLabelText("Recipient user ID")).toBeInTheDocument();
    expect(screen.getByLabelText("Message (optional)")).toBeInTheDocument();
    expect(screen.queryByLabelText("Reference code (optional)")).not.toBeInTheDocument();
    first.unmount();

    stubCardApi({
      inventoryItems: [{ kind: "credit", card: creditCard }],
      planCards: [],
      canSetReferenceCode: true,
    });
    renderCards();
    await userEvent.click(await screen.findByRole("button", { name: "Send" }));
    expect(screen.getByLabelText("Reference code (optional)")).toBeInTheDocument();
  });

  test("omits ordinary-user Reference payload and refreshes inventory plus transfer caches after send", async () => {
    const fetchMock = stubCardApi({
      inventoryItems: [{ kind: "credit", card: creditCard }],
      planCards: [],
      canSetReferenceCode: false,
    });
    renderCards();

    await userEvent.click(await screen.findByRole("button", { name: "Send" }));
    fireEvent.change(screen.getByLabelText("Recipient user ID"), { target: { value: "recipient" } });
    fireEvent.change(screen.getByLabelText("Message (optional)"), { target: { value: "hello" } });
    await userEvent.click(screen.getByRole("button", { name: "Review recipient" }));
    await userEvent.click(screen.getByRole("button", { name: "Send permanently" }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.filter(([request]) => String(request).startsWith("/api/user/card-inventory?"))).toHaveLength(2);
      expect(fetchMock.mock.calls.filter(([request]) => String(request).startsWith("/api/user/card-transfers?"))).toHaveLength(2);
    });
    const sendCall = fetchMock.mock.calls.find(([request]) => String(request).includes("/cards/card_credit_named/send"));
    expect(sendCall).toBeDefined();
    expect(JSON.parse(String(sendCall?.[1]?.body))).toEqual({
      toUserId: "recipient",
      note: "hello",
    });
  });
});

const planInventory = {
  kind: "plan" as const,
  planId: "plan_visible_v3",
  planName: "Visible Plan",
  planVersion: 3,
  planStatus: "closed" as const,
  totalCount: 2,
  availableCount: 1,
  replacedCount: 1,
  invalidatedCount: 0,
  usedCount: 0,
  expiredCount: 0,
  nearestAvailableExpiresAt: "2028-07-09T00:00:00.000Z",
  latestCreatedAt: "2026-07-10T00:00:00.000Z",
};

const closedPlanCard = {
  id: "card_plan_closed",
  cardType: "plan" as const,
  issuanceType: "purchase" as const,
  ownerUserId: "viewer",
  planId: "plan_visible_v3",
  planName: "Visible Plan",
  planVersion: 3,
  planStatus: "closed" as const,
  creditProductId: null,
  creditProductName: null,
  creditAmountUnits: null,
  createdAt: "2026-07-10T00:00:00.000Z",
  usedAt: null,
  invalidatedAt: null,
  invalidationReason: null,
  expiresAt: "2028-07-09T00:00:00.000Z",
  status: "available" as const,
  replacesCardId: null,
  replacedByCardId: null,
  canUse: true,
  canSend: false,
  useReasonCode: null,
  sendReasonCode: "plan_closed" as const,
};

const creditCard = {
  ...closedPlanCard,
  id: "card_credit_named",
  cardType: "credit" as const,
  planId: null,
  planName: null,
  planVersion: null,
  planStatus: null,
  creditProductId: "credit_named",
  creditProductName: "Named Credit",
  creditAmountUnits: 5_000_000,
  canSend: true,
  sendReasonCode: null,
};

function renderCards() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <TooltipProvider>
      <QueryClientProvider client={client}><UserCards /></QueryClientProvider>
    </TooltipProvider>,
  );
}

function stubCardApi(input: {
  inventoryItems: unknown[];
  planCards: unknown[];
  canSetReferenceCode: boolean;
}) {
  const fetchMock = vi.fn<(request: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (request) => {
    const url = String(request);
    if (url.includes("/api/user/cards/") && url.endsWith("/send")) {
      return jsonResponse({ id: "sent" });
    }
    if (url.startsWith("/api/user/card-inventory/plans/")) {
      return jsonResponse({ items: input.planCards, page: 1, pageSize: 50, total: input.planCards.length, totalPages: 1 });
    }
    if (url.startsWith("/api/user/card-inventory")) {
      return jsonResponse({
        items: input.inventoryItems,
        page: 1,
        pageSize: 50,
        total: input.inventoryItems.length,
        totalPages: 1,
        viewerUserId: "viewer",
        canSetReferenceCode: input.canSetReferenceCode,
      });
    }
    if (url.startsWith("/api/user/card-transfers")) {
      return jsonResponse({ items: [], page: 1, pageSize: 50, total: 0, totalPages: 1, viewerUserId: "viewer" });
    }
    throw new Error(`Unexpected Card API request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
