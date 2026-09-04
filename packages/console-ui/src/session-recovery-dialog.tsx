"use client";

import type { ReactNode } from "react";
import { LoginForm } from "@frely/ui/components/login-form";
import type { AuthenticatedLoginUser } from "@frely/ui/lib/login-api";
import { ConsoleDialog } from "./console-dialog.js";

export function SessionRecoverySurface({
  active,
  children,
  onRecovered
}: {
  active: boolean;
  children: ReactNode;
  onRecovered: (user: AuthenticatedLoginUser) => void;
}) {
  return (
    <>
      {children}
      {active ? <SessionRecoveryDialog onRecovered={onRecovered} /> : null}
    </>
  );
}

function SessionRecoveryDialog({ onRecovered }: { onRecovered: (user: AuthenticatedLoginUser) => void }) {
  return (
    <ConsoleDialog
      observabilityKey="session-recovery"
      titleId="session-recovery-title"
      eyebrow="Session"
      title="Sign in again"
      description="Your session expired. Sign in with the same account to keep unsaved changes. A different account starts a new session and discards this page."
      closeDisabled
      onClose={() => undefined}
    >
      <LoginForm onSuccess={onRecovered} />
    </ConsoleDialog>
  );
}
