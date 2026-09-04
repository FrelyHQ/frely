import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import Page from "../../pages/page";
import { runWebPageLoader, validateWebPageInput, webPageRequest } from "../page-request";

const loadPageData = createServerFn({ method: "GET", strict: false })
  .validator(validateWebPageInput)
  .handler(async () => {
    const { loadPage } = await import("../../pages/page.server");
    return runWebPageLoader(() => loadPage());
  });

export const Route = createFileRoute("/")({
  loader: () => loadPageData({ data: webPageRequest({}, {}) }),
  head: () => ({
    meta: [
      { title: "Frely | 建立自己的 AI 中转站" },
      { name: "description", content: "创建属于你的 Team，向成员与客户提供模型能力，并获得独立域名与部署服务。" },
    ],
  }),
  component: PageRoute,
});

function PageRoute() {
  return <Page data={Route.useLoaderData() as Parameters<typeof Page>[0]["data"]} />;
}
