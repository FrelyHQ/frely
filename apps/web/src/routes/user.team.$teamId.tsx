import { Outlet, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/user/team/$teamId")({ component: Outlet });
