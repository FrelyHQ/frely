const INTERNAL_NAVIGATION_ORIGIN = "https://friday-relay.invalid";

export function safeNextPath(value: string | null): string {
  if (!value || !value.startsWith("/")) return "/user";
  try {
    const target = new URL(value, INTERNAL_NAVIGATION_ORIGIN);
    if (target.origin !== INTERNAL_NAVIGATION_ORIGIN) return "/user";
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return "/user";
  }
}
