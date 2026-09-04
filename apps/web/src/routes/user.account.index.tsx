import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import Page from "../../pages/user/account/page";
import { runWebPageLoader, validateWebPageInput } from "../page-request";

const loadPageData = createServerFn({ method: "GET", strict: false }).validator(validateWebPageInput).handler(async () => {
  const { loadPage } = await import("../../pages/user/account/page.server");
  return runWebPageLoader(loadPage);
});

export const Route = createFileRoute("/user/account/")({ loader: () => loadPageData(), component: PageRoute });
function PageRoute() { return <Page data={Route.useLoaderData() as Parameters<typeof Page>[0]["data"]} />; }
