import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/.well-known/openid-configuration")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { GET } = await import("../../pages/.well-known/openid-configuration/route");
        return GET(request);
      },
    },
  },
});
