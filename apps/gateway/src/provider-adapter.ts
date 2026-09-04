import { existsSync } from "node:fs";
import type { ProviderRuntime } from "@frely/provider-runtime";
import type { ProviderRuntimeTargetReader } from "@frely/provider-runtime/server";
import { DefaultProviderAdapter, DefaultProviderRuntime } from "@frely/providers";

const E2E_RUNTIME_MARKER = "/app/.friday-relay-e2e-runtime";

export function createProviderRuntime(targets: ProviderRuntimeTargetReader): ProviderRuntime {
  const base = existsSync(E2E_RUNTIME_MARKER)
    ? new DefaultProviderAdapter({
        cliProxyClientOptions: {
          responseHeaderTimeoutMs: 2_000,
          nonStreamingBodyTimeoutMs: 2_000,
          streamHardLifetimeMs: 5_000
        },
        cliProxyTransportOptions: {
          streamIdleTimeoutMs: 500
        }
      })
    : new DefaultProviderAdapter();
  return new DefaultProviderRuntime(targets, base);
}
