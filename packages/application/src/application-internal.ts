import type { AuditEventAppender } from "@frely/audit/application-internal";
import { PrismaAuditEventAppender } from "@frely/audit/application-internal";
import type { AppConfig } from "@frely/config";
import { createEntitlementContext } from "@frely/entitlement/application-internal";
import type { EntitlementQueries } from "@frely/entitlement/server";
import type { Prisma, PrismaTransactionOwner } from "@frely/postgres/server";
import { AuthorityEntitlementApplicationService } from "./authority-entitlement.js";
import { BillingCommerceApplicationService } from "./billing-commerce.js";
import {
  GatewayIdentityApplicationService,
  IdentityTenancyApplicationService,
} from "./server.js";

export interface ApplicationContextServices {
  identityTenancy: import("./public-service-contracts.js").IdentityTenancyApplicationService;
  authorityEntitlement: import("./public-service-contracts.js").AuthorityEntitlementApplicationService;
  gatewayIdentity: import("./public-service-contracts.js").GatewayIdentityApplicationService;
  gatewayEntitlementQueries: EntitlementQueries;
}

type PrismaApplicationOwner = PrismaTransactionOwner & { prisma: Prisma.TransactionClient };

export function createApplicationContextServices(
  owner: PrismaApplicationOwner,
  config: AppConfig,
  auditAppender: AuditEventAppender = new PrismaAuditEventAppender(),
): ApplicationContextServices {
  return Object.freeze({
    identityTenancy: new IdentityTenancyApplicationService(owner, config, auditAppender),
    authorityEntitlement: new AuthorityEntitlementApplicationService(owner, auditAppender),
    gatewayIdentity: new GatewayIdentityApplicationService(owner, auditAppender),
    gatewayEntitlementQueries: createEntitlementContext(owner, auditAppender).queries as EntitlementQueries,
  });
}

export function createIdentityTenancyApplicationService(
  owner: PrismaApplicationOwner,
  config: AppConfig,
): import("./public-service-contracts.js").IdentityTenancyApplicationService {
  return new IdentityTenancyApplicationService(owner, config);
}

export {
  AuthorityEntitlementApplicationService,
  BillingCommerceApplicationService,
  GatewayIdentityApplicationService,
  IdentityTenancyApplicationService,
};
export { transferTeamOwnership } from "./server.js";
