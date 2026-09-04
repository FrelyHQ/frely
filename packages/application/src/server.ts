import type { AppConfig } from "@frely/config";
import { bindAuditCommands, createAuditCommands, PrismaAuditEventAppender, type AuditEventAppender } from "@frely/audit/application-internal";
import type { AuthorityQueries } from "@frely/authority/server";
import { bindAuthorityContext, createAuthorityContext } from "@frely/authority/application-internal";
import type { IdentityCommands, IdentityQueries } from "@frely/identity/server";
import { bindIdentityContext, createBetterAuthRuntime, createIdentityContext } from "@frely/identity/application-internal";
import type { Prisma, PrismaTransactionOwner } from "@frely/postgres/server";
import {
  AsyncControlPlaneTenancyService,
  AsyncGatewayTenancyService,
  type AsyncControlPlaneTenancyCommands,
  type AsyncControlPlaneTenancyQueries,
  type AsyncGatewayTenancyQueries,
  type IdentityTenancyBoundContext,
  type IdentityTenancyUnitOfWorkRunner,
} from "./identity-tenancy.js";
import type { TenancyCommands, TenancyQueries, IdentityTenancyAuditInput } from "@frely/tenancy-context/server";
import { bindTenancyContext, createTenancyContext } from "@frely/tenancy-context/application-internal";

export { AuthorityEntitlementApplicationService } from "./authority-entitlement.js";
export { BillingCommerceApplicationService } from "./billing-commerce.js";
export * from "./identity-tenancy.js";
export * from "./session.js";

type PrismaApplicationOwner = PrismaTransactionOwner & { prisma: Prisma.TransactionClient };

interface IdentityTenancyApplicationQueries extends AsyncControlPlaneTenancyQueries, AsyncGatewayTenancyQueries {
  readonly identity: IdentityQueries;
  readonly authority: AuthorityQueries;
  readonly tenancy: TenancyQueries;
}

interface IdentityTenancyApplicationCommands extends AsyncControlPlaneTenancyCommands {
  readonly identityCommands: IdentityCommands;
  readonly tenancyCommands: TenancyCommands;
}

export interface IdentityTenancyCapabilityComposition {
  readonly queries: IdentityTenancyApplicationQueries;
  readonly commands: IdentityTenancyApplicationCommands;
  readonly unitOfWorkRunner: IdentityTenancyUnitOfWorkRunner;
}

/** Internal composition factory retained as the runtime identity proof boundary. */
export function createIdentityTenancyCapabilityComposition(
  owner: PrismaApplicationOwner,
  auditAppender: AuditEventAppender = new PrismaAuditEventAppender(),
): IdentityTenancyCapabilityComposition {
  const queries = new IdentityTenancyQueryAdapters(owner, auditAppender);
  const commands = new IdentityTenancyCommandAdapters(owner, auditAppender);
  const unitOfWorkRunner = new PrismaIdentityTenancyUnitOfWorkRunner(owner, auditAppender);
  if ((queries as object) === (commands as object)
    || (queries as object) === (unitOfWorkRunner as object)
    || (commands as object) === (unitOfWorkRunner as object)) {
    throw new Error("identity_tenancy_capability_identity_reused");
  }
  return Object.freeze({ queries, commands, unitOfWorkRunner });
}

/** [L9] Explicit coordinator for the enumerated Identity/Tenancy transactions. */
export class IdentityTenancyApplicationService extends AsyncControlPlaneTenancyService {
  readonly identity: IdentityQueries;
  readonly identityCommands: IdentityCommands;
  readonly authority: AuthorityQueries;
  readonly tenancy: TenancyQueries;
  readonly tenancyCommands: TenancyCommands;

  constructor(private readonly owner: PrismaApplicationOwner, config: AppConfig, auditAppender: AuditEventAppender = new PrismaAuditEventAppender()) {
    const composition = createIdentityTenancyCapabilityComposition(owner, auditAppender);
    const betterAuthRuntime = isBetterAuthRuntimeConfig(config) ? createBetterAuthRuntime(owner, config) : undefined;
    super(composition.queries, composition.commands, composition.unitOfWorkRunner, config, betterAuthRuntime);
    this.identity = composition.queries.identity;
    this.identityCommands = composition.commands.identityCommands;
    this.authority = composition.queries.authority;
    this.tenancy = composition.queries.tenancy;
    this.tenancyCommands = composition.commands.tenancyCommands;
  }

  async transferTeamOwnership(input: {
    teamId: string;
    nextOwnerUserId: string;
    actorUserId: string;
    requestId?: string | null;
  }): Promise<Awaited<ReturnType<TenancyCommands["transferOwnership"]>>> {
    return transferTeamOwnership({ owner: this.owner, ...input });
  }
}

function isBetterAuthRuntimeConfig(value: unknown): value is AppConfig {
  if (!value || typeof value !== "object") return false;
  const config = value as Partial<AppConfig>;
  return Boolean(
    config.app
    && typeof config.app === "object"
    && typeof config.app.publicBaseUrl === "string"
    && config.auth
    && typeof config.auth === "object"
    && typeof config.auth.jwtSecret === "string",
  );
}

/** Gateway host adapter: Identity authenticates; Tenancy contributes current scopes. */
export class GatewayIdentityApplicationService extends AsyncGatewayTenancyService {
  readonly identity: IdentityQueries;
  readonly authority: AuthorityQueries;
  readonly tenancy: TenancyQueries;

  constructor(owner: PrismaApplicationOwner, auditAppender: AuditEventAppender = new PrismaAuditEventAppender()) {
    const queries = new IdentityTenancyQueryAdapters(owner, auditAppender);
    super(queries);
    this.identity = queries.identity;
    this.authority = queries.authority;
    this.tenancy = queries.tenancy;
  }
}

class IdentityTenancyQueryAdapters implements IdentityTenancyApplicationQueries {
  readonly identity: IdentityQueries;
  readonly authority: AuthorityQueries;
  readonly tenancy: TenancyQueries;

  constructor(owner: PrismaApplicationOwner, auditAppender: AuditEventAppender, transaction?: Prisma.TransactionClient) {
    const identity = transaction ? bindIdentityContext(owner, transaction, auditAppender) : createIdentityContext(owner, auditAppender);
    const authority = transaction ? bindAuthorityContext(owner, transaction, auditAppender) : createAuthorityContext(owner, auditAppender);
    const tenancy = transaction ? bindTenancyContext(owner, transaction) : createTenancyContext(owner);
    this.identity = identity.queries as IdentityQueries;
    this.authority = authority.queries as AuthorityQueries;
    this.tenancy = tenancy.queries as TenancyQueries;
  }
}

class IdentityTenancyCommandAdapters implements IdentityTenancyApplicationCommands {
  readonly identityCommands: IdentityCommands;
  readonly tenancyCommands: TenancyCommands;
  readonly auditCommands: import("@frely/audit").AuditCommands;

  constructor(
    private readonly owner: PrismaApplicationOwner,
    private readonly auditAppender: AuditEventAppender,
    private readonly transaction?: Prisma.TransactionClient,
  ) {
    const identity = transaction ? bindIdentityContext(owner, transaction, auditAppender) : createIdentityContext(owner, auditAppender);
    const tenancy = transaction ? bindTenancyContext(owner, transaction) : createTenancyContext(owner);
    this.identityCommands = identity.commands as IdentityCommands;
    this.tenancyCommands = tenancy.commands as TenancyCommands;
    this.auditCommands = transaction
      ? bindAuditCommands(transaction, auditAppender)
      : createAuditCommands(owner, auditAppender);
  }

  async ensureFallbackTeamMembership(
    userId: string,
    audit: { actor: IdentityTenancyAuditInput["actor"]; source: IdentityTenancyAuditInput["source"]; requestId?: string | null },
  ): Promise<Awaited<ReturnType<TenancyCommands["ensureFallbackMembership"]>>> {
    if (!this.transaction) {
      return this.owner.withPrismaTransaction(
        (transaction) => new IdentityTenancyCommandAdapters(this.owner, this.auditAppender, transaction).ensureFallbackTeamMembership(userId, audit),
        3,
      );
    }
    const queries = new IdentityTenancyQueryAdapters(this.owner, this.auditAppender, this.transaction);
    const bootstrapOwnerUserId = await queries.authority.activeBootstrapPlatformOwnerUserId();
    const result = await this.tenancyCommands.ensureFallbackMembership(userId, bootstrapOwnerUserId);
    if (result.created) {
      await this.auditCommands.record({
        actor: audit.actor,
        action: "team_membership.fallback_join",
        resource: { resourceType: "team_membership", resourceId: result.membership.id },
        result: "success",
        source: audit.source,
        requestId: audit.requestId,
        metadata: { teamId: result.membership.teamId, reason: "no_enabled_team_membership" },
      });
    }
    return result;
  }

}

class PrismaIdentityTenancyUnitOfWorkRunner implements IdentityTenancyUnitOfWorkRunner {
  constructor(private readonly owner: PrismaApplicationOwner, private readonly auditAppender: AuditEventAppender) {}

  run<T>(callback: (contexts: IdentityTenancyBoundContext) => Promise<T>): Promise<T> {
    return this.owner.withPrismaTransaction((transaction) => {
      const queries = new IdentityTenancyQueryAdapters(this.owner, this.auditAppender, transaction);
      const commands = new IdentityTenancyCommandAdapters(this.owner, this.auditAppender, transaction);
      if ((queries as object) === (commands as object)) throw new Error("identity_tenancy_transaction_capability_identity_reused");
      return callback(Object.freeze({
        identity: queries.identity,
        authority: queries.authority,
        tenancy: queries.tenancy,
        commands,
      }));
    }, 3);
  }
}

/** Enumerated Team ownership handover transaction. */
export async function transferTeamOwnership(input: {
  owner: PrismaApplicationOwner;
  teamId: string;
  nextOwnerUserId: string;
  actorUserId: string;
  requestId?: string | null;
}): Promise<Awaited<ReturnType<TenancyCommands["transferOwnership"]>>> {
  const auditAppender = new PrismaAuditEventAppender();
  return input.owner.withPrismaTransaction(async (transaction) => {
    const identity = bindIdentityContext(input.owner, transaction, auditAppender).queries;
    const tenancy = bindTenancyContext(input.owner, transaction).commands;
    const audit = bindAuditCommands(transaction, auditAppender);
    const userDecision = await identity.decideUserAccess(input.nextOwnerUserId);
    return tenancy.transferOwnership({
      teamId: input.teamId,
      nextOwnerUserId: input.nextOwnerUserId,
      nextOwnerEnabled: userDecision?.enabled === true,
      actorUserId: input.actorUserId,
      appendAudit: async (teamId, previousOwnerUserId, nextOwnerUserId) => {
        await audit.record({
          actor: { actorType: "user", actorId: input.actorUserId },
          action: "team.owner.transfer",
          resourceType: "team",
          resourceId: teamId,
          result: "success",
          source: "owner",
          requestId: input.requestId ?? null,
          metadata: { previousOwnerUserId, nextOwnerUserId },
        });
      },
    });
  }, 3, { isolationLevel: "Serializable" });
}
