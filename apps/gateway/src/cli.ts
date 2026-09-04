import { loadConfig } from "@frely/config";
import { openRuntimeDatabase } from "@frely/application/runtime";
import { initializeDatabaseProductionShadowRiskGuard, inspectDatabaseProductionShadowRiskState, productionShadowRiskGuardFromDatabaseEnvironment } from "./production-shadow-risk-runtime.js";
import { validateGatewayRuntimeConfig } from "./runtime-config.js";

const command = process.argv[2];
if (command === "runtime-config-check") {
  validateGatewayRuntimeConfig();
  console.log("Gateway/Admin runtime config check passed");
} else if (command === "production-shadow-risk-init") {
  const config = await loadConfig();
  const runtime = await openRuntimeDatabase({ backend: "postgres", config, environment: process.env });
  try {
    await initializeDatabaseProductionShadowRiskGuard(runtime.shadowRisk, process.env);
    console.log(JSON.stringify(await inspectDatabaseProductionShadowRiskState(runtime.shadowRisk, process.env)));
  } finally { await runtime.close(); }
} else if (command === "production-shadow-risk-self-check") {
  const config = await loadConfig();
  const runtime = await openRuntimeDatabase({ backend: "postgres", config, environment: process.env });
  try {
    const guard = productionShadowRiskGuardFromDatabaseEnvironment(runtime.shadowRisk, process.env);
    await guard.selfCheck();
    console.log(JSON.stringify({ ok: true }));
  } finally { await runtime.close(); }
} else {
  throw new Error("Usage: bun dist/cli.js runtime-config-check|production-shadow-risk-init|production-shadow-risk-self-check");
}
