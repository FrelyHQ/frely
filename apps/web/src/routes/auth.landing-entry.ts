import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/auth/landing-entry")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { POST } = await import("../../pages/auth/landing-entry/route");
        return POST(request);
      },
    },
  },
});
