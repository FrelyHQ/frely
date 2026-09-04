import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/user/api-keys")({
  beforeLoad: () => { throw redirect({ to: "/user/keys" }); },
});
