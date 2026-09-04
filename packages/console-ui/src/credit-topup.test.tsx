/** @vitest-environment jsdom */

import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { CreditTopupExperience } from "./credit-topup.js";

afterEach(cleanup);

describe("Shared Credit top-up experience", () => {
  test("renders the Admin audience preview with every mutation disabled", () => {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    render(<QueryClientProvider client={client}><CreditTopupExperience
      listings={[{
        id: "listing_preview",
        productName: "Preview Credit",
        creditedAmountUnits: 10_000_000,
        priceAmountUnits: 10_000_000,
        paymentAsset: "USD",
        channelId: "stripe",
        channelName: "Stripe",
        settlementMode: "stripe_checkout",
        recipientIdentifierDisplay: "Stripe",
        paymentInstruction: null,
        instructionAttachments: [],
      }]}
      topups={[]}
      interactionMode="preview"
    /></QueryClientProvider>);

    expect(screen.getByText("Preview only. Top-up actions are disabled.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Preview only" })).toHaveProperty("disabled", true);
  });
});
