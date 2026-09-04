import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import Page from "../../pages/key/page";
import { runWebPageLoader } from "../page-request";

const loadPageData = createServerFn({ method: "GET", strict: false })
  .handler(async () => {
    const { loadPage } = await import("../../pages/key/page.server");
    return runWebPageLoader(loadPage);
  });

export const Route = createFileRoute("/key")({
  loader: () => loadPageData(),
  head: () => ({ meta: [{ title: "API Key Self Usage | Frely" }] }),
  component: PageRoute,
});

function PageRoute() {
  return <Page data={Route.useLoaderData() as Parameters<typeof Page>[0]["data"]} />;
}
