import "@frely/ui/styles.css";
import "../../pages/styles.css";
import "@frely/console-ui/styles.css";
import { Outlet, createRootRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { TooltipProvider } from "@frely/ui/components/tooltip";
import { AdminPageSurfaceContent } from "../observability-client";
import { AdminQueryProvider } from "../../pages/query-provider";
import Link from "../navigation";
import { runAdminPageLoader } from "../page-request";
import { AdminRootErrorComponent } from "../root-error-boundary";
import { AdminRootShell } from "../root-shell";

const loadRootContext = createServerFn({ method: "GET" }).handler(async () => {
  const { loadAdminRootContext } = await import("../server/root-loader.server");
  return runAdminPageLoader(loadAdminRootContext);
});

export const Route = createRootRoute({
  loader: () => loadRootContext(),
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "description", content: "Private Owner Console for Frely" },
      { title: "Frely Admin" },
    ],
  }),
  shellComponent: AdminRootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: AdminRootErrorComponent,
});

function RootComponent() {
  const context = Route.useLoaderData();
  return (
    <TooltipProvider>
      <AdminQueryProvider
        originalUserId={context.sessionIdentity?.userId ?? null}
        release={context.release}
        sessionExpiresAtEpochSeconds={context.sessionIdentity?.expiresAtEpochSeconds ?? null}
        traceSampleRatio={context.traceSampleRatio}
      >
        <nav className="topbar">
          <Link href="/">Frely Admin</Link>
          <Link href="/owner">Admin</Link>
        </nav>
        <AdminPageSurfaceContent><Outlet /></AdminPageSurfaceContent>
      </AdminQueryProvider>
    </TooltipProvider>
  );
}

function NotFoundComponent() {
  return (
    <section className="error-shell">
      <h1>Page not found</h1>
      <p>The requested Admin page does not exist.</p>
      <Link href="/owner">Return to Admin</Link>
    </section>
  );
}
