import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/oidc/authorize")({
  server: {
    handlers: {
      GET: async () => {
        const { GET } = await import("../../pages/oidc/authorize/route");
        return GET();
      },
      POST: async () => {
        const { POST } = await import("../../pages/oidc/authorize/route");
        return POST();
      },
    },
  },
});
