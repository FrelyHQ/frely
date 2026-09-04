import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { createPostgresClient, createPostgresClientFromEnvironment, isRetryablePostgresTransactionError, resolvePostgresConnectionStringFromEnvironment, type PostgresClientOwner, type PostgresTransactionContext } from "@frely/postgres/server";

const repositorySpanState = vi.hoisted(() => ({
  active: false,
  calls: [] as Array<{ collection: Record<string, unknown>; operation: string }>,
}));

vi.mock("@frely/observability/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@frely/observability/server")>();
  return {
    ...actual,
    recordRepositoryOperation: vi.fn((operation: string, work: () => unknown, collection: Record<string, unknown> = {}) => {
      repositorySpanState.calls.push({ operation, collection });
      repositorySpanState.active = true;
      try {
        const result = work();
        if (result instanceof Promise) {
          return result.finally(() => {
            repositorySpanState.active = false;
          });
        }
        repositorySpanState.active = false;
        return result;
      } catch (error) {
        repositorySpanState.active = false;
        throw error;
      }
    }),
  };
});

import { PostgresApplicationOperations, prepaidSellerSettlementTranches } from "./postgres-application-operations.js";

describe("PostgreSQL client owner", () => {
  test("owns a bounded pool and exposes a transaction-capable repository boundary without connecting during construction", async () => {
    const client = createPostgresClient({
      connectionString: "postgres://relay-user:secret@127.0.0.1:1/relay",
      max: 4,
      applicationName: "friday-relay-test",
    });
    try {
      expect(client.backend).toBe("postgres");
      expect(new PostgresApplicationOperations(client).backend).toBe("postgres");
      expect(client.poolMax).toBe(4);
      expect(client.transactionTimeoutMillis).toBe(60_000);
    } finally {
      await client.close();
    }
  });

  test("requires an externally supplied connection secret and bounded pool size", () => {
    expect(() => createPostgresClient({})).toThrow(/postgres_connection_source_required/u);
    expect(() => createPostgresClient({ host: "127.0.0.1", max: 0 })).toThrow(/postgres_pool_max_invalid/u);
    expect(() => createPostgresClient({ host: "127.0.0.1", transactionTimeoutMillis: 0 })).toThrow(/postgres_transaction_timeout_invalid/u);
    expect(() => createPostgresClientFromEnvironment({})).toThrow(/postgres_connection_string_secret_required/u);
  });

  test("reads the PostgreSQL connection secret from one private regular file", () => {
    const directory = mkdtempSync(join(tmpdir(), "friday-relay-pg-secret-"));
    const secret = join(directory, "connection-string");
    writeFileSync(secret, "postgresql://relay:replace-with-test-password@postgres.example.test/relay\n", { mode: 0o600 });
    chmodSync(secret, 0o600);
    expect(resolvePostgresConnectionStringFromEnvironment({ FRIDAY_RELAY_PG_CONNECTION_STRING_FILE: secret })).toBe("postgresql://relay:replace-with-test-password@postgres.example.test/relay");
    expect(() => resolvePostgresConnectionStringFromEnvironment({ FRIDAY_RELAY_PG_CONNECTION_STRING: "postgresql://direct", FRIDAY_RELAY_PG_CONNECTION_STRING_FILE: secret })).toThrow(/source_ambiguous/u);
    chmodSync(secret, 0o640);
    expect(resolvePostgresConnectionStringFromEnvironment({ FRIDAY_RELAY_PG_CONNECTION_STRING_FILE: secret })).toBe("postgresql://relay:replace-with-test-password@postgres.example.test/relay");
    chmodSync(secret, 0o660);
    expect(() => resolvePostgresConnectionStringFromEnvironment({ FRIDAY_RELAY_PG_CONNECTION_STRING_FILE: secret })).toThrow(/file_permissions_invalid/u);
    chmodSync(secret, 0o644);
    expect(() => resolvePostgresConnectionStringFromEnvironment({ FRIDAY_RELAY_PG_CONNECTION_STRING_FILE: secret })).toThrow(/file_permissions_invalid/u);
  });

  test("only classifies PostgreSQL serialization and deadlock errors as retryable", () => {
    expect(isRetryablePostgresTransactionError({ code: "40001" })).toBe(true);
    expect(isRetryablePostgresTransactionError({ code: "40P01" })).toBe(true);
    expect(isRetryablePostgresTransactionError({ code: "P2034" })).toBe(true);
    expect(isRetryablePostgresTransactionError({ code: "23505" })).toBe(false);
    expect(isRetryablePostgresTransactionError(new Error("network"))).toBe(false);
  });

  test("keeps one Teams Repository operation active across the actual bounded PostgreSQL queries", async () => {
    repositorySpanState.calls.length = 0;
    const queries: Array<{ insideRepositorySpan: boolean; text: string; values: readonly unknown[] }> = [];
    const context: PostgresTransactionContext = {
      query: async <T extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) => {
        queries.push({ insideRepositorySpan: repositorySpanState.active, text, values });
        if (text.includes('COUNT(*)::int AS "count" FROM directory')) {
          return { rows: [{ count: 0 }], rowCount: 1 } as never;
        }
        if (text.includes("SELECT * FROM directory")) return { rows: [], rowCount: 0 } as never;
        throw new Error("unexpected_team_directory_query");
      },
      copyFrom: () => undefined as never,
    };
    const repository = new PostgresApplicationOperations({ backend: "postgres" } as PostgresClientOwner, context);

    await expect(repository.pageAdminTeamDirectory({ page: 1, pageSize: 20 }))
      .resolves.toEqual({ items: [], rows: [], page: 1, pageSize: 20, total: 0, totalPages: 1 });

    expect(repositorySpanState.calls).toEqual([{
      operation: "queries.teams.pageDirectory",
      collection: { pageSize: 20, itemsReturned: 0, returnedRows: 0 },
    }]);
    expect(queries).toHaveLength(2);
    expect(queries.every((query) => query.insideRepositorySpan)).toBe(true);
    expect(queries[0]?.values).toEqual([""]);
    expect(queries[1]?.values).toEqual(["", 20, 0]);
  });

  test("reads an existing unblocked PostgreSQL abuse counter through the mapped row contract", async () => {
    const subjectHash = `client_ip:${"a".repeat(64)}`;
    const context: PostgresTransactionContext = {
      query: async <T extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) => {
        expect(text).toContain(`"blocked_until" AS "blockedUntil"`);
        expect(values).toEqual(["auth.login.failed", subjectHash, 1_200_000, 600]);
        return { rows: [{ count: 1, blockedUntil: null }], rowCount: 1 } as never;
      },
      copyFrom: () => undefined as never,
    };
    const repository = new PostgresApplicationOperations({} as PostgresClientOwner, context);

    await expect(repository.inspectAbuseRateLimit({
      bucket: "auth.login.failed",
      subjectHashes: [subjectHash],
      limit: 10,
      windowSeconds: 600,
      nowMs: 1_200_000,
    })).resolves.toEqual({ allowed: true, retryAfterSeconds: 0 });
  });

  test("appends a zero-cost PayGo Billing fact without posting a credit ledger event", async () => {
    const queries: string[] = [];
    const context: PostgresTransactionContext = {
      query: async <T extends Record<string, unknown>>(text: string) => {
        queries.push(text);
        if (text.startsWith(`INSERT INTO "billing_events"`)) {
          return { rows: [{
            id: "billing_zero",
            requestId: "req_zero",
            billingSubscriptionId: "subscription_zero",
            billingScopeRef: "user:user-zero",
            billableAmount: 0,
            createdAt: "2026-08-24T00:00:00.000Z",
          }], rowCount: 1 } as never;
        }
        if (text.startsWith(`INSERT INTO "billing_history_refs"`)) return { rows: [{}], rowCount: 1 } as never;
        if (text.startsWith(`SELECT * FROM "plan_subscriptions"`)) return { rows: [], rowCount: 0 } as never;
        throw new Error(`unexpected_zero_cost_query:${text}`);
      },
      copyFrom: () => undefined as never,
    };
    const repository = new PostgresApplicationOperations({} as PostgresClientOwner, context);

    const result = await repository.createBillingEventWithUsageCharge({
      billingEvent: {
        requestId: "req_zero",
        billingSubscriptionId: "subscription_zero",
        billingScopeRef: "user:user-zero",
        billablePriceId: "price_zero",
        billablePriceSource: "plan_access_point",
        providerModelCostId: "cost_zero",
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        billableAmount: 0,
        providerCostAmount: 0,
        grossMarginAmount: 0,
        usageSource: "provider",
        billablePriceSnapshotJson: "{}",
        costPriceSnapshotJson: "{}",
      },
      usageChargeAccountId: "credit_zero",
      allowOverdraft: true,
    } as never);

    expect(result).toMatchObject({ billingEvent: { id: "billing_zero", billableAmount: 0 }, ledgerEvent: null });
    expect(queries.some((query) => query.includes(`UPDATE "credit_accounts"`))).toBe(false);
    expect(queries.some((query) => query.includes(`INSERT INTO "credit_ledger_events"`))).toBe(false);
  });

  test("records a paid Service order before any explicit fulfillment retry", async () => {
    const queries: string[] = [];
    const order = {
      id: "service_order_paid", buyerUserId: "buyer", targetPartnerTeamId: null,
      productId: "service_product", productListingId: "service_listing", paymentChannelId: "channel",
      productCode: "partner", productVersion: 1, productDisplayName: "Partner annual",
      fulfillmentEffect: "partner_team_annual", durationSeconds: 31_536_000, partnerPlanId: "plan_partner",
      purchaseIntent: "new", expectedPaymentAmountUnits: 1_000_000, confirmedReceivedAmountUnits: null,
      paymentAsset: "USD", paymentNetwork: "manual", normalizedTransactionReferenceHash: "hash",
      transactionReferenceTail: "tail", paymentSubmittedAt: "2026-08-24T00:00:00.000Z",
      reviewedByUserId: null, reviewedAt: null, reviewNote: null, status: "pending_review",
      createIdempotencyKeyHash: "key", createRequestHash: "request", createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z",
    };
    const context: PostgresTransactionContext = {
      query: async <T extends Record<string, unknown>>(text: string) => {
        queries.push(text);
        if (text.startsWith(`SELECT * FROM "service_orders"`) && text.includes("FOR UPDATE")) return { rows: [order], rowCount: 1 } as never;
        if (text.startsWith(`SELECT * FROM "service_fulfillments"`)) return { rows: [], rowCount: 0 } as never;
        if (text.startsWith(`UPDATE "service_orders"`)) return { rows: [{ ...order, status: "paid", confirmedReceivedAmountUnits: 1_000_000, reviewedByUserId: "owner" }], rowCount: 1 } as never;
        if (text.startsWith(`INSERT INTO "service_fulfillments"`)) return { rows: [{ id: "fulfillment_pending", orderId: order.id, effectType: order.fulfillmentEffect, targetType: null, targetId: null, status: "pending", initiatedByUserId: order.buyerUserId, completedByUserId: null, errorCode: null, createdAt: order.createdAt, completedAt: null, updatedAt: order.updatedAt }], rowCount: 1 } as never;
        if (text.startsWith(`INSERT INTO "audit_logs"`)) return { rows: [{}], rowCount: 1 } as never;
        throw new Error(`unexpected_service_approval_query:${text}`);
      },
      copyFrom: () => undefined as never,
    };
    const repository = new PostgresApplicationOperations({} as PostgresClientOwner, context);
    const result = await repository.approveServiceOrder({ orderId: order.id, ownerUserId: "owner", confirmedReceivedAmountUnits: 1_000_000, reviewNote: "received" });

    expect(result).toMatchObject({ order: { status: "paid" }, fulfillment: { status: "pending", targetId: null } });
    expect(queries.some((query) => query.includes(`INSERT INTO "partner_team_creation_allocations"`))).toBe(false);
    expect(queries.some((query) => query.includes(`INSERT INTO "plan_subscriptions"`))).toBe(false);
  });

  test("binds an unfiltered Plan directory query without PostgreSQL parameter gaps", async () => {
    const context: PostgresTransactionContext = {
      query: async <T extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) => {
        if (text.startsWith(`SELECT COUNT(*)::int AS "count" FROM "plans" plan`)) {
          expect(values).toEqual([]);
          return { rows: [{ count: 1 }], rowCount: 1 } as never;
        }
        if (text.includes(`FROM "plans" plan`)) {
          const parameterNumbers = [...text.matchAll(/\$(\d+)/gu)].map((match) => Number(match[1]));
          const highestParameter = Math.max(...parameterNumbers);
          expect(new Set(parameterNumbers)).toEqual(new Set(Array.from({ length: highestParameter }, (_value, index) => index + 1)));
          expect(values).toHaveLength(highestParameter);
          return {
            rows: [{
              id: "plan_directory",
              owner_id: "owner",
              scope_ref: "global:",
              name: "Directory Plan",
              version: 1,
              description: null,
              admin_note: null,
              billing_mode: "prepaid",
              purchase_amount: 0,
              duration_seconds: 86_400,
              plan_status: "enabled",
              catalog_status: "unlisted",
              created_at: "2026-08-10T00:00:00.000Z",
              updated_at: "2026-08-10T00:00:00.000Z",
              budget_limit_count: 0,
              access_point_count: 0,
              access_point_names: null,
              available_card_count: 0,
              active_or_future_subscription_count: 0,
            }],
            rowCount: 1,
          } as never;
        }
        throw new Error(`fake_query_unhandled:${text}`);
      },
      copyFrom: () => undefined as never,
    };
    const repository = new PostgresApplicationOperations({} as PostgresClientOwner, context);

    const page = await repository.pagePlanDirectory({}, "2026-08-10T00:00:00.000Z");

    expect(page.items.map((plan) => plan.id)).toEqual(["plan_directory"]);
  });

  test("scopes PostgreSQL Subscription overlap checks to the same Plan and scope", async () => {
    const scopeRef = "team:team_overlap";
    const effectiveStart = "2026-08-11T00:00:00.000Z";
    const effectiveEnd = "2026-08-12T00:00:00.000Z";
    const planRow = (id: string) => ({
      id,
      owner_id: "owner",
      scope_ref: "global:",
      name: id,
      version: 1,
      description: null,
      admin_note: null,
      billing_mode: "prepaid",
      purchase_amount: 0,
      duration_seconds: 86_400,
      plan_status: "enabled",
      catalog_status: "unlisted",
      created_at: effectiveStart,
      updated_at: effectiveStart,
    });
    const subscriptionRow = (input: { id: string; planId: string; scopeRef: string }) => ({
      id: input.id,
      plan_id: input.planId,
      source: "admin_grant",
      scope_ref: input.scopeRef,
      purchased_by_user_id: "owner",
      funding_account_id: null,
      origin_card_id: null,
      priority: 10,
      effective_start: effectiveStart,
      effective_end: effectiveEnd,
      subscription_lifecycle: "active",
      created_at: effectiveStart,
      updated_at: effectiveStart,
    });
    const activeSubscriptions = [
      subscriptionRow({ id: "sub_existing", planId: "plan_existing", scopeRef }),
      subscriptionRow({ id: "sub_update", planId: "plan_different", scopeRef: "team:before_update" }),
    ];
    const context: PostgresTransactionContext = {
      query: async <T extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) => {
        if (text.startsWith(`SELECT * FROM "plans"`)) {
          return { rows: [planRow(String(values[0]))], rowCount: 1 } as never;
        }
        if (text.startsWith(`SELECT "id" FROM "plan_subscriptions"`)) {
          expect(text).toContain(`WHERE "plan_id" = $1 AND "scope_ref" = $2`);
          const excludeId = text.includes(`"id" <> $3`) ? String(values[2]) : null;
          const overlap = activeSubscriptions.find((subscription) => (
            subscription.plan_id === values[0]
            && subscription.scope_ref === values[1]
            && subscription.id !== excludeId
          ));
          return { rows: overlap ? [{ id: overlap.id }] : [], rowCount: overlap ? 1 : 0 } as never;
        }
        if (text.startsWith(`SELECT * FROM "plan_subscriptions"`)) {
          const subscription = activeSubscriptions.find((item) => item.id === values[0]);
          return { rows: subscription ? [subscription] : [], rowCount: subscription ? 1 : 0 } as never;
        }
        if (text.startsWith(`INSERT INTO "plan_subscriptions"`)) {
          return { rows: [subscriptionRow({ id: "sub_created", planId: "plan_different", scopeRef })], rowCount: 1 } as never;
        }
        if (text.startsWith(`UPDATE "plan_subscriptions"`)) {
          return { rows: [subscriptionRow({ id: "sub_update", planId: "plan_different", scopeRef })], rowCount: 1 } as never;
        }
        if (text.startsWith(`SELECT membership."user_id" AS "userId"`)) {
          return { rows: [], rowCount: 0 } as never;
        }
        throw new Error(`fake_query_unhandled:${text}`);
      },
      copyFrom: () => undefined as never,
    };
    const repository = new PostgresApplicationOperations({} as PostgresClientOwner, context);

    await expect(repository.createPlanSubscription({
      planId: "plan_different",
      scopeRef,
      effectiveStart,
      effectiveEnd,
      priority: 10,
    })).resolves.toMatchObject({ planId: "plan_different", scopeRef });
    await expect(repository.createPlanSubscription({
      planId: "plan_existing",
      scopeRef,
      effectiveStart,
      effectiveEnd,
      priority: 10,
    })).rejects.toMatchObject({ code: "plan_subscription_overlap", status: 409 });
    await expect(repository.updatePlanSubscription("sub_update", { scopeRef })).resolves.toMatchObject({
      id: "sub_update",
      planId: "plan_different",
      scopeRef,
    });
  });

  test("fails closed for retired WebAuthn consumption and creation", async () => {
    const calls: Array<{ text: string; values: readonly unknown[] }> = [];
    const context: PostgresTransactionContext = {
      query: async <T extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) => {
        calls.push({ text, values });
        if (text.startsWith("DELETE FROM \"webauthn_ceremonies\"")) {
          return { rows: [{ session_hash: "session", purpose: "authentication", surface: "web", user_id: null, expected_auth_version: null, challenge_hash: "challenge", rp_id: "example.test", origin: "https://example.test", passkey_name: null, expires_at: "2026-08-03T00:00:00.000Z", created_at: "2026-08-02T00:00:00.000Z" }], rowCount: 1 } as never;
        }
        if (text.startsWith("INSERT INTO \"webauthn_ceremonies\"")) {
          return { rows: [{ session_hash: "new-session", purpose: "authentication", surface: "web", user_id: null, expected_auth_version: null, challenge_hash: "challenge", rp_id: "example.test", origin: "https://example.test", passkey_name: null, expires_at: "2026-08-04T00:00:00.000Z", created_at: "2026-08-03T00:00:00.000Z" }], rowCount: 1 } as never;
        }
        return { rows: [], rowCount: 0 } as never;
      },
      copyFrom: () => undefined as never,
    };
    const repository = new PostgresApplicationOperations({} as PostgresClientOwner, context);

    await expect(repository.takeWebAuthnCeremony({ sessionHash: "session", purpose: "authentication", surface: "web", now: "2026-08-03T01:00:00.000Z" }))
      .rejects.toMatchObject({ code: "auth_method_retired", status: 404 });
    await expect(repository.createWebAuthnCeremony({
      sessionHash: "new-session",
      purpose: "authentication",
      surface: "web",
      userId: null,
      expectedAuthVersion: null,
      challengeHash: "challenge",
      rpId: "example.test",
      origin: "https://example.test",
      passkeyName: null,
      expiresAt: "2026-08-04T00:00:00.000Z",
    })).rejects.toMatchObject({ code: "auth_method_retired", status: 404 });
    expect(calls).toEqual([]);
  });

  test("fails closed for retired refresh-token rotation", async () => {
    const calls: string[] = [];
    const context: PostgresTransactionContext = {
      query: async <T extends Record<string, unknown>>(text: string) => {
        calls.push(text);
        if (text.startsWith("UPDATE \"refresh_tokens\"")) return { rows: [], rowCount: 1 } as never;
        return { rows: [{ id: "rt_new", user_id: "user", token_hash: "replacement", expires_at: "2026-08-04T00:00:00.000Z", revoked_at: null, created_at: "2026-08-03T00:00:00.000Z" }], rowCount: 1 } as never;
      },
      copyFrom: () => undefined as never,
    };
    const repository = new PostgresApplicationOperations({} as PostgresClientOwner, context);
    await expect(repository.rotateRefreshToken({
      tokenHash: "old",
      userId: "user",
      expectedAuthVersion: 3,
      replacementTokenHash: "replacement",
      replacementExpiresAt: "2026-08-04T00:00:00.000Z",
    })).rejects.toMatchObject({ code: "auth_method_retired", status: 404 });
    expect(calls).toEqual([]);
  });

  test("allocates prepaid Seller revenue over fixed 30-day windows and absorbs rounding in the final tranche", () => {
    const start = "2026-01-01T00:00:00.000Z";
    const end = new Date(Date.parse(start) + 45 * 86_400_000).toISOString();
    const tranches = prepaidSellerSettlementTranches({ effectiveStart: start, effectiveEnd: end }, 1_000_001);
    expect(tranches).toEqual([
      { windowStart: start, windowEnd: new Date(Date.parse(start) + 30 * 86_400_000).toISOString(), amountUnits: 666_667 },
      { windowStart: new Date(Date.parse(start) + 30 * 86_400_000).toISOString(), windowEnd: new Date(Date.parse(start) + 60 * 86_400_000).toISOString(), amountUnits: 333_334 },
    ]);
    expect(tranches.reduce((sum, tranche) => sum + tranche.amountUnits, 0)).toBe(1_000_001);
  });

  test("releases due seller settlement windows exactly once inside the PostgreSQL transaction", async () => {
    let releaseInserted = false;
    let accountBalance = 0;
    const calls: string[] = [];
    const context: PostgresTransactionContext = {
      query: async <T extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) => {
        calls.push(text);
        if (text.startsWith(`SELECT "window_key"`)) {
          return {
            rows: releaseInserted ? [] : [{
              window_key: "plan:plan_1:team:seller:2026-07-01T00:00:00.000Z",
              plan_subscription_id: "plan_1",
              authority_purchase_id: null,
              seller_scope_ref: "team:seller",
              window_start: "2026-07-01T00:00:00.000Z",
              window_end: "2026-07-31T00:00:00.000Z",
              release_at: "2026-07-31T00:00:00.000Z",
            }],
            rowCount: releaseInserted ? 0 : 1,
          } as never;
        }
        if (text.startsWith(`SELECT "status" FROM "seller_settlement_windows"`)) return { rows: [{ status: "open" }], rowCount: 1 } as never;
        if (text.startsWith(`SELECT "id" FROM "plan_subscriptions"`)) return { rows: [{ id: "plan_1" }], rowCount: 1 } as never;
        if (text.startsWith(`SELECT attempt."id"`)) return { rows: [], rowCount: 0 } as never;
        if (text.includes(`MIN("seller_scope_ref") AS "seller_scope_ref"`)) {
          return {
            rows: [{
              seller_scope_ref: "team:seller",
              window_end: "2026-07-31T00:00:00.000Z",
              release_at: "2026-07-31T00:00:00.000Z",
              net_units: 1250,
              released_units: releaseInserted ? 1250 : 0,
            }],
            rowCount: 1,
          } as never;
        }
        if (text.startsWith(`INSERT INTO "seller_settlement_events"`)) {
          if (releaseInserted) return { rows: [], rowCount: 0 } as never;
          releaseInserted = true;
          return {
            rows: [{
              id: "settlement_release",
              plan_subscription_id: "plan_1",
              authority_purchase_id: null,
              seller_scope_ref: "team:seller",
              window_start: "2026-07-01T00:00:00.000Z",
              window_end: "2026-07-31T00:00:00.000Z",
              release_at: "2026-07-31T00:00:00.000Z",
              event_type: "release",
              amount_units: 1250,
              source_type: "settlement_window",
              source_id: "plan:plan_1:2026-07-01T00:00:00.000Z",
              created_at: "2026-08-01T00:00:00.000Z",
            }],
            rowCount: 1,
          } as never;
        }
        if (text.startsWith(`SELECT * FROM "credit_accounts"`)) return { rows: [], rowCount: 0 } as never;
        if (text.startsWith(`INSERT INTO "credit_accounts"`)) {
          return {
            rows: [{
              id: "credit_seller",
              scope_ref: "team:seller",
              status: "active",
              balance_snap_units: accountBalance,
              balance_snap_ledger_event_id: null,
              balance_snap_updated_at: null,
              created_at: "2026-08-01T00:00:00.000Z",
              updated_at: "2026-08-01T00:00:00.000Z",
            }],
            rowCount: 1,
          } as never;
        }
        if (text.startsWith(`UPDATE "credit_accounts"`)) {
          accountBalance += Number(values[1]);
          return { rows: [{ id: "credit_seller" }], rowCount: 1 } as never;
        }
        if (text.startsWith(`INSERT INTO "credit_ledger_events"`)) {
          return { rows: [{ id: String(values[0]) }], rowCount: 1 } as never;
        }
        throw new Error(`fake_query_unhandled:${text}`);
      },
      copyFrom: () => undefined as never,
    };
    const repository = new PostgresApplicationOperations({} as PostgresClientOwner, context);

    await expect(repository.releaseDueSellerSettlements("2026-08-01T00:00:00.000Z")).resolves.toMatchObject({ releasedWindows: 1, releasedUnits: 1250 });
    await expect(repository.releaseDueSellerSettlements("2026-08-01T00:00:00.000Z")).resolves.toMatchObject({ releasedWindows: 0, releasedUnits: 0, ledgerEventIds: [] });
    expect(accountBalance).toBe(1250);
    expect(calls.filter((text) => text.startsWith(`INSERT INTO "credit_ledger_events"`))).toHaveLength(1);
  });

  test("defers a due Plan settlement window while an admitted ProviderAttempt is unresolved", async () => {
    const context: PostgresTransactionContext = {
      query: async <T extends Record<string, unknown>>(text: string) => {
        if (text.startsWith(`SELECT "window_key"`)) return { rows: [{
          window_key: "plan:plan_pending:team:seller:2026-07-01T00:00:00.000Z",
          plan_subscription_id: "plan_pending", authority_purchase_id: null, seller_scope_ref: "team:seller",
          window_start: "2026-07-01T00:00:00.000Z", window_end: "2026-07-31T00:00:00.000Z", release_at: "2026-07-31T00:00:00.000Z",
        }], rowCount: 1 } as never;
        if (text.startsWith(`SELECT "status" FROM "seller_settlement_windows"`)) return { rows: [{ status: "open" }], rowCount: 1 } as never;
        if (text.startsWith(`SELECT "id" FROM "plan_subscriptions"`)) return { rows: [{ id: "plan_pending" }], rowCount: 1 } as never;
        if (text.startsWith(`SELECT attempt."id"`)) return { rows: [{ id: "attempt_pending" }], rowCount: 1 } as never;
        if (text.startsWith(`UPDATE "seller_settlement_windows"`)) return { rows: [{ window_key: "plan_pending" }], rowCount: 1 } as never;
        throw new Error(`fake_query_unhandled:${text}`);
      },
      copyFrom: () => undefined as never,
    };
    const repository = new PostgresApplicationOperations({} as PostgresClientOwner, context);
    await expect(repository.releaseDueSellerSettlements("2026-08-01T00:00:00.000Z")).resolves.toMatchObject({
      selectedWindows: 1, deferredWindows: 1, releasedWindows: 0, releasedUnits: 0,
    });
  });

  test("locks an Authority Purchase before re-reading and releasing its Seller settlement", async () => {
    const calls: string[] = [];
    const context: PostgresTransactionContext = {
      query: async <T extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) => {
        calls.push(text);
        if (text.startsWith(`SELECT "window_key"`)) return { rows: [{
          window_key: "authority:authority_1:global::2026-07-01T00:00:00.000Z",
          plan_subscription_id: null, authority_purchase_id: "authority_1", seller_scope_ref: "global:",
          window_start: "2026-07-01T00:00:00.000Z", window_end: "2026-07-08T00:00:00.000Z", release_at: "2026-07-08T00:00:00.000Z",
        }], rowCount: 1 } as never;
        if (text.startsWith(`SELECT "status" FROM "seller_settlement_windows"`)) return { rows: [{ status: "open" }], rowCount: 1 } as never;
        if (text.startsWith(`SELECT "id" FROM "authority_purchases"`)) return { rows: [{ id: "authority_1" }], rowCount: 1 } as never;
        if (text.includes(`MIN("seller_scope_ref") AS "seller_scope_ref"`)) return { rows: [{ seller_scope_ref: "global:", window_end: "2026-07-08T00:00:00.000Z", release_at: "2026-07-08T00:00:00.000Z", net_units: 500, released_units: 0 }], rowCount: 1 } as never;
        if (text.startsWith(`INSERT INTO "seller_settlement_events"`)) return { rows: [{ id: "release_authority" }], rowCount: 1 } as never;
        if (text.startsWith(`SELECT * FROM "credit_accounts"`)) return { rows: [{ id: "account_global", scope_ref: "global:", status: "active", balance_snap_units: 0, created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z" }], rowCount: 1 } as never;
        if (text.startsWith(`UPDATE "credit_accounts"`)) return { rows: [{ id: "account_global" }], rowCount: 1 } as never;
        if (text.startsWith(`INSERT INTO "credit_ledger_events"`)) return { rows: [{ id: String(values[0]) }], rowCount: 1 } as never;
        throw new Error(`fake_query_unhandled:${text}`);
      },
      copyFrom: () => undefined as never,
    };
    const repository = new PostgresApplicationOperations({} as PostgresClientOwner, context);
    await expect(repository.releaseDueSellerSettlements("2026-08-01T00:00:00.000Z")).resolves.toMatchObject({ releasedWindows: 1, releasedUnits: 500 });
    const projectionLockIndex = calls.findIndex((text) => text.startsWith(`SELECT "status" FROM "seller_settlement_windows"`));
    const lockIndex = calls.findIndex((text) => text.startsWith(`SELECT "id" FROM "authority_purchases"`));
    const rereadIndex = calls.findIndex((text) => text.includes(`MIN("seller_scope_ref") AS "seller_scope_ref"`));
    const releaseIndex = calls.findIndex((text) => text.startsWith(`INSERT INTO "seller_settlement_events"`));
    expect(projectionLockIndex).toBeGreaterThanOrEqual(0);
    expect(projectionLockIndex).toBeLessThan(lockIndex);
    expect(lockIndex).toBeLessThan(rereadIndex);
    expect(rereadIndex).toBeLessThan(releaseIndex);
  });

  test("updates Provider binding observations only for the expected CPA and revision", async () => {
    const calls: Array<{ text: string; values: readonly unknown[] }> = [];
    const context: PostgresTransactionContext = {
      query: async <T extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) => {
        calls.push({ text, values });
        if (text.startsWith(`UPDATE "provider_bindings" binding`)) {
          return {
            rows: [{
              provider_id: "provider_pg", auth_method: "api-key", credential_ownership: "cpa-managed",
              credential_refs_json: "[\"opaque-ref\"]", credential_preview: "key-...", revision: 7,
              sync_status: "ready", error_code: null, created_at: "2026-08-03T00:00:00.000Z",
              updated_at: "2026-08-03T00:01:00.000Z",
            }],
            rowCount: 1,
          } as never;
        }
        throw new Error(`fake_query_unhandled:${text}`);
      },
      copyFrom: () => undefined as never,
    };
    const repository = new PostgresApplicationOperations({} as PostgresClientOwner, context);
    const binding = await repository.updateProviderBindingStatusIfCurrent({
      providerId: "provider_pg", expectedCpaInstanceId: "cpa_primary", expectedRevision: 7,
      syncStatus: "ready", errorCode: null,
    });
    expect(binding).toMatchObject({ providerId: "provider_pg", revision: 7, syncStatus: "ready" });
    expect(calls[0]?.text).toContain('provider."cpa_instance_id" = $2');
    expect(calls[0]?.text).toContain('binding."revision" = $3');
    expect(calls[0]?.values.slice(0, 5)).toEqual(["provider_pg", "cpa_primary", 7, "ready", null]);
  });

  test("derives an active Team Plan source without a persisted order preference", async () => {
    const calls: string[] = [];
    const context: PostgresTransactionContext = {
      query: async <T extends Record<string, unknown>>(text: string) => {
        calls.push(text);
        if (text.includes('SELECT DISTINCT access_point."exposed_model"')) {
          return { rows: [{ exposed_model: "model-team" }], rowCount: 1 } as never;
        }
        if (text.includes('LIMIT 51')) {
          return {
            rows: [{
              order_id: null,
              order_position: null,
              order_created_at: null,
              order_updated_at: null,
              plan_id: "plan-team",
              subscription_scope_ref: "team:team-a",
              default_priority: 20,
              default_effective_start: "2026-08-01T00:00:00.000Z",
              default_source_created_at: "2026-08-01T00:00:00.000Z",
              default_source_id: "subscription-team",
              position: 1,
            }],
            rowCount: 1,
          } as never;
        }
        if (text.startsWith('SELECT * FROM "plans"')) {
          return { rows: [{ id: "plan-team", name: "Team plan", plan_status: "enabled" }], rowCount: 1 } as never;
        }
        if (text.includes('FROM "plan_subscriptions" subscription')) {
          return {
            rows: [{
              id: "subscription-team", plan_id: "plan-team", scope_ref: "team:team-a", priority: 20,
              effective_start: "2026-08-01T00:00:00.000Z", effective_end: null, subscription_lifecycle: "active",
            }],
            rowCount: 1,
          } as never;
        }
        if (text.includes('FROM "plan_access_points" relation')) {
          return {
            rows: [{
              id: "access-point-team", plan_id: "plan-team", exposed_model: "model-team", status: "enabled",
            }],
            rowCount: 1,
          } as never;
        }
        throw new Error(`fake_query_unhandled:${text}`);
      },
      copyFrom: () => undefined as never,
    };
    const repository = new PostgresApplicationOperations({} as PostgresClientOwner, context);

    await expect(repository.listEffectiveUserModelPlanSourceModels("user-a")).resolves.toEqual(["model-team"]);
    const source = await repository.findFirstOrderedPlanSourceForUser("user-a", "model-team", "2026-08-02T00:00:00.000Z");

    expect(source).toMatchObject({
      order: { userId: "user-a", exposedModel: "model-team", planId: "plan-team", subscriptionScopeRef: "team:team-a" },
      subscription: { id: "subscription-team" },
      accessPoint: { id: "access-point-team" },
      configurationError: null,
    });
    expect(source?.order.id).toMatch(/^derived_order_[a-f0-9]{32}$/u);
    expect(calls.some((text) => /^\s*(INSERT|UPDATE|DELETE)\b/u.test(text))).toBe(false);
  });
});
