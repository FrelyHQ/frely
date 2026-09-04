import "@frely/ui/styles.css";
import "../../pages/landing.css";
import "../../pages/styles.css";
import "@frely/console-ui/styles.css";
import { TooltipProvider } from "@frely/ui/components/tooltip";
import { createServerFn } from "@tanstack/react-start";
import { Outlet, createRootRoute } from "@tanstack/react-router";
import { ClarityAnalytics } from "../../pages/clarity-analytics";
import { WebQueryProvider } from "../../pages/query-provider";
import { WebShell } from "../../pages/web-shell";
import { WebPageSurfaceContent } from "../observability-client";
import { WebRootErrorComponent } from "../root-error-boundary";
import { WebRootShell } from "../root-shell";

const loadRootContext = createServerFn({ method: "GET" }).handler(async () => {
  const { loadWebRootContext } = await import("../server/root-loader.server");
  return loadWebRootContext();
});

export const Route = createRootRoute({
  loader: () => loadRootContext(),
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "description", content: "User and team console for Frely" },
      { title: "Frely Web" },
    ],
  }),
  shellComponent: WebRootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: WebRootErrorComponent,
});

function RootComponent() {
  const context = Route.useLoaderData();
  const profile = context.sessionIdentity
    ? {
        label: context.sessionIdentity.email,
        subtext: context.sessionIdentity.teamRoles.length > 0
          ? `${context.sessionIdentity.teamRoles.length} owner team${context.sessionIdentity.teamRoles.length === 1 ? "" : "s"}`
          : "User workspace",
      }
    : { label: "User Profile", subtext: "Web workspace" };
  return (
    <TooltipProvider>
      <WebQueryProvider
        originalUserId={context.sessionIdentity?.userId ?? null}
        release={context.release}
        sessionExpiresAtEpochSeconds={context.sessionIdentity?.expiresAtEpochSeconds ?? null}
        traceSampleRatio={context.traceSampleRatio}
      >
        <WebPageSurfaceContent>
          <WebShell navItems={context.navItems} profileLabel={profile.label} profileSubtext={profile.subtext}>
            <Outlet />
          </WebShell>
        </WebPageSurfaceContent>
      </WebQueryProvider>
      <ClarityAnalytics projectId={context.clarityProjectId} release={context.release} />
    </TooltipProvider>
  );
}

function NotFoundComponent() {
  return (
    <section className="not-found-page" aria-labelledby="not-found-title">
      <div className="not-found-panel panel">
        <p className="eyebrow">404</p>
        <h1 id="not-found-title">Page not found</h1>
        <p className="muted">The User page you requested does not exist.</p>
        <a className="button" href="/user">Return to User Home</a>
      </div>
    </section>
  );
}
