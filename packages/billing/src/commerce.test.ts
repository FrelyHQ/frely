import { describe, expect, test, vi } from "vitest";
import { BillingCommerceCommands, type AuthorityProductTerms } from "./commerce.js";

const personalTerms = (overrides: Partial<AuthorityProductTerms> = {}): AuthorityProductTerms => ({
  displayName: "Personal Provider",
  effectCode: "user_custom_provider_access",
  grantUnits: 1,
  purchaseAmountUnits: 1_000n,
  grantDurationSeconds: 365 * 86_400,
  maxLifetimePurchasesPerUser: null,
  maxUnconsumedUnitsPerUser: null,
  maxCurrentOwnedTeams: null,
  maxLifetimeCreatedTeams: null,
  refundMode: "none",
  refundDeadlineSeconds: null,
  settlementHoldSeconds: 7_200,
  sellerScopeRef: "global:",
  ...overrides,
});

function commands() {
  const append = vi.fn(async () => undefined);
  const client = {
    $queryRaw: vi.fn(async () => [{ version: 1 }]),
    authority_products: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
    },
  };
  return { commands: new BillingCommerceCommands({} as never, client as never, { append } as never), client, append };
}

describe("personal Provider Authority Product terms", () => {
  test("accepts a non-refundable positive integer-day product", async () => {
    const fixture = commands();
    await expect(fixture.commands.createAuthorityProductVersion({ ...personalTerms(), code: "personal-provider", actorOwnerUserId: "owner" })).resolves.toMatchObject({
      effectCode: "user_custom_provider_access",
      grantDurationSeconds: 31_536_000,
      refundMode: "none",
    });
    expect(fixture.client.authority_products.create).toHaveBeenCalledOnce();
    expect(fixture.append).toHaveBeenCalledOnce();
  });

  test("rejects fractional-day duration and refundable terms before persistence", async () => {
    const duration = commands();
    await expect(duration.commands.createAuthorityProductVersion({ ...personalTerms({ grantDurationSeconds: 86_401 }), code: "invalid-duration", actorOwnerUserId: "owner" })).rejects.toMatchObject({ code: "authority_product_terms_invalid" });
    expect(duration.client.authority_products.create).not.toHaveBeenCalled();

    const refundable = commands();
    await expect(refundable.commands.createAuthorityProductVersion({ ...personalTerms({ refundMode: "unused_by_owner", refundDeadlineSeconds: 3_600 }), code: "invalid-refund", actorOwnerUserId: "owner" })).rejects.toMatchObject({ code: "authority_product_terms_invalid" });
    expect(refundable.client.authority_products.create).not.toHaveBeenCalled();

    const purchaseCap = commands();
    await expect(purchaseCap.commands.createAuthorityProductVersion({ ...personalTerms({ maxLifetimePurchasesPerUser: 1 }), code: "invalid-purchase-cap", actorOwnerUserId: "owner" })).rejects.toMatchObject({ code: "authority_product_terms_invalid" });
    expect(purchaseCap.client.authority_products.create).not.toHaveBeenCalled();
  });
});
