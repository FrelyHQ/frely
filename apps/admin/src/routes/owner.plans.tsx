import { Outlet, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/owner/plans")({
  component: Outlet,
});
