import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import Page from "../../pages/owner/audit-logs/page";
import { adminPageRequest, runAdminPageLoader, validateAdminPageInput, validateAdminSearch } from "../page-request";

const loadPageData = createServerFn({ method: "GET", strict: false })
  .validator(validateAdminPageInput)
  .handler(async ({ data }) => {
    const { loadPage } = await import("../../pages/owner/audit-logs/page.server");
    return runAdminPageLoader(() => loadPage(data));
  });

export const Route = createFileRoute("/owner/audit-logs")({
  validateSearch: validateAdminSearch,
  loader: ({ params, location }) => loadPageData({ data: adminPageRequest(params, location.search) }),
  component: PageRoute,
});

function PageRoute() {
  return <Page data={Route.useLoaderData() as Parameters<typeof Page>[0]["data"]} />;
}
