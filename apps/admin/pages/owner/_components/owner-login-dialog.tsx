"use client";

import { LoginForm } from "@frely/ui/components/login-form";
import { ConsoleAuthShell } from "@frely/console-ui";

export function AdminLoginDialog({ environment }: { environment: string }) {
  return <ConsoleAuthShell context="Owner Console" environment={environment}><LoginForm onSuccess={() => completeAdminLogin()} /></ConsoleAuthShell>;
}

export function completeAdminLogin(assign: (url: string) => void = (url) => window.location.assign(url)) {
  assign("/owner");
}
