import { Outlet, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/user/tools")({ component: Outlet });
