import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import Page from "../../pages/user/keys/[keyId]/page";
import { runWebPageLoader, validateWebPageInput, webPageRequest } from "../page-request";

const loadPageData = createServerFn({ method: "GET", strict: false }).validator(validateWebPageInput).handler(async ({ data }) => {
  const { loadPage } = await import("../../pages/user/keys/[keyId]/page.server");
  return runWebPageLoader(() => loadPage(data.params.keyId ?? ""));
});

export const Route = createFileRoute("/user/keys/$keyId")({
  loader: ({ params }) => loadPageData({ data: webPageRequest(params, {}) }),
  component: PageRoute,
});
function PageRoute() { return <Page data={Route.useLoaderData() as Parameters<typeof Page>[0]["data"]} />; }
