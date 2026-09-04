"use client";

import { ConsoleHeader, consoleNavLabel } from "@frely/console-ui";
import { usePathname } from "@admin/navigation";
import { navItems } from "../_data/owner-data";

export function AdminConsoleHeader({ environment }: { environment: string }) {
  const pathname = usePathname();
  return <ConsoleHeader environment={environment} context={consoleNavLabel(navItems, pathname) ?? "Owner Console"} />;
}
