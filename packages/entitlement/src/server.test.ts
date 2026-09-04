import { describe, expect, test, vi } from "vitest";
import { EntitlementCommands } from "./server.js";

describe("Plan Subscription advisory lock", () => {
  test("executes the void PostgreSQL lock without deserializing it as a query result", async () => {
    const executeRaw = vi.fn(async () => 1);
    const appendAudit = vi.fn();
    const client = {
      $executeRaw: executeRaw,
      plans: { findUnique: vi.fn(async () => ({ plan_status: "enabled", duration_seconds: 3600 })) },
      plan_subscriptions: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
      },
    };
    const commands = new EntitlementCommands({} as never, client as never, { append: appendAudit } as never);

    await expect(commands.createSubscriptionInTransaction({
      id: "plan_sub_test",
      planId: "plan_test",
      scopeRef: "team:team_test",
      source: "admin_grant",
      priority: 10,
      effectiveStart: "2026-08-26T00:00:00.000Z",
      effectiveEnd: "2026-08-26T01:00:00.000Z",
      actor: { actorType: "user", actorId: "user_owner" },
      auditSource: "owner",
    })).resolves.toMatchObject({ id: "plan_sub_test", planId: "plan_test", scopeRef: "team:team_test" });
    expect(executeRaw).toHaveBeenCalledOnce();
    expect(appendAudit).toHaveBeenCalledOnce();
  });
});
