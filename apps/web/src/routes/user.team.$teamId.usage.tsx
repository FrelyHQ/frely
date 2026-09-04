import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import Page from "../../pages/user/team/[teamId]/usage/page";
import { runWebPageLoader, validateWebPageInput, webPageRequest } from "../page-request";

const loadPageData = createServerFn({ method: "GET", strict: false }).validator(validateWebPageInput).handler(async ({ data }) => {
  const { loadPage } = await import("../../pages/user/team/[teamId]/usage/page.server");
  return runWebPageLoader(() => loadPage(data.params.teamId ?? "", data.search));
});

export const Route = createFileRoute("/user/team/$teamId/usage")({
  validateSearch: (search) => webPageRequest({}, search).search,
  loader: ({ params, location }) => loadPageData({ data: webPageRequest(params, location.search) }),
  component: PageRoute,
});
function PageRoute() { return <Page data={Route.useLoaderData() as Parameters<typeof Page>[0]["data"]} />; }
