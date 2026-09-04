import { createFileRoute, redirect } from "@tanstack/react-router";
import { ownerAliasRedirectAuthorized } from "../owner-alias-redirect";

export const Route = createFileRoute("/owner/budget-managers")({
  beforeLoad: async () => {
    if (!await ownerAliasRedirectAuthorized()) return;
    throw redirect({ href: "/owner/plans-and-budgets/budget-policies", statusCode: 307 });
  },
});
