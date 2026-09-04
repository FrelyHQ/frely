import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/$")({
  server: {
    handlers: {
      ANY: async ({ request }) => {
        const { dispatchWebApiRoute } = await import("../server/api-dispatcher");
        return dispatchWebApiRoute(request);
      },
    },
  },
});
