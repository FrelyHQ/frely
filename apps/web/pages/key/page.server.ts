import { getRequestHeaders } from "@tanstack/react-start/server";
import { services } from "../../lib/server";

export async function loadPage() {
  try {
    const { asyncTenancy } = await services();
    const claims = await asyncTenancy.requireUser(new Headers(getRequestHeaders()));
    return { currentUser: { id: claims.sub, email: claims.email } };
  } catch {
    return { currentUser: null };
  }
}

export type KeyPageData = Awaited<ReturnType<typeof loadPage>>;
