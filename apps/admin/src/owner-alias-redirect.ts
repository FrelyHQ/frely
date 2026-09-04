import { createServerFn } from "@tanstack/react-start";

export const ownerAliasRedirectAuthorized = createServerFn({ method: "GET" }).handler(async () => {
  const { adminPageServices } = await import("../lib/server");
  return Boolean(await adminPageServices());
});
