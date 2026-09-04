"use client";

import { ConsoleSidebar } from "@frely/console-ui";
import { usePathname } from "@admin/navigation";
import { navItems } from "../_data/owner-data";

export function AdminSidebar({ environment }: { environment: string }) {
  const pathname = usePathname();

  return (
    <ConsoleSidebar
      brandTitle="Frely"
      brandSubtitle="Owner Console"
      navItems={navItems}
      currentPath={pathname}
      profileLabel="Owner Profile"
      profileSubtext={`${environment} Environment`}
      profileHref="/owner/account/security"
      loginHref="/owner"
    />
  );
}
