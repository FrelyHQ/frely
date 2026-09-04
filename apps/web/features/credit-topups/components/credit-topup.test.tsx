// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CreditTopup } from "./credit-topup";

vi.mock("@web/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("CreditTopup Stripe Card purchase", () => {
  test("clicking a specific Stripe Card immediately starts Checkout without a confirmation dialog", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(() => new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={client}><CreditTopup listings={[{
      id: "listing_stripe_10",
      productName: "USD 10 Credit Card",
      creditedAmountUnits: 10_000_000,
      priceAmountUnits: 10_000_000,
      paymentAsset: "USD",
      channelId: "channel_stripe",
      channelName: "Stripe Checkout",
      settlementMode: "stripe_checkout",
      recipientIdentifierDisplay: "Stripe Checkout",
      paymentInstruction: null,
      instructionAttachments: []
    }]} topups={[]} /></QueryClientProvider>);

    await userEvent.click(screen.getByRole("button", { name: "Buy with Stripe" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/user/stripe/checkout");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ productListingId: "listing_stripe_10", useImmediately: false });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
