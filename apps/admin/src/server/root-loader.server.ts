import { adminRootSessionProjection } from "../../lib/server";

export async function loadAdminRootContext() {
  const session = await adminRootSessionProjection();
  return {
    ...session,
    release: process.env.FRIDAY_RELAY_RELEASE ?? "dev",
    traceSampleRatio: traceSampleRatio(),
  };
}

function traceSampleRatio(): number {
  const value = Number(process.env.FRIDAY_RELAY_OTEL_TRACE_SAMPLE_RATIO ?? "0.05");
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.05;
}
