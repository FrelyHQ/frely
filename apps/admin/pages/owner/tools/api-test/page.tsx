import { PageHeading } from "../../_components/ui";
import { ApiTestWorkbench } from "../../../../features/api-test";
import type { AdminPageData } from "./page.server";

export default function ApiTestPage({ data: loaded }: { data: AdminPageData }) {
  if (!loaded) return null;
  return (
    <>
      <PageHeading
        eyebrow="Tools / API Test"
        title="Relay API Test"
        description="Test Chat Completions, Responses, or Messages through friday-relay and copy a matching curl command."
      />
      <ApiTestWorkbench />
    </>
  );
}
