import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/oidc/revoke")({
  server: {
    handlers: {
      POST: async () => {
        const { POST } = await import("../../pages/oidc/revoke/route");
        return POST();
      },
    },
  },
});
