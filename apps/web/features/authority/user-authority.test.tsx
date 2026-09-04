import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UserAuthority } from "./components/user-authority";

vi.mock("@web/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

describe("Authority User UI (REQ-MEMBER-020)", () => {
  test("shows runtime catalog terms, available Grant units, purchase, and typed Team creation", () => {
    const markup = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><UserAuthority
      products={{ items: [{ id: "product_1", code: "team-create", version: 2, displayName: "Create a Team", effectCode: "team_create_unit", grantUnits: 1, purchaseAmountUnits: 321, grantDurationSeconds: 654, refundMode: "none", refundDeadlineSeconds: null, maxCurrentOwnedTeams: 3, maxLifetimeCreatedTeams: 5 }], page: 1, pageSize: 50, total: 1, totalPages: 1 }}
      grants={{ items: [{ id: "grant_1", productCode: "team-create", effectiveEnd: "2026-07-21T00:00:00.000Z", lifecycle: "active", grantedUnits: 1, usedUnits: 0, availableUnits: 1 }], page: 1, pageSize: 50, total: 1, totalPages: 1 }}
      canCreateTeam
      personalCreditBalanceUnits={4_200}
      personalProviderProduct={null}
      providerSlots={[]}
      providerSlotTotal={0}
    /></QueryClientProvider>);

    expect(markup).toContain("321 units");
    expect(markup).toContain("4,200 units");
    expect(markup).toContain("654s");
    expect(markup).toContain("1 / 1 available");
    expect(markup).toContain("Purchase");
    expect(markup).toContain("Create Team");
  });

  test("shows personal Provider slot capacity, retention state, and exact-slot renewal", () => {
    const markup = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><UserAuthority
      products={{ items: [{ id: "product_provider", code: "personal-provider", version: 3, displayName: "Personal Provider", effectCode: "user_custom_provider_access", grantUnits: 1, purchaseAmountUnits: 500, grantDurationSeconds: 31_536_000, refundMode: "none", refundDeadlineSeconds: null, maxCurrentOwnedTeams: null, maxLifetimeCreatedTeams: null }], page: 1, pageSize: 20, total: 1, totalPages: 1 }}
      grants={{ items: [], page: 1, pageSize: 20, total: 0, totalPages: 1 }}
      canCreateTeam={false}
      personalCreditBalanceUnits={1_000}
      personalProviderProduct={{ id: "product_provider", code: "personal-provider", version: 3, displayName: "Personal Provider", effectCode: "user_custom_provider_access", grantUnits: 1, purchaseAmountUnits: 500, grantDurationSeconds: 31_536_000, refundMode: "none", refundDeadlineSeconds: null, maxCurrentOwnedTeams: null, maxLifetimeCreatedTeams: null }}
      providerSlots={[{ id: "provider_slot_1", providerId: "prv_000000000000000000000001", lifecycle: "expired_hot", latestEffectiveEnd: "2027-01-01T00:00:00.000Z", renewalCutoff: "2027-06-30T00:00:00.000Z", usedAccessPoints: 42, maxAccessPoints: 100 }]}
      providerSlotTotal={1}
    /></QueryClientProvider>);

    expect(markup).toContain("One personal Codex Provider slot · 100 AP");
    expect(markup).toContain("365 days");
    expect(markup).toContain("42 / 100 AP");
    expect(markup).toContain("expired_hot");
    expect(markup).toContain("Review renewal");
    expect(markup).not.toContain("Renewing...");
    expect(markup).toContain("2027-06-30T00:00:00.000Z");
  });
});
