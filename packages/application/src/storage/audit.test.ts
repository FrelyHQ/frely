import { describe, expect, it, vi } from "vitest";
import { auditFailureAsync } from "./audit.js";

describe("auditFailureAsync", () => {
  it("records only a stable error code for a failed Plan subscription update", async () => {
    const record = vi.fn(async () => undefined);

    await auditFailureAsync(
      { record },
      {
        actor: { actorType: "user", actorId: "owner_verification" },
        source: "owner",
        requestId: "req_plan_subscription_failure",
        action: "plan_subscription.update",
        resource: {
          resourceType: "plan_subscription",
          resourceId: "plan_sub_verification",
        },
        error: { code: "P2022", message: "must not be retained" },
      },
    );

    expect(record).toHaveBeenCalledWith({
      actor: { actorType: "user", actorId: "owner_verification" },
      source: "owner",
      requestId: "req_plan_subscription_failure",
      action: "plan_subscription.update",
      resource: {
        resourceType: "plan_subscription",
        resourceId: "plan_sub_verification",
      },
      result: "failure",
      metadata: { errorCode: "P2022" },
    });
  });
});
