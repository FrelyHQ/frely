import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import Page from "../../pages/register/page";
import { runWebPageLoader, validateWebPageInput, webPageRequest } from "../page-request";

const loadPageData = createServerFn({ method: "GET", strict: false })
  .validator(validateWebPageInput)
  .handler(async ({ data }) => {
    const { loadPage } = await import("../../pages/register/page.server");
    const params = {
      ...(data.search.token === undefined ? {} : { token: data.search.token }),
      ...(data.search.entry === undefined ? {} : { entry: data.search.entry }),
    };
    return runWebPageLoader(() => loadPage(params));
  });

export const Route = createFileRoute("/register")({
  validateSearch: (search) => webPageRequest({}, search).search,
  loader: ({ location }) => loadPageData({ data: webPageRequest({}, location.search) }),
  head: () => ({ meta: [{ title: "Register | Frely" }, { name: "referrer", content: "no-referrer" }] }),
  component: PageRoute,
});

function PageRoute() {
  return <Page data={Route.useLoaderData() as Parameters<typeof Page>[0]["data"]} />;
}
