import type { AuditEventAppender } from "@frely/audit/application-internal";
import { AuthorityQueries, createAuthorityContext } from "@frely/authority/application-internal";
import { BillingCommerceQueries } from "@frely/billing/application-internal";
import type { AppConfig } from "@frely/config";
import { EntitlementQueries } from "@frely/entitlement/application-internal";
import { createIdentityContext, IdentityCanonicalEmailUpgrade } from "@frely/identity/application-internal";
import { createModelAccessIdentityMigrationQueries } from "@frely/model-access/application-internal";
import type { Prisma, PrismaTransactionOwner } from "@frely/postgres/server";
import { createTenancyContext, TenancyCommands, TenancyQueries } from "@frely/tenancy-context/application-internal";
import {
  GatewayIdentityApplicationService,
  IdentityTenancyApplicationService,
} from "../src/application-internal.js";

type OfflineIdentityTenancyOwner = PrismaTransactionOwner & { prisma: Prisma.TransactionClient };
type IdentityMigrationPeerContextBinder = ConstructorParameters<typeof IdentityCanonicalEmailUpgrade>[1];
type IdentityMigrationPeerContext = ReturnType<IdentityMigrationPeerContextBinder["bind"]>;

/** Offline composition only. This module does not provide an operational entrypoint. */
export function createOfflineIdentityCanonicalEmailUpgrade(
  owner: OfflineIdentityTenancyOwner,
): IdentityCanonicalEmailUpgrade {
  return new IdentityCanonicalEmailUpgrade(owner, new ApplicationIdentityMigrationPeerContextBinder(owner));
}

/** Verification-only composition that preserves the production Query/Command split. */
export function createIdentityTenancyVerificationComposition(
  owner: OfflineIdentityTenancyOwner,
  config: AppConfig,
  auditAppender?: AuditEventAppender,
) {
  const identity = createIdentityVerificationContext(owner, auditAppender);
  const authority = auditAppender === undefined
    ? createAuthorityContext(owner)
    : createAuthorityContext(owner, auditAppender);
  return Object.freeze({
    identity,
    tenancy: createTenancyContext(owner),
    authority,
    application: createIdentityTenancyApplicationVerificationService(owner, config, auditAppender),
    gateway: createGatewayIdentityVerificationService(owner, auditAppender),
  });
}

export function createIdentityVerificationContext(
  owner: OfflineIdentityTenancyOwner,
  auditAppender?: AuditEventAppender,
) {
  return auditAppender === undefined
    ? createIdentityContext(owner)
    : createIdentityContext(owner, auditAppender);
}

export function createIdentityTenancyApplicationVerificationService(
  owner: OfflineIdentityTenancyOwner,
  config: AppConfig,
  auditAppender?: AuditEventAppender,
) {
  return auditAppender === undefined
    ? new IdentityTenancyApplicationService(owner, config)
    : new IdentityTenancyApplicationService(owner, config, auditAppender);
}

export function createGatewayIdentityVerificationService(
  owner: OfflineIdentityTenancyOwner,
  auditAppender?: AuditEventAppender,
) {
  return auditAppender === undefined
    ? new GatewayIdentityApplicationService(owner)
    : new GatewayIdentityApplicationService(owner, auditAppender);
}

class ApplicationIdentityMigrationPeerContextBinder implements IdentityMigrationPeerContextBinder {
  constructor(private readonly owner: OfflineIdentityTenancyOwner) {}

  bind(transaction: Prisma.TransactionClient): IdentityMigrationPeerContext {
    const authority = new AuthorityQueries(this.owner, transaction);
    const tenancy = new TenancyQueries(this.owner, transaction);
    const tenancyCommands = new TenancyCommands(this.owner, transaction);
    const modelAccess = createModelAccessIdentityMigrationQueries(transaction);
    const entitlement = new EntitlementQueries(this.owner, transaction);
    const billingCommerce = new BillingCommerceQueries(this.owner, transaction);
    const applicationFacts = new ApplicationIdentityMigrationQueries(transaction);
    const residualForeignKeys = new ApplicationIdentityMigrationResidualForeignKeyGuard(transaction);

    return {
      classifyUser: async (userId) => {
        const [authorityFacts, tenancyFacts, modelAccessFacts, entitlementFacts, billingFacts, applicationScopeFacts, residualFacts] = await Promise.all([
          authority.classifyIdentityMigrationUser(userId),
          tenancy.classifyIdentityMigrationUser(userId),
          modelAccess.classifyIdentityMigrationUser(userId),
          entitlement.classifyIdentityMigrationUser(userId),
          billingCommerce.classifyIdentityMigrationUser(userId),
          applicationFacts.classifyIdentityMigrationUser(userId),
          residualForeignKeys.classifyIdentityMigrationUser(userId),
        ]);
        const nonOwnerAuthorityGrantCount = Math.max(
          0,
          authorityFacts.grantCount - (authorityFacts.activePlatformOwner ? 1 : 0),
        );
        return Object.freeze({
          activePlatformOwner: authorityFacts.activePlatformOwner,
          ownedTenantCount: tenancyFacts.ownedTenantCount,
          unsafeReferenceCount: nonOwnerAuthorityGrantCount
            + tenancyFacts.unsafeReferenceCount
            + modelAccessFacts.unsafeReferenceCount
            + entitlementFacts.unsafeReferenceCount
            + billingFacts.unsafeReferenceCount
            + applicationScopeFacts.unsafeReferenceCount
            + residualFacts.unsafeReferenceCount,
          transferStateFingerprint: tenancyFacts.transferStateFingerprint,
        });
      },
      transferMemberships: async (sourceUserId, survivorUserId) => {
        await tenancyCommands.transferIdentityMigrationMemberships(sourceUserId, survivorUserId);
      },
    };
  }
}

class ApplicationIdentityMigrationQueries {
  constructor(private readonly transaction: Prisma.TransactionClient) {}

  async classifyIdentityMigrationUser(userId: string): Promise<{ unsafeReferenceCount: number }> {
    const userScopeRef = `user:${userId}`;
    const [ingressSettings, pipelineSettings, budgetPolicies, governanceBudgetPolicies, rateLimitPolicies] = await Promise.all([
      this.transaction.ingress_plugin_settings.count({ where: { scope_ref: userScopeRef } }),
      this.transaction.pipeline_plugin_settings.count({ where: { scope_ref: userScopeRef } }),
      this.transaction.scope_budget_policies.count({ where: { scope_ref: userScopeRef } }),
      this.transaction.scope_governance_budget_policies.count({ where: { scope_ref: userScopeRef } }),
      this.transaction.scope_rate_limit_policies.count({ where: { scope_ref: userScopeRef } }),
    ]);
    return Object.freeze({
      unsafeReferenceCount: ingressSettings + pipelineSettings + budgetPolicies + governanceBudgetPolicies + rateLimitPolicies,
    });
  }
}

class ApplicationIdentityMigrationResidualForeignKeyGuard {
  constructor(private readonly transaction: Prisma.TransactionClient) {}

  async classifyIdentityMigrationUser(userId: string): Promise<{ unsafeReferenceCount: number }> {
    const references = await this.transaction.$queryRaw<Array<{ schemaName: string; tableName: string; columnName: string }>>`
      SELECT namespace.nspname AS "schemaName", relation.relname AS "tableName", attribute.attname AS "columnName"
      FROM pg_constraint constraint_row
      INNER JOIN pg_class relation ON relation.oid = constraint_row.conrelid
      INNER JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      INNER JOIN unnest(constraint_row.conkey) WITH ORDINALITY AS local_key(attnum, position) ON TRUE
      INNER JOIN unnest(constraint_row.confkey) WITH ORDINALITY AS referenced_key(attnum, position)
        ON referenced_key.position = local_key.position
      INNER JOIN pg_attribute attribute
        ON attribute.attrelid = constraint_row.conrelid AND attribute.attnum = local_key.attnum
      INNER JOIN pg_attribute referenced_attribute
        ON referenced_attribute.attrelid = constraint_row.confrelid AND referenced_attribute.attnum = referenced_key.attnum
      WHERE constraint_row.contype = 'f'
        AND constraint_row.confrelid = 'user_controls'::regclass
        AND referenced_attribute.attname = 'id'
        AND namespace.nspname = current_schema()
      ORDER BY relation.relname, attribute.attname`;
    let unsafeReferenceCount = 0;
    for (const reference of references) {
      if (SEPARATELY_CLASSIFIED_USER_FOREIGN_KEYS.has(`${reference.tableName}.${reference.columnName}`)) continue;
      const rows = await this.transaction.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT COUNT(*)::bigint AS count FROM ${quoteIdentifier(reference.schemaName)}.${quoteIdentifier(reference.tableName)} WHERE ${quoteIdentifier(reference.columnName)} = $1`,
        userId,
      );
      unsafeReferenceCount += Number(rows[0]?.count ?? 0n);
    }
    return Object.freeze({ unsafeReferenceCount });
  }
}

const SEPARATELY_CLASSIFIED_USER_FOREIGN_KEYS = new Set([
  "user.id",
  "api_keys.user_id",
  "passkey_credentials.user_id",
  "refresh_tokens.user_id",
  "oidc_authorization_codes.user_id",
  "oidc_access_tokens.user_id",
  "oidc_refresh_tokens.user_id",
  "webauthn_user_handles.user_id",
  "webauthn_ceremonies.user_id",
  "authority_grants.beneficiary_user_id",
  "teams.owner_id",
  "team_memberships.user_id",
]);

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
