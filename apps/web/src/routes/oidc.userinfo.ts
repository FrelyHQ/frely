import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/oidc/userinfo")({
  server: {
    handlers: {
      GET: async () => {
        const { GET } = await import("../../pages/oidc/userinfo/route");
        return GET();
      },
    },
  },
});
