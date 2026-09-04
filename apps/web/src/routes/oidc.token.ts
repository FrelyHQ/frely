import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/oidc/token")({
  server: {
    handlers: {
      POST: async () => {
        const { POST } = await import("../../pages/oidc/token/route");
        return POST();
      },
    },
  },
});
