import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import Page from "../../pages/login/page";
import { runWebPageLoader, validateWebPageInput, webPageRequest } from "../page-request";

const loadPageData = createServerFn({ method: "GET", strict: false })
  .validator(validateWebPageInput)
  .handler(async ({ data }) => {
    const { loadPage } = await import("../../pages/login/page.server");
    const params: { next?: string; entry?: string } = {};
    const next = singleValue(data.search.next);
    const entry = singleValue(data.search.entry);
    if (next !== undefined) params.next = next;
    if (entry !== undefined) params.entry = entry;
    return runWebPageLoader(() => loadPage(params));
  });

export const Route = createFileRoute("/login")({
  validateSearch: (search) => webPageRequest({}, search).search,
  loader: ({ location }) => loadPageData({ data: webPageRequest({}, location.search) }),
  head: () => ({ meta: [{ title: "Login | Frely" }, { name: "referrer", content: "no-referrer" }] }),
  component: PageRoute,
});

function PageRoute() {
  return <Page data={Route.useLoaderData() as Parameters<typeof Page>[0]["data"]} />;
}

function singleValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
