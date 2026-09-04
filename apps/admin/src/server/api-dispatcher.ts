import { dispatchApiRoutes, type AdminApiRouteDefinition } from "./api-dispatch";
import * as route0 from "../../pages/api/account/security/passkeys/registration/options/route";
import * as route1 from "../../pages/api/account/security/passkeys/registration/verify/route";
import * as route2 from "../../pages/api/account/security/passkeys/[passkeyId]/delete/route";
import * as route3 from "../../pages/api/account/security/passkeys/[passkeyId]/route";
import * as route4 from "../../pages/api/owner/plan-payment-listings/[listingId]/disable/route";
import * as route5 from "../../pages/api/owner/plan-purchase-orders/[orderId]/reverse/route";
import * as route6 from "../../pages/api/owner/service-orders/[orderId]/approve/route";
import * as route7 from "../../pages/api/owner/service-orders/[orderId]/reject/route";
import * as route8 from "../../pages/api/owner/service-orders/[orderId]/retry/route";
import * as route9 from "../../pages/api/owner/service-product-listings/[listingId]/status/route";
import * as route10 from "../../pages/api/owner/service-products/[productId]/status/route";
import * as route11 from "../../pages/api/account/security/passkeys/route";
import * as route12 from "../../pages/api/auth/passkey/options/route";
import * as route13 from "../../pages/api/auth/passkey/verify/route";
import * as route14 from "../../pages/api/owner/security/password/route";
import * as route15 from "../../pages/api/owner/plan-purchase-orders/[orderId]/route";
import * as route16 from "../../pages/api/owner/public-hosts/[id]/route";
import * as route17 from "../../pages/api/auth/login/route";
import * as route18 from "../../pages/api/auth/logout/route";
import * as route19 from "../../pages/api/auth/me/route";
import * as route20 from "../../pages/api/auth/refresh/route";
import * as route21 from "../../pages/api/owner/domain-bindings/[[...path]]/route";
import * as route22 from "../../pages/api/owner/plan-payment-listings/route";
import * as route23 from "../../pages/api/owner/plan-purchase-orders/route";
import * as route24 from "../../pages/api/owner/public-hosts/route";
import * as route25 from "../../pages/api/owner/service-orders/route";
import * as route26 from "../../pages/api/owner/service-product-listings/route";
import * as route27 from "../../pages/api/owner/service-products/route";
import * as route28 from "../../pages/api/owner/web-registration-settings/route";
import * as route29 from "../../pages/api/owner/web-registration-team-candidates/route";
import * as route30 from "../../pages/api/telemetry/browser/route";
import * as route31 from "../../pages/api/health/route";
import * as route32 from "../../pages/api/owner/[[...path]]/route";

const routes = [
  { pattern: /^\/api\/account\/security\/passkeys\/registration\/options\/?$/, params: [], methods: ["POST"], module: route0 },
  { pattern: /^\/api\/account\/security\/passkeys\/registration\/verify\/?$/, params: [], methods: ["POST"], module: route1 },
  { pattern: /^\/api\/account\/security\/passkeys\/([^\/]+)\/delete\/?$/, params: [{"name":"passkeyId","catchall":false}], methods: ["POST"], module: route2 },
  { pattern: /^\/api\/account\/security\/passkeys\/([^\/]+)\/?$/, params: [{"name":"passkeyId","catchall":false}], methods: ["PATCH"], module: route3 },
  { pattern: /^\/api\/owner\/plan-payment-listings\/([^\/]+)\/disable\/?$/, params: [{"name":"listingId","catchall":false}], methods: ["POST"], module: route4 },
  { pattern: /^\/api\/owner\/plan-purchase-orders\/([^\/]+)\/reverse\/?$/, params: [{"name":"orderId","catchall":false}], methods: ["POST"], module: route5 },
  { pattern: /^\/api\/owner\/service-orders\/([^\/]+)\/approve\/?$/, params: [{"name":"orderId","catchall":false}], methods: ["POST"], module: route6 },
  { pattern: /^\/api\/owner\/service-orders\/([^\/]+)\/reject\/?$/, params: [{"name":"orderId","catchall":false}], methods: ["POST"], module: route7 },
  { pattern: /^\/api\/owner\/service-orders\/([^\/]+)\/retry\/?$/, params: [{"name":"orderId","catchall":false}], methods: ["POST"], module: route8 },
  { pattern: /^\/api\/owner\/service-product-listings\/([^\/]+)\/status\/?$/, params: [{"name":"listingId","catchall":false}], methods: ["POST"], module: route9 },
  { pattern: /^\/api\/owner\/service-products\/([^\/]+)\/status\/?$/, params: [{"name":"productId","catchall":false}], methods: ["POST"], module: route10 },
  { pattern: /^\/api\/account\/security\/passkeys\/?$/, params: [], methods: ["GET"], module: route11 },
  { pattern: /^\/api\/auth\/passkey\/options\/?$/, params: [], methods: ["POST"], module: route12 },
  { pattern: /^\/api\/auth\/passkey\/verify\/?$/, params: [], methods: ["POST"], module: route13 },
  { pattern: /^\/api\/owner\/security\/password\/?$/, params: [], methods: ["POST"], module: route14 },
  { pattern: /^\/api\/owner\/plan-purchase-orders\/([^\/]+)\/?$/, params: [{"name":"orderId","catchall":false}], methods: ["GET"], module: route15 },
  { pattern: /^\/api\/owner\/public-hosts\/([^\/]+)\/?$/, params: [{"name":"id","catchall":false}], methods: ["PATCH","DELETE"], module: route16 },
  { pattern: /^\/api\/auth\/login\/?$/, params: [], methods: ["POST"], module: route17 },
  { pattern: /^\/api\/auth\/logout\/?$/, params: [], methods: ["POST"], module: route18 },
  { pattern: /^\/api\/auth\/me\/?$/, params: [], methods: ["GET"], module: route19 },
  { pattern: /^\/api\/auth\/refresh\/?$/, params: [], methods: ["POST"], module: route20 },
  { pattern: /^\/api\/owner\/domain-bindings(?:\/(.*))?\/?$/, params: [{"name":"path","catchall":true}], methods: ["GET","POST"], module: route21 },
  { pattern: /^\/api\/owner\/plan-payment-listings\/?$/, params: [], methods: ["GET","POST"], module: route22 },
  { pattern: /^\/api\/owner\/plan-purchase-orders\/?$/, params: [], methods: ["GET"], module: route23 },
  { pattern: /^\/api\/owner\/public-hosts\/?$/, params: [], methods: ["GET","POST"], module: route24 },
  { pattern: /^\/api\/owner\/service-orders\/?$/, params: [], methods: ["GET"], module: route25 },
  { pattern: /^\/api\/owner\/service-product-listings\/?$/, params: [], methods: ["POST"], module: route26 },
  { pattern: /^\/api\/owner\/service-products\/?$/, params: [], methods: ["GET","POST"], module: route27 },
  { pattern: /^\/api\/owner\/web-registration-settings\/?$/, params: [], methods: ["GET","PATCH"], module: route28 },
  { pattern: /^\/api\/owner\/web-registration-team-candidates\/?$/, params: [], methods: ["GET"], module: route29 },
  { pattern: /^\/api\/telemetry\/browser\/?$/, params: [], methods: ["POST"], module: route30 },
  { pattern: /^\/api\/health\/?$/, params: [], methods: ["GET"], module: route31 },
  { pattern: /^\/api\/owner(?:\/(.*))?\/?$/, params: [{"name":"path","catchall":true}], methods: ["GET","POST","PATCH","DELETE"], module: route32 },
] as const satisfies readonly AdminApiRouteDefinition[];

export function adminApiRouteInventory() {
  return {
    families: routes.length,
    methods: routes.reduce((total, route) => total + route.methods.length, 0),
  } as const;
}

export function dispatchAdminApi(request: Request): Promise<Response> {
  return dispatchApiRoutes(request, routes);
}
