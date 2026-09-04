import { Outlet, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/owner/teams/$teamId")({
  component: Outlet,
});
