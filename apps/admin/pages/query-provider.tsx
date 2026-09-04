"use client";

import { createConsoleQueryClient } from "@frely/console-ui/query-client";
import { AdminUiSurfaceProvider } from "../src/observability-client";
import { SessionRecoverySurface } from "@frely/console-ui/session-recovery-dialog";
import { completeUnauthorizedRecovery, createUnauthorizedRecoveryController, installSessionExpiryRecovery, installUnauthorizedResponseInterceptor } from "@frely/console-ui/unauthorized-response";
import { QueryClientProvider } from "@tanstack/react-query";
import { useRouter } from "@admin/navigation";
import { useLayoutEffect, useState, type ReactNode } from "react";
import { routeRegistry } from "@admin/telemetry/generated-route-registry";

export function AdminQueryProvider({
  children,
  originalUserId,
  release,
  sessionExpiresAtEpochSeconds,
  traceSampleRatio
}: {
  children: ReactNode;
  originalUserId: string | null;
  release: string;
  sessionExpiresAtEpochSeconds: number | null;
  traceSampleRatio: number;
}) {
  const router = useRouter();
  const [recoveryActive, setRecoveryActive] = useState(false);
  const [recoveryController] = useState(() => createUnauthorizedRecoveryController(() => setRecoveryActive(true)));
  const [queryClient] = useState(() => createConsoleQueryClient({ onUnauthorized: recoveryController.onUnauthorized }));
  useLayoutEffect(() => installUnauthorizedResponseInterceptor(recoveryController.onUnauthorized), [recoveryController]);
  useLayoutEffect(
    () => installSessionExpiryRecovery(sessionExpiresAtEpochSeconds, recoveryController.onUnauthorized),
    [recoveryController, sessionExpiresAtEpochSeconds]
  );

  return (
    <AdminUiSurfaceProvider release={release} routeRegistry={routeRegistry} traceSampleRatio={traceSampleRatio}>
      <QueryClientProvider client={queryClient}>
        <SessionRecoverySurface
          active={recoveryActive}
          onRecovered={(user) => completeUnauthorizedRecovery(recoveryController, {
            originalUserId,
            authenticatedUserId: user.id,
            deactivate: () => setRecoveryActive(false),
            refresh: () => router.refresh(),
            hardNavigate: (url) => window.location.replace(url),
            differentUserHome: "/owner"
          })}
        >
          {children}
        </SessionRecoverySurface>
      </QueryClientProvider>
    </AdminUiSurfaceProvider>
  );
}
