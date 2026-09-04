import { PageHeading } from "@frely/console-ui";
import { OwnerPasswordChange } from "../../../../features/security";
import type { AdminPageData } from "./page.server";

export default function OwnerAccountSecurityPage({ data: loaded }: { data: AdminPageData }) {
  if (!loaded) return null;
  return (
    <>
      <PageHeading
        eyebrow="Owner Account Security"
        title="Password"
        description="Manage the password used to sign in to the Owner Console. Admin access is still authorized separately."
      />
      <div className="space-y-6"><OwnerPasswordChange /></div>
    </>
  );
}
