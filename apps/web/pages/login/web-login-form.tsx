"use client";

import { LoginForm } from "@frely/ui/components/login-form";

export function WebLoginForm({ next, registrationHref, registrationPrompt, registrationLabel }: { next: string; registrationHref?: string | undefined; registrationPrompt?: string | undefined; registrationLabel?: string | undefined }) {
  return <LoginForm registrationHref={registrationHref} registrationPrompt={registrationPrompt} registrationLabel={registrationLabel} onSuccess={() => completeWebLogin(next)} />;
}

export function completeWebLogin(next: string, assign: (url: string) => void = (url) => window.location.assign(url)) {
  assign(next);
}
