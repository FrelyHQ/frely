import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/activate/card")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { GET } = await import("../../pages/activate/card/route");
        return GET(request);
      },
    },
  },
});
