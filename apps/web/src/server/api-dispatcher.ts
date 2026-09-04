import { dispatchWebApi, type WebApiRouteDefinition } from "./api-dispatch";
import * as route0 from "../../pages/api/account/security/passkeys/[passkeyId]/delete/route";
import * as route1 from "../../pages/api/account/security/passkeys/[passkeyId]/route";
import * as route2 from "../../pages/api/account/security/passkeys/registration/options/route";
import * as route3 from "../../pages/api/account/security/passkeys/registration/verify/route";
import * as route4 from "../../pages/api/account/security/passkeys/route";
import * as route5 from "../../pages/api/auth/login/route";
import * as route6 from "../../pages/api/auth/logout/route";
import * as route7 from "../../pages/api/auth/me/route";
import * as route8 from "../../pages/api/auth/passkey/options/route";
import * as route9 from "../../pages/api/auth/passkey/verify/route";
import * as route10 from "../../pages/api/auth/refresh/route";
import * as route11 from "../../pages/api/health/route";
import * as route12 from "../../pages/api/invite-links/[inviteLinkId]/route";
import * as route13 from "../../pages/api/key/[[...path]]/route";
import * as route14 from "../../pages/api/landing-registration/route";
import * as route15 from "../../pages/api/self-registration/route";
import * as route16 from "../../pages/api/stripe/webhook/route";
import * as route17 from "../../pages/api/team/[[...path]]/route";
import * as route18 from "../../pages/api/telemetry/browser/route";
import * as route19 from "../../pages/api/user/[[...path]]/route";
import * as route20 from "../../pages/api/user/card-activations/confirm/route";
import * as route21 from "../../pages/api/user/domain-bindings/route";
import * as route22 from "../../pages/api/user/partner-team-allocations/[allocationId]/consume/route";
import * as route23 from "../../pages/api/user/partner-team-allocations/route";
import * as route24 from "../../pages/api/user/plan-purchases/[orderId]/cancel/route";
import * as route25 from "../../pages/api/user/plan-purchases/[orderId]/route";
import * as route26 from "../../pages/api/user/plan-purchases/route";
import * as route27 from "../../pages/api/user/security/password/route";
import * as route28 from "../../pages/api/user/service-orders/[orderId]/cancel/route";
import * as route29 from "../../pages/api/user/service-orders/[orderId]/payment/route";
import * as route30 from "../../pages/api/user/service-orders/route";
import * as route31 from "../../pages/api/user/service-products/route";
import * as route32 from "../../pages/api/user/stripe/checkout/route";

const routes = [
  { pattern: /^\/api\/account\/security\/passkeys\/([^\/]+)\/delete\/?$/, params: [{ name: "passkeyId", catchall: false }], methods: ["POST"], module: route0 },
  { pattern: /^\/api\/account\/security\/passkeys\/([^\/]+)\/?$/, params: [{ name: "passkeyId", catchall: false }], methods: ["PATCH"], module: route1 },
  { pattern: /^\/api\/account\/security\/passkeys\/registration\/options\/?$/, params: [], methods: ["POST"], module: route2 },
  { pattern: /^\/api\/account\/security\/passkeys\/registration\/verify\/?$/, params: [], methods: ["POST"], module: route3 },
  { pattern: /^\/api\/account\/security\/passkeys\/?$/, params: [], methods: ["GET"], module: route4 },
  { pattern: /^\/api\/auth\/login\/?$/, params: [], methods: ["POST"], module: route5 },
  { pattern: /^\/api\/auth\/logout\/?$/, params: [], methods: ["POST"], module: route6 },
  { pattern: /^\/api\/auth\/me\/?$/, params: [], methods: ["GET"], module: route7 },
  { pattern: /^\/api\/auth\/passkey\/options\/?$/, params: [], methods: ["POST"], module: route8 },
  { pattern: /^\/api\/auth\/passkey\/verify\/?$/, params: [], methods: ["POST"], module: route9 },
  { pattern: /^\/api\/auth\/refresh\/?$/, params: [], methods: ["POST"], module: route10 },
  { pattern: /^\/api\/health\/?$/, params: [], methods: ["GET"], module: route11 },
  { pattern: /^\/api\/invite-links\/([^\/]+)\/?$/, params: [{ name: "inviteLinkId", catchall: false }], methods: ["GET", "POST"], module: route12 },
  { pattern: /^\/api\/key(?:\/(.*))?\/?$/, params: [{ name: "path", catchall: true }], methods: ["GET"], module: route13 },
  { pattern: /^\/api\/landing-registration\/?$/, params: [], methods: ["POST"], module: route14 },
  { pattern: /^\/api\/self-registration\/?$/, params: [], methods: ["POST"], module: route15 },
  { pattern: /^\/api\/stripe\/webhook\/?$/, params: [], methods: ["POST"], module: route16 },
  { pattern: /^\/api\/team(?:\/(.*))?\/?$/, params: [{ name: "path", catchall: true }], methods: ["GET", "POST", "PATCH", "DELETE"], module: route17 },
  { pattern: /^\/api\/telemetry\/browser\/?$/, params: [], methods: ["POST"], module: route18 },
  { pattern: /^\/api\/user(?:\/(.*))?\/?$/, params: [{ name: "path", catchall: true }], methods: ["GET", "PUT", "PATCH", "POST", "DELETE"], module: route19 },
  { pattern: /^\/api\/user\/card-activations\/confirm\/?$/, params: [], methods: ["POST"], module: route20 },
  { pattern: /^\/api\/user\/domain-bindings\/?$/, params: [], methods: ["GET", "POST"], module: route21 },
  { pattern: /^\/api\/user\/partner-team-allocations\/([^\/]+)\/consume\/?$/, params: [{ name: "allocationId", catchall: false }], methods: ["POST"], module: route22 },
  { pattern: /^\/api\/user\/partner-team-allocations\/?$/, params: [], methods: ["GET"], module: route23 },
  { pattern: /^\/api\/user\/plan-purchases\/([^\/]+)\/cancel\/?$/, params: [{ name: "orderId", catchall: false }], methods: ["POST"], module: route24 },
  { pattern: /^\/api\/user\/plan-purchases\/([^\/]+)\/?$/, params: [{ name: "orderId", catchall: false }], methods: ["GET"], module: route25 },
  { pattern: /^\/api\/user\/plan-purchases\/?$/, params: [], methods: ["POST"], module: route26 },
  { pattern: /^\/api\/user\/security\/password\/?$/, params: [], methods: ["POST"], module: route27 },
  { pattern: /^\/api\/user\/service-orders\/([^\/]+)\/cancel\/?$/, params: [{ name: "orderId", catchall: false }], methods: ["POST"], module: route28 },
  { pattern: /^\/api\/user\/service-orders\/([^\/]+)\/payment\/?$/, params: [{ name: "orderId", catchall: false }], methods: ["POST"], module: route29 },
  { pattern: /^\/api\/user\/service-orders\/?$/, params: [], methods: ["GET", "POST"], module: route30 },
  { pattern: /^\/api\/user\/service-products\/?$/, params: [], methods: ["GET"], module: route31 },
  { pattern: /^\/api\/user\/stripe\/checkout\/?$/, params: [], methods: ["POST"], module: route32 },
] as const satisfies readonly WebApiRouteDefinition[];

export function webApiRouteInventory() {
  return {
    families: routes.length,
    methods: routes.reduce((total, route) => total + route.methods.length, 0),
  } as const;
}

export function dispatchWebApiRoute(request: Request): Promise<Response> {
  return dispatchWebApi(request, routes);
}
