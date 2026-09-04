import { Outlet, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/user/plans-and-budgets")({ component: Outlet });
