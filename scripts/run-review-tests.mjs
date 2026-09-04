#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const tests = [
  "tests/admin-access-points-ui-model.test.ts",
  "tests/admin-access-resolution-ui-model.test.ts",
  "tests/cliproxy-config-client.test.ts",
  "tests/cliproxy-control.test.ts",
  "tests/cliproxy-egress-proxy.test.ts",
  "tests/cpa-connection-registry.test.ts",
  "tests/domain-pipeline-plugins.test.ts",
  "tests/frontend-auth-redirect.test.ts",
  "tests/gateway-error-diagnostics.test.ts",
  "tests/gateway-stream-backpressure.test.ts",
  "tests/pipeline-kernel.test.ts",
  "tests/price-draft.test.ts",
  "tests/provider-pipeline-plugins.test.ts",
  "tests/stripe-credit-topup-webhook.test.ts",
  "tests/stripe-plan-checkout-route-contract.test.ts",
  "tests/team-invite-adapters.test.ts",
  "tests/web-access-order-route.test.ts",
  "tests/web-register-ui-model.test.ts",
  "tests/web-team-member-permission-route.test.ts",
  "tests/web-team-member-plan-usage.test.ts",
  "tests/web-user-chat-route.test.ts"
];
const prepare = spawnSync("bun", ["run", "prepare:generated"], { stdio: "inherit" });
if ((prepare.status ?? 1) !== 0) process.exit(prepare.status ?? 1);
const result = spawnSync("bun", ["run", "vitest", "run", ...tests], { stdio: "inherit" });
process.exit(result.status ?? 1);
