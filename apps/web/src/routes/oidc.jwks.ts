import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/oidc/jwks")({
  server: {
    handlers: {
      GET: async () => {
        const { GET } = await import("../../pages/oidc/jwks/route");
        return GET();
      },
    },
  },
});
