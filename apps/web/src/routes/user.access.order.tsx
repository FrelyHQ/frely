import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import Page from "../../pages/user/access/order/page";
import { runWebPageLoader, validateWebPageInput, webPageRequest } from "../page-request";

const loadPageData = createServerFn({ method: "GET", strict: false }).validator(validateWebPageInput).handler(async ({ data }) => {
  const { loadPage } = await import("../../pages/user/access/order/page.server");
  return runWebPageLoader(() => loadPage(data.search));
});

export const Route = createFileRoute("/user/access/order")({
  validateSearch: (search) => webPageRequest({}, search).search,
  loader: ({ location }) => loadPageData({ data: webPageRequest({}, location.search) }),
  component: PageRoute,
});
function PageRoute() { return <Page data={Route.useLoaderData() as Parameters<typeof Page>[0]["data"]} />; }
