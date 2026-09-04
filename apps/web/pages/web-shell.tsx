"use client";

import { ConsoleShell, type ConsoleNavItem } from "@frely/console-ui";
import { usePathname } from "@web/navigation";

export function WebShell({
  children,
  navItems,
  profileLabel = "User Profile",
  profileSubtext = "Web workspace"
}: {
  children: React.ReactNode;
  navItems: ConsoleNavItem[];
  profileLabel?: string;
  profileSubtext?: string;
}) {
  const pathname = usePathname();

  if (pathname === "/" || pathname.startsWith("/login") || pathname.startsWith("/register")) {
    return children;
  }

  return (
    <ConsoleShell
      brandTitle="Frely"
      brandSubtitle="User Console"
      navItems={navItems}
      currentPath={pathname}
      profileLabel={profileLabel}
      profileSubtext={profileSubtext}
      loginHref="/login"
    >
      {children}
    </ConsoleShell>
  );
}
