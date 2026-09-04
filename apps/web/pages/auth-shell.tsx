import { ConsoleAuthShell } from "@frely/console-ui";

export function AuthShell({ children, width = "sm" }: { children: React.ReactNode; width?: "sm" | "md" }) {
  return <ConsoleAuthShell context="User Console" width={width}>{children}</ConsoleAuthShell>;
}
