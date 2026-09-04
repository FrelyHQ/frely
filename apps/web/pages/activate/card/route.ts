import { cardActivationCodeHash, signCardActivationIntent, verifyCardActivationIntent } from "@frely/ui-application/server";
import { resolveWebRegistrationTargetAsync } from "../../../lib/registration";
import { handle, services } from "../../../lib/server";

const ACTIVATION_COOKIE = "friday_relay_card_activation_intent";
const ACTIVATION_TTL_SECONDS = 1_800;
const RAW_CODE_PATTERN = /^fca_[A-Za-z0-9_-]{32}$/u;

export async function GET(request: Request) {
  return handle(request, async ({ hostScope }) => {
    const { application, asyncTenancy, config } = await services();
    const url = new URL(request.url);
    const values = url.searchParams.getAll("code");
    if (values.length > 1 || (values.length === 1 && !RAW_CODE_PATTERN.test(values[0]!))) {
      return cleanActivationRedirect(config, clearActivationCookie(config.auth.cookieSecure));
    }
    if (values.length === 1) {
      const preview = await application.billingQueries.previewCardActivationCode(cardActivationCodeHash(values[0]!));
      if (!preview) return cleanActivationRedirect(config, clearActivationCookie(config.auth.cookieSecure));
      const expiresAtEpochSeconds = Math.floor(Date.now() / 1000) + ACTIVATION_TTL_SECONDS;
      const intent = signCardActivationIntent(cardActivationCodeHash(values[0]!), expiresAtEpochSeconds, config.auth.jwtSecret);
      const response = Response.redirect(new URL("/activate/card", config.app.publicBaseUrl), 303);
      response.headers.set("cache-control", "no-store");
      response.headers.set("referrer-policy", "no-referrer");
      response.headers.set("set-cookie", serializeActivationCookie(intent, ACTIVATION_TTL_SECONDS, config.auth.cookieSecure));
      return response;
    }

    const intent = readCookie(request.headers, ACTIVATION_COOKIE);
    const verified = intent ? verifyCardActivationIntent(intent, config.auth.jwtSecret) : null;
    const preview = verified
      ? await application.billingQueries.previewCardActivationCode(verified.codeHash)
      : undefined;
    if (!preview) return activationPageResponse("This Card Activation code is unavailable.", undefined, config, intent ? clearActivationCookie(config.auth.cookieSecure) : undefined);

    let signedIn = false;
    try {
      await asyncTenancy.requireUser(request.headers);
      signedIn = true;
    } catch {
      // The activation intent is intentionally retained while the user signs in.
    }
    const productLabel = preview.cardType === "plan"
      ? `${preview.plan?.name ?? "Plan"} v${preview.plan?.version ?? "?"}`
      : `${preview.credit?.name ?? "Credit"} · ${preview.credit?.amountUnits ?? 0} units`;
    const registration = !signedIn
      ? await resolveWebRegistrationTargetAsync({ repo: application.queries, tenancy: asyncTenancy.tenancy, config, headers: request.headers, hostScope, entry: "global" })
      : undefined;
    const body = signedIn
      ? `<form id="card-activation-confirm"><button type="submit">Activate ${escapeHtml(productLabel)}</button></form><p id="card-activation-result" role="status"></p><script>document.getElementById('card-activation-confirm')?.addEventListener('submit',async(event)=>{event.preventDefault();const result=document.getElementById('card-activation-result');try{const response=await fetch('/api/user/card-activations/confirm',{method:'POST',credentials:'same-origin',headers:{accept:'application/json'}});const payload=await response.json();if(!response.ok)throw new Error(payload.message||'Activation failed');if(result)result.innerHTML='Card added to <a href="/user/cards">My Cards</a>.';}catch(error){if(result)result.textContent=error instanceof Error?error.message:'Activation failed';}});</script>`
      : `<p><a href="/login?next=%2Factivate%2Fcard">Sign in to activate this Card</a>${registration?.target ? ` or <a href="/register?entry=global">register an account</a>` : ""}.</p>`;
    return activationPageResponse(`Card Activation · ${productLabel}`, body, config);
  });
}

function cleanActivationRedirect(config: { app: { publicBaseUrl: string } }, clearCookie?: string): Response {
  const response = Response.redirect(new URL("/activate/card", config.app.publicBaseUrl), 303);
  response.headers.set("cache-control", "no-store");
  response.headers.set("referrer-policy", "no-referrer");
  if (clearCookie) response.headers.set("set-cookie", clearCookie);
  return response;
}

function activationPageResponse(title: string, body: string | undefined, config: { auth: { cookieSecure: boolean } }, clearCookie?: string): Response {
  const response = new Response(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><main><h1>${escapeHtml(title)}</h1>${body ?? ""}</main></body></html>`, {
    status: body ? 200 : 404,
    headers: { "cache-control": "private, no-store", "content-type": "text/html; charset=utf-8", "referrer-policy": "no-referrer" },
  });
  if (clearCookie) response.headers.set("set-cookie", clearCookie);
  return response;
}

function serializeActivationCookie(value: string, maxAge: number, secure: boolean): string {
  return `${ACTIVATION_COOKIE}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

function clearActivationCookie(secure: boolean): string {
  return serializeActivationCookie("", 0, secure);
}

function readCookie(headers: Headers, name: string): string | null {
  for (const part of (headers.get("cookie") ?? "").split(";")) {
    const [key, ...parts] = part.trim().split("=");
    if (key !== name) continue;
    try { return decodeURIComponent(parts.join("=")); } catch { return null; }
  }
  return null;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}
