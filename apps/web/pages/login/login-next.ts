import { safeNextPath } from "../../lib/safe-navigation";

const DEFAULT_WEB_LOGIN_NEXT = "/user";

export function webLoginHref(publicOrigin: string): string {
  return new URL(`/login?next=${encodeURIComponent(DEFAULT_WEB_LOGIN_NEXT)}`, publicOrigin).toString();
}

export function safeWebLoginNext(value: string | null): string {
  const safePath = safeNextPath(value);
  const target = new URL(safePath, "https://friday-relay.invalid");
  if (target.pathname === "/login" || target.pathname.startsWith("/login/")) return DEFAULT_WEB_LOGIN_NEXT;
  return safePath;
}
