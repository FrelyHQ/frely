import { RelayError, requestIdFromHeaders, teamScopeRef } from "@frely/core";
import {
  actorFromClaims,
  auditSuccessAsync,
  normalizeDirectoryPageSize
} from "@frely/ui-application/server";
import { AsyncProviderManagementService } from "@frely/providers";
import { createScopedAccessPointAsync } from "../../../../lib/management-mutations";
import { bodyJson, handle, json, services } from "../../../../lib/server";
import { assertTeamAllowed } from "../../../../lib/domain-binding";

interface Context {
  params: Promise<{ path?: string[] }>;
}

export async function GET(request: Request, context: Context) {
  return handle(request, async ({ hostScope }) => {
    const { asyncTenancy, authorityEntitlement, application} = await services();
    const claims = await asyncTenancy.requireUser(request.headers);
    const audit = { actor: actorFromClaims(claims), source: "web" as const, requestId: requestIdFromHeaders(request.headers) };
    const path = (await context.params).path ?? [];
    const resource = path[0] ?? "";
    const url = new URL(request.url);
    const page = positivePage(url.searchParams.get("page"));
    const pageSize = normalizeDirectoryPageSize(url.searchParams.get("pageSize") ? Number(url.searchParams.get("pageSize")) : undefined);
    const teamId = await asyncTenancy.resolveUserTeamId(claims, url.searchParams.get("teamId"), { allowPlatformOwner: false });
    assertTeamAllowed(hostScope, teamId);
    const requirePermission = async (permission: { resourceType: string; resourceId: string; action: string }) => {
      return asyncTenancy.requirePermission(claims, permission, { allowPlatformOwner: false });
    };
    if (resource === "plan-subscription-candidates") {
      const state = planSubscriptionCandidateState(url.searchParams);
      for (const action of ["team.read", "team.member.read", "team.usage.read", "team.billing.read"]) {
        await requirePermission({ resourceType: "team", resourceId: teamId, action });
      }
      return json(await application.queries.searchActiveTeamSubscriptionCandidates({ teamId, query: state.query, page: state.page, pageSize: 20, calculatedAt: new Date().toISOString() }));
    }
    if (resource === "members") {
      await requirePermission({ resourceType: "team", resourceId: teamId, action: "team.member.read" });
      {
        const result = await application.queries.pageTeamMemberSummaries(teamId, page, pageSize);
        return json({
          ...result,
          items: result.items.map((member) => ({
            id: member.id,
            teamId,
            email: member.email,
            status: member.status,
            apiKeyLimit: member.apiKeyLimit,
            roles: JSON.parse(member.membershipRolesJson) as string[],
            apiKeyCount: member.apiKeyCount,
            lastSeenAt: member.lastSeenAt,
            createdAt: member.createdAt,
          })),
        });
      }
    }
    if (resource === "capabilities") {
      await requirePermission({ resourceType: "team", resourceId: teamId, action: "team.read" });
      return json(await application.queries.pageEffectiveAccessPointsForTeam(teamId, page, pageSize));
    }
    if (resource === "providers") {
      await requirePermission({ resourceType: "team", resourceId: teamId, action: "team.read" });
      if (path[1] && path[2] === "oauth" && path[3] === "status") {
        await requirePermission({ resourceType: "team", resourceId: teamId, action: "team.provider.create" });
        {
          const entitlement = await teamProviderAccessState(authorityEntitlement, application.queries, teamId);
          if (entitlement.state !== "active" && entitlement.state !== "permanent") throw new RelayError("team_provider_entitlement_required", "Team Provider entitlement is required", 403);
        }
        const sessionId = url.searchParams.get("sessionId")?.trim() ?? "";
        if (!sessionId) throw new RelayError("invalid_provider_oauth", "sessionId is required", 400);
        const bindingRevision = positiveBindingRevision(url.searchParams.get("bindingRevision"));
        return json(await new AsyncProviderManagementService(application.queries, application.commands, application.modelAccess.providers, application.modelAccessQueries, application.audit).oauthStatus(path[1], sessionId, bindingRevision, { actor: audit.actor, source: audit.source, requestId: audit.requestId, fixedScopeRef: teamScopeRef(teamId) }));
      }
      const providers = await application.queries.pageTeamProviderDirectory(teamScopeRef(teamId), page, pageSize);
      const models = await application.modelAccessQueries.pageProviderModels(
        positivePage(url.searchParams.get("modelPage")),
        normalizeDirectoryPageSize(url.searchParams.get("modelPageSize") ? Number(url.searchParams.get("modelPageSize")) : undefined),
        { providerIds: providers.items.map((provider) => provider.id) },
      );
      return json({
        ...providers,
        modelPage: models.page,
        modelPageSize: models.pageSize,
        modelTotal: models.total,
        modelTotalPages: models.totalPages,
        items: providers.items.map((provider) => ({
          ...provider,
          models: models.items.filter((model) => model.providerId === provider.id),
        })),
      });
    }
    if (resource === "access-point-prices") {
      await requirePermission({ resourceType: "team", resourceId: teamId, action: "team.ap_price.append" });
      return json(await application.queries.pageScopedAccessPointPrices(teamScopeRef(teamId), page, pageSize));
    }
    if (resource === "credit-transfer-policy") {
      await requirePermission({ resourceType: "team", resourceId: teamId, action: "team.credit.read" });
      return json((await application.billingQueries.getCreditTransferPolicy(teamScopeRef(teamId)) ?? { scopeRef: teamScopeRef(teamId), transferOutEnabled: true }));
    }
    if (resource === "invite-links") {
      const requestedScope = url.searchParams.get("scope") ?? "mine";
      if (requestedScope !== "mine" && requestedScope !== "all") throw new RelayError("invalid_invite_link_scope", "scope must be mine or all", 400);
      {
        await asyncTenancy.assertTeamInviteLinksReadable(teamId, requestedScope, claims.sub);
        const result = await application.queries.pageTeamInviteLinks(teamId, {
          ...(requestedScope === "mine" ? { createdByUserId: claims.sub } : {}),
          page,
          pageSize,
        });
        return json({
          ...result,
          scope: requestedScope,
          items: requestedScope === "all"
            ? result.items
            : result.items.map(({ creatorEmail: _creatorEmail, ...inviteLink }) => inviteLink),
        });
      }
    }
    if (resource === "invite-settings") {
      return json(await asyncTenancy.getTeamInviteSettings(teamId, claims.sub));
    }
    throw new RelayError("not_found", "Team resource not found", 404);
  });
}

export async function POST(request: Request, context: Context) {
  return handle(request, async ({ hostScope }) => {
    const { asyncTenancy, authorityEntitlement, application, config } = await services();
    const claims = await asyncTenancy.requireUser(request.headers);
    const audit = { actor: actorFromClaims(claims), source: "web" as const, requestId: requestIdFromHeaders(request.headers) };
    const path = (await context.params).path ?? [];
    const resource = path[0] ?? "";
    const resourceId = path[1] ?? "";
    const action = path[2] ?? "";
    const body = await bodyJson<Record<string, unknown>>(request);
    if (resource === "deletion" && resourceId) {
      {
        const target = await asyncTenancy.tenancy.getTeam(resourceId);
        if (!target) throw new RelayError("team_not_found", "Team not found", 404);
        if (resourceId === "team_default") throw new RelayError(request.method === "DELETE" ? "default_team_protected" : "default_team_protected", "Default Team deletion lifecycle is protected", 409);
        if (target.ownerId !== claims.sub) throw new RelayError("forbidden", "Team Owner permission is required", 403);
        if (request.method === "DELETE") {
          const lifecycle = await asyncTenancy.requestTeamDeletion(resourceId, audit);
          return json(lifecycle, { status: 202 });
        }
        if (request.method === "POST" && action === "cancel") {
          const lifecycle = await asyncTenancy.cancelTeamDeletion(resourceId, audit);
          return json(lifecycle);
        }
        throw new RelayError("invalid_team_deletion_mutation", "Use DELETE to soft-delete a Team or POST /cancel to restore it", 405);
      }
    }
    const teamId = await asyncTenancy.resolveUserTeamId(claims, body.teamId ? String(body.teamId) : new URL(request.url).searchParams.get("teamId"), { allowPlatformOwner: false });
    assertTeamAllowed(hostScope, teamId);
    const team = await asyncTenancy.tenancy.getTeam(teamId);
    if (!team) throw new RelayError("team_not_found", "Team not found", 404);

    if (resource === "members") {
      {
        await asyncTenancy.requirePermission(claims, { resourceType: "team", resourceId: teamId, action: "team.member.update" }, { allowPlatformOwner: false });
        if (resourceId && action) {
          if (resourceId === claims.sub) throw new RelayError("self_remove_forbidden", "Team owners cannot remove their own membership", 403);
          if (!(await asyncTenancy.tenancy.getMembership(teamId, resourceId))) throw new RelayError("team_member_not_found", "Team member not found", 404);
          if (action === "remove") return json(await asyncTenancy.removeTeamMember(teamId, resourceId, audit));
          if (action === "api-key-limit") {
            if (!team.teamOwnerCanManageMemberApiKeyLimit) throw new RelayError("team_owner_member_key_limit_forbidden", "Team owner cannot manage member API key limits", 403);
            return json(await asyncTenancy.updateUserApiKeyLimit(resourceId, { apiKeyLimit: Number(body.apiKeyLimit) }, audit));
          }
          throw new RelayError("not_found", "Team member action not found", 404);
        }
        return json(await asyncTenancy.createUserWithPassword({ teamId, email: String(body.email), password: body.password }, audit));
      }
    }
    if (resource === "invite-links") {
      if (resourceId && action === "disable") return json(await asyncTenancy.disableTeamInviteLink(teamId, resourceId, audit));
      if (!resourceId) return json(await asyncTenancy.createTeamInviteLink(teamId, audit, body.maxUses));
      throw new RelayError("not_found", "Team invite link action not found", 404);
    }
    if (resource === "invite-settings") {
      if (request.method !== "PATCH") throw new RelayError("invalid_team_invite_setting_mutation", "Invite settings can be updated with PATCH", 405);
      if (body.memberInvitesEnabled !== undefined && typeof body.memberInvitesEnabled !== "boolean") throw new RelayError("invalid_team_invite_setting", "memberInvitesEnabled must be boolean", 400);
      if (body.inviteEmailDomainPattern !== undefined && body.inviteEmailDomainPattern !== null && typeof body.inviteEmailDomainPattern !== "string") throw new RelayError("invalid_team_invite_setting", "inviteEmailDomainPattern must be a string or null", 400);
      return json(await asyncTenancy.updateTeamInviteSettings(teamId, {
        ...(body.memberInvitesEnabled !== undefined ? { memberInvitesEnabled: body.memberInvitesEnabled } : {}),
        ...(body.inviteEmailDomainPattern !== undefined ? { inviteEmailDomainPattern: body.inviteEmailDomainPattern as string | null } : {})
      }, audit));
    }

    {
      await application.queries.assertPartnerManagementActive(teamId);
      if (resource === "access-points") {
        try {
          await asyncTenancy.requirePermission(claims, { resourceType: "team", resourceId: teamId, action: "team.access_point.create" }, { allowPlatformOwner: false });
          if (!team.teamOwnerCanCreateAccessPoint) throw new RelayError("team_owner_access_point_create_forbidden", "Team owner cannot create AccessPoints", 403);
          if ((body.targetType ?? "provider-model") === "provider-model") {
            const provider = await application.modelAccessQueries.getProvider(String(body.targetProviderId ?? ""));
            if (provider?.scopeRef === teamScopeRef(teamId)) {
              const entitlement = await teamProviderAccessState(authorityEntitlement, application.queries, teamId);
              if (entitlement.state !== "active" && entitlement.state !== "permanent") throw new RelayError("team_provider_entitlement_required", "Team Provider entitlement is required", 403);
            }
          }
          return json(await createScopedAccessPointAsync(
            application.modelAccess,
            application.modelAccessQueries,
            application.billing,
            body,
            teamScopeRef(teamId),
            audit,
            request.headers.get("idempotency-key"),
            (command, modelAudit) => authorityEntitlement.createTeamAccessPoint({ teamId, actorUserId: claims.sub, command, audit: modelAudit }),
          ));
        } catch (error) {
          await application.audit.record({
            actor: audit.actor, source: "web", requestId: audit.requestId,
            action: "access_point.create", resourceType: "access_point", resourceId: "pending",
            result: error instanceof RelayError && (error.status === 401 || error.status === 403) ? "denied" : "failure",
            metadata: { scopeRef: teamScopeRef(teamId), errorCode: error instanceof RelayError ? error.code : "internal_error" },
          });
          throw error;
        }
      }
      if (resource === "providers") {
        await asyncTenancy.requirePermission(claims, { resourceType: "team", resourceId: teamId, action: "team.provider.create" }, { allowPlatformOwner: false });
        const entitlement = await teamProviderAccessState(authorityEntitlement, application.queries, teamId);
        const management = new AsyncProviderManagementService(application.queries, application.commands, application.modelAccess.providers, application.modelAccessQueries, application.audit);
        const managementContext = { actor: audit.actor, source: audit.source, requestId: audit.requestId, fixedScopeRef: teamScopeRef(teamId) };
        const requiresEntitlement = !(request.method === "PATCH" && isDisableOnlyProviderPatch(body));
        if (requiresEntitlement && entitlement.state !== "active" && entitlement.state !== "permanent") throw new RelayError("team_provider_entitlement_required", "Team Provider entitlement is required", 403);
        if (resourceId === "reconcile-status" && request.method === "POST") return json(await management.reconcileVisible(providerBindingRefreshItems(body.items), managementContext));
        if (resourceId && action === "credential" && request.method === "POST") {
          if (path[3] === "clear") return json(await management.clearCredential(resourceId, managementContext));
          return json(await management.saveCredential(resourceId, body, managementContext));
        }
        if (resourceId && action === "credential" && request.method === "DELETE") return json(await management.clearCredential(resourceId, managementContext));
        if (resourceId && ((action === "models" && path[3] === "sync") || action === "sync-models") && request.method === "POST") return json(await management.syncModels(resourceId, managementContext));
        if (resourceId && action === "models" && path[3] && path[3] !== "sync" && request.method === "PATCH") {
          return json(await management.changeProviderModel(resourceId, path[3], {
            ...(body.displayName === undefined ? {} : { displayName: String(body.displayName) }),
            ...(body.status === undefined ? {} : { status: providerModelStatus(body.status) }),
          }, managementContext));
        }
        if (resourceId && action === "model-costs" && request.method === "POST") {
          const provider = await application.modelAccessQueries.getProvider(resourceId);
          if (!provider || provider.scopeRef !== teamScopeRef(teamId)) throw new RelayError("provider_scope_forbidden", "Provider is not managed by this Team", 403);
          return json(await application.commands.createProviderModelCost({ providerId: resourceId, providerModelName: String(body.providerModelName ?? ""), inputPer1M: requiredNonNegativeNumber(body.inputPer1M, "inputPer1M"), cachedInputPer1M: requiredNonNegativeNumber(body.cachedInputPer1M, "cachedInputPer1M"), outputPer1M: requiredNonNegativeNumber(body.outputPer1M, "outputPer1M") }));
        }
        if (resourceId && action === "reconcile" && request.method === "POST") return json(await management.reconcile(resourceId, managementContext));
        if (resourceId && action === "oauth" && path[3] === "start" && request.method === "POST") return json(await management.startOAuth(resourceId, managementContext));
        if (resourceId && action === "oauth" && path[3] === "callback" && request.method === "POST") return json(await management.submitOAuthCallback(resourceId, body, managementContext));
        if (request.method !== "POST" && request.method !== "PATCH") throw new RelayError("invalid_provider_mutation", "Providers can be created or updated with POST/PATCH", 405);
        return json(await management.mutate(request.method, { ...body, ...(request.method === "PATCH" ? { id: resourceId || body.id } : {}) }, managementContext));
      }
      if (resource === "provider-model-costs") {
        await asyncTenancy.requirePermission(claims, { resourceType: "team", resourceId: teamId, action: "team.provider.create" }, { allowPlatformOwner: false });
        const entitlement = await teamProviderAccessState(authorityEntitlement, application.queries, teamId);
        if (entitlement.state !== "active" && entitlement.state !== "permanent") throw new RelayError("team_provider_entitlement_required", "Team Provider entitlement is required", 403);
        const providerId = String(body.providerId ?? "").trim();
        const providerModelName = String(body.providerModelName ?? "").trim();
        const provider = await application.modelAccessQueries.getProvider(providerId);
        if (!provider || provider.scopeRef !== teamScopeRef(teamId) || !(await application.modelAccessQueries.getProviderModel(providerId, providerModelName))) throw new RelayError("provider_model_scope_forbidden", "Provider model is not managed by this Team", 403);
        const cost = await application.commands.createProviderModelCost({ providerId, providerModelName, inputPer1M: requiredNonNegativeNumber(body.inputPer1M, "inputPer1M"), cachedInputPer1M: requiredNonNegativeNumber(body.cachedInputPer1M, "cachedInputPer1M"), outputPer1M: requiredNonNegativeNumber(body.outputPer1M, "outputPer1M") });
        await auditSuccessAsync(application.audit, { actor: audit.actor, source: audit.source, requestId: audit.requestId, action: "provider_model_cost.create", resource: { resourceType: "provider_model_cost", resourceId: cost.id }, metadata: { teamId, providerId, providerModelName } });
        return json(cost);
      }
      if (resource === "access-point-prices") {
        await asyncTenancy.requirePermission(claims, { resourceType: "team", resourceId: teamId, action: "team.ap_price.append" }, { allowPlatformOwner: false });
        if (!team.teamOwnerCanCreateAccessPoint) throw new RelayError("team_owner_access_point_price_create_forbidden", "Team owner cannot create AccessPoint prices", 403);
        const accessPoint = await application.queries.getAccessPoint(String(body.accessPointId ?? ""));
        if (!accessPoint || accessPoint.scopeRef !== teamScopeRef(teamId) || accessPoint.ownerId !== claims.sub) throw new RelayError("access_point_price_scope_forbidden", "AccessPoint is not managed by this Team", 403);
        const price = await application.commands.createAccessPointPrice(
          { accessPointId: accessPoint.id, inputPer1M: requiredNonNegativeNumber(body.inputPer1M, "inputPer1M"), cachedInputPer1M: requiredNonNegativeNumber(body.cachedInputPer1M, "cachedInputPer1M"), outputPer1M: requiredNonNegativeNumber(body.outputPer1M, "outputPer1M") },
          { actor: audit.actor, source: audit.source, requestId: audit.requestId },
        );
        return json(price);
      }
      if (resource === "credit-transfer-policy") {
        await asyncTenancy.requirePermission(claims, { resourceType: "team", resourceId: teamId, action: "team.member.update" }, { allowPlatformOwner: false });
        const policy = await application.billingCommands.setCreditTransferPolicy({ scopeRef: teamScopeRef(teamId), transferOutEnabled: body.transferOutEnabled === true, updatedBy: claims.sub });
        await auditSuccessAsync(application.audit, { actor: audit.actor, source: audit.source, requestId: audit.requestId, action: "credit_transfer_policy.update", resource: { resourceType: "credit_transfer_policy", resourceId: policy.id }, metadata: { scopeRef: policy.scopeRef, transferOutEnabled: policy.transferOutEnabled } });
        return json(policy);
      }
      throw new RelayError("not_found", "Team resource not found", 404);
    }
  });
}

export const PATCH = POST;
export const DELETE = POST;

async function teamProviderAccessState(
  authorityEntitlement: { entitlement: { getTeamProviderAccessState(teamId: string): Promise<{ state: string }> } } | undefined,
  postgres: { getTeamProviderEntitlementState(teamId: string): Promise<{ state: string }> },
  teamId: string,
): Promise<{ state: string }> {
  if (authorityEntitlement) return authorityEntitlement.entitlement.getTeamProviderAccessState(teamId);
  if (process.env.NODE_ENV !== "test") throw new Error("authority_entitlement_host_adapter_missing");
  return postgres.getTeamProviderEntitlementState(teamId);
}

function isDisableOnlyProviderPatch(body: Record<string, unknown>): boolean {
  const keys = Object.keys(body).filter((key) => key !== "teamId" && key !== "id");
  return keys.length === 1 && keys[0] === "status" && body.status === "disabled";
}

function providerBindingRefreshItems(value: unknown): Array<{ providerId: string; expectedRevision: number }> {
  if (!Array.isArray(value)) throw new RelayError("provider_reconcile_batch_invalid", "Provider reconcile batch items are required", 400);
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new RelayError("provider_reconcile_batch_invalid", "Provider reconcile batch item is invalid", 400);
    const record = item as Record<string, unknown>;
    return { providerId: String(record.providerId ?? ""), expectedRevision: Number(record.expectedRevision) };
  });
}

function positivePage(value: string | null) {
  if (!value) return 1;
  if (!/^\d+$/.test(value)) throw new RelayError("invalid_pagination", "page must be a positive integer", 400);
  return Math.max(1, Math.min(10_000, Number(value)));
}

function planSubscriptionCandidateState(searchParams: URLSearchParams) {
  const allowed = new Set(["teamId", "q", "page"]);
  if (Array.from(searchParams.keys()).some((key) => !allowed.has(key))) {
    throw new RelayError("invalid_plan_subscription_candidate_query", "Plan source search accepts teamId, q, and page only", 400);
  }
  const query = (searchParams.get("q") ?? "").trim();
  const teamId = searchParams.get("teamId")?.trim();
  const rawPage = searchParams.get("page");
  if (!teamId || query.length > 100 || (rawPage !== null && (!/^[1-9]\d*$/.test(rawPage) || Number(rawPage) > 10_000))) {
    throw new RelayError("invalid_plan_subscription_candidate_query", "Plan source search accepts q up to 100 characters and page from 1 to 10000", 400);
  }
  return { query, page: rawPage ? Number(rawPage) : 1 };
}

function positiveBindingRevision(value: string | null): number {
  if (!value || !/^[1-9]\d*$/u.test(value)) throw new RelayError("invalid_provider_oauth", "bindingRevision must be a positive integer", 400);
  const revision = Number(value);
  if (!Number.isSafeInteger(revision)) throw new RelayError("invalid_provider_oauth", "bindingRevision must be a positive integer", 400);
  return revision;
}

function providerModelStatus(value: unknown): "enabled" | "disabled" {
  const status = String(value ?? "").trim();
  if (status === "enabled" || status === "disabled") return status;
  throw new RelayError("invalid_provider_model_status", "ProviderModel status must be enabled or disabled", 400);
}

function requiredNonNegativeNumber(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new RelayError("invalid_provider_model_cost", `${field} must be a non-negative number`, 400);
  return number;
}
