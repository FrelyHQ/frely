import { PageHeading } from "@frely/console-ui";
import { WebPasswordChange } from "../../../../features/security";
import type { AccountSecurityPageData } from "./page.server";

export default function AccountSecurityPage({ data }: { data: AccountSecurityPageData }) {
  void data;
  return (
    <>
      <PageHeading eyebrow="Account Security" title="Password" description="Manage the password used to sign in to your Frely account." />
      <div className="space-y-6"><WebPasswordChange /></div>
    </>
  );
}
