import { Outlet, createFileRoute, getRouteApi } from "@tanstack/react-router";
import { AdminLoginDialog } from "../../pages/owner/_components/owner-login-dialog";
import { AdminConsoleHeader } from "../../pages/owner/_components/header";
import { AdminSidebar } from "../../pages/owner/_components/sidebar";

const rootRoute = getRouteApi("__root__");

export const Route = createFileRoute("/owner")({
  component: OwnerLayout,
});

function OwnerLayout() {
  const context = rootRoute.useLoaderData();
  if (!context.ownerAuthorized) {
    return (
      <div className="admin-auth-shell">
        <AdminLoginDialog
          environment={context.environment}
        />
      </div>
    );
  }
  return (
    <div className="admin-shell">
      <AdminSidebar environment={context.environment} />
      <div className="workspace">
        <AdminConsoleHeader environment={context.environment} />
        <main className="console-content"><Outlet /></main>
      </div>
    </div>
  );
}
