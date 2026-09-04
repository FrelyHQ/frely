import { RelayError, requestIdFromHeaders } from "@frely/core";
import { verifyCardActivationIntent } from "@frely/ui-application/server";
import { handle, json, services } from "../../../../../lib/server";

const ACTIVATION_COOKIE = "friday_relay_card_activation_intent";

export async function POST(request: Request) {
  return handle(request, async () => {
    const { application, asyncTenancy, config } = await services();
    const claims = await asyncTenancy.requireUser(request.headers);
    const rawIntent = readCookie(request.headers, ACTIVATION_COOKIE);
    const intent = rawIntent ? verifyCardActivationIntent(rawIntent, config.auth.jwtSecret) : null;
    if (!intent) throw new RelayError("card_activation_unavailable", "Card Activation code is unavailable", 409);
    const result = await application.billingCommands.redeemCardActivationCode(intent.codeHash, claims.sub, { requestId: requestIdFromHeaders(request.headers) });
    const payload = {
      outcome: result.outcome,
      card: {
        id: result.card.id,
        cardType: result.card.cardType,
        planId: result.card.planId,
        creditProductId: result.card.creditProductId,
        creditAmountUnits: result.card.creditAmountUnits,
        createdAt: result.card.createdAt,
        expiresAt: result.card.expiresAt,
      },
      redirectTo: "/user/cards",
    } as const;
    const wantsHtml = request.headers.get("accept")?.includes("text/html") ?? false;
    const response = wantsHtml
      ? new Response("<!doctype html><html><head><meta charset=\"utf-8\"><title>Card added</title></head><body><main><h1>Card added to My Cards</h1><p><a href=\"/user/cards\">Open My Cards</a></p></main></body></html>", { headers: { "cache-control": "private, no-store", "content-type": "text/html; charset=utf-8", "referrer-policy": "no-referrer" } })
      : json(payload, { headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer" } });
    response.headers.set("set-cookie", clearActivationCookie(config.auth.cookieSecure));
    return response;
  });
}

function clearActivationCookie(secure: boolean): string {
  return `friday_relay_card_activation_intent=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

function readCookie(headers: Headers, name: string): string | null {
  for (const part of (headers.get("cookie") ?? "").split(";")) {
    const [key, ...parts] = part.trim().split("=");
    if (key !== name) continue;
    try { return decodeURIComponent(parts.join("=")); } catch { return null; }
  }
  return null;
}
