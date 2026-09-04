import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import type { AuditCommands, AuditMetadataValue, SensitiveReadAuditEventDraft } from "@frely/audit";
import { sha256 } from "@frely/auth";
import { ACCESS_POINT_SELECTOR_CATALOG, isRuntimeScopeRef, isSafeExternalEvidenceRef, matchesImageContentType, readBoundedRequestFormData, RelayError, requestIdFromHeaders, type AccessPointTargetType, type ScopeRef } from "@frely/core";
import type { AuthorityProductSnapshot, AuthorityProductTerms } from "@frely/billing/server";
import type { PlanDefinitionSnapshot, PlanSubscriptionSnapshot } from "@frely/entitlement";
import { normalizeAccessPointDescription, type ModelAccessCommandService, type ModelAccessManagementQueryService } from "@frely/model-access/server";
import { actorFromClaims, auditDeniedAsync, auditFailureAsync, auditSuccessAsync, assertSafeProviderConfigInput, cardActivationBatchView, cardActivationCodeSafeView, CreditCursorError, normalizeAuthorityHostname, normalizeDirectoryPageSize, normalizePlanBudgetLimits, parseRequestCaptureView, prepareRequestCaptureDownload, queryRequestLogsAcrossStorageAsync, requestCaptureFileStream, requestCaptureTarStream, requestCaptureViewResponse, sanitizeProvider, type UiQueryPort, type AuditActor, type BillingCommands, type InvocationUsageUnits, type PlanAccessPointPriceOverrideInput, type PlanBudgetLimitInput, type UiCommandPort, type PriceTierInput, type RequestCaptureDownloadSlot, type RequestCaptureStreamHooks, type RequestLog, type RequestLogListFilter } from "@frely/ui-application/server";
import { InternalGatewayClient } from "@frely/gateway-core";
import * as GatewayCore from "@frely/gateway-core";
import { AsyncProviderManagementService } from "@frely/providers";
import { createAsyncAbuseGuard, testInviteEmailDomainPattern } from "@frely/tenancy";
import { buildAdminDashboardAggregateAsync } from "../../../../lib/dashboard";
import { assertProductionHttps, bodyJson, handle, json, services } from "../../../../lib/server";
import { buildAdminTeamsAggregateAsync, parseAdminTeamsSearch } from "../../../../lib/teams";
import { GLOBAL_PLUGIN_SCOPE, ingressPluginById, ingressPluginRegistry, ingressPluginSettingsRepo, storedPluginConfig } from "../../../../features/system-settings/lib/ingress-plugin-settings";
import { GLOBAL_PIPELINE_PLUGIN_SCOPE, pipelinePluginById, pipelinePluginRegistry, validatePipelinePluginConfig } from "../../../../features/system-settings/lib/pipeline-plugin-settings";
import { apiTestPayloadValidationError, apiTestProtocol, apiTestTypeFromRequest, type ApiTestType } from "../../../../features/api-test/lib/api-test-protocols";
import { curlCommand } from "../../../../features/api-test/lib/curl-command";
import { parseSubscriptionSearch, readSubscriptionDetail, readSubscriptionOverview, subscriptionFilter, SUBSCRIPTIONS_PAGE_SIZE, type SubscriptionSearchState } from "../../../../features/plans/subscriptions/query";
import { parseAuditLogUrlState } from "../../../../features/logs";

interface Context {
  params: Promise<{ path?: string[] }>;
}

type ModelCandidate = {
  providerModelName: string;
  displayName?: string;
};

type ExternalPriceLookupService = {
  lookupOpenAiReferencePrices(): Promise<unknown>;
  lookupExternal(providerId: string, providerModelName: string): Promise<unknown>;
};

type AsyncApiTestQueries = Pick<UiQueryPort, "getAccessPoint">;
type AsyncApiTestCommands = Pick<AuditCommands, "record">;
type ApiTestIdentityQueries = Pick<import("@frely/identity/server").IdentityQueries, "getApiKey" | "findApiKeyByHash" | "getUser">;
type ApiTestTenancyQueries = Pick<import("@frely/tenancy/server").TenancyQueries, "listEffectiveSubscriptionScopesForUser">;

export async function GET(request: Request, context: Context) {
  return handle(request, async () => {
    const { asyncTenancy, authorityEntitlement, application, requestCaptureClient, requestCaptureReader, requestLogArchiveReader, asyncExternalPricing, config } = await services();
    ensureBillingCommerceRuntime(application);
    const path = (await context.params).path ?? [];
    const claims = await asyncTenancy.requireOwner(request.headers);
    const actor = actorFromClaims(claims);
    const requestId = requestIdFromHeaders(request.headers);
    const auditSuccessForBackend = async (input: Parameters<typeof auditSuccessAsync>[1]) => {
      await auditSuccessAsync(application.audit, input);
    };
    const auditFailureForBackend = async (input: Parameters<typeof auditFailureAsync>[1]) => {
      await auditFailureAsync(application.audit, input);
    };
    const auditDeniedForBackend = async (input: Parameters<typeof auditDeniedAsync>[1]) => {
      await auditDeniedAsync(application.audit, input);
    };
    const appendSensitiveReadAudit = (event: SensitiveReadAuditEventDraft) => application.audit.record(event);
    const resource = path[0] ?? "";
    const billingQueries = application.billingQueries;
    const billingCommands = application.billingCommands;
    if (resource === "card-activation-stats") {
      const url = new URL(request.url);
      return json(await billingQueries.getCardActivationStats({
        ...(url.searchParams.get("batchId") ? { batchId: url.searchParams.get("batchId")! } : {}),
        ...(url.searchParams.get("cardType") === "plan" || url.searchParams.get("cardType") === "credit" ? { cardType: url.searchParams.get("cardType") as "plan" | "credit" } : {}),
      }));
    }
    if (resource === "card-activation-batches") {
      const url = new URL(request.url);
      if (path[1] && path[2] === "export") {
        const exported = await billingCommands.exportCardActivationBatch(path[1], actor.actorId, requestId);
        const plan = exported.batch.planId ? await authorityEntitlement.entitlement.getPlan(exported.batch.planId) : undefined;
        const product = exported.batch.creditProductId ? await billingQueries.getCreditProduct(exported.batch.creditProductId) : undefined;
        const productLabel = exported.batch.cardType === "plan"
          ? `${plan?.name ?? "Plan"} v${plan?.version ?? "?"}`
          : `${product?.displayName ?? "Credit"} (${exported.batch.creditAmountUnits ?? 0})`;
        const publicBase = new URL("/activate/card", config.app.publicBaseUrl).toString();
        const lines = ["batch_reference,ordinal,code,activation_url,card_type,product_label,redeem_expires_at"];
        for (const item of exported.codes) {
          const activationUrl = `${publicBase}?code=${encodeURIComponent(item.code)}`;
          lines.push([
            exported.batch.referenceCode, item.ordinal, item.code, activationUrl, exported.batch.cardType, productLabel, exported.batch.redeemExpiresAt,
          ].map(csvField).join(","));
        }
        return new Response(`${lines.join("\r\n")}\r\n`, {
          headers: {
            "cache-control": "no-store",
            "content-disposition": `attachment; filename="${exported.batch.referenceCode}.csv"`,
            "content-type": "text/csv; charset=utf-8",
            "referrer-policy": "no-referrer",
          },
        });
      }
      if (path[1]) {
        const detail = await billingQueries.getCardActivationBatchDetail(path[1], ownerQueryPage(url), ownerQueryPageSize(url));
        if (!detail) throw new RelayError("card_activation_batch_not_found", "Card Activation batch not found", 404);
        return json({ ...detail, batch: cardActivationBatchView(detail.batch), codes: detail.codes.map(cardActivationCodeSafeView) });
      }
      const result = await billingQueries.listCardActivationBatches({
        page: ownerQueryPage(url), pageSize: ownerQueryPageSize(url),
        ...(url.searchParams.get("cardType") === "plan" || url.searchParams.get("cardType") === "credit" ? { cardType: url.searchParams.get("cardType") as "plan" | "credit" } : {}),
        ...(new Set(["available", "redeemed", "revoked", "expired"]).has(url.searchParams.get("status") ?? "") ? { status: url.searchParams.get("status") as "available" | "redeemed" | "revoked" | "expired" } : {}),
      });
      return json({ ...result, items: result.items.map((item) => ({ ...cardActivationBatchView(item), stats: item.stats })) });
    }
    if (resource === "authority-products") {
      const page = positiveQueryInteger(new URL(request.url).searchParams.get("page"), 1, 10_000);
      const result = await authorityEntitlement.commerce.pageAuthorityProducts(page);
      return json({ ...result, items: result.items.map(ownerAuthorityProduct) });
    }
    if (resource === "authority-product-candidates") {
      const url = new URL(request.url);
      return json(await authorityEntitlement.commerce.searchTeamProviderProductCandidates(url.searchParams.get("q") ?? "", positiveQueryInteger(url.searchParams.get("page"), 1, 10_000)));
    }
    if (resource === "me") return json({ userId: claims.sub, email: claims.email, platformRoles: claims.platformRoles, teamRoles: claims.teamRoles });
    if (resource === "teams" && path[1] && path[2] === "permissions") {
      const url = new URL(request.url);
      return json(await application.queries.pageResourcePermissions("team", path[1], positiveQueryInteger(url.searchParams.get("page"), 1, 10_000)));
    }
    if (resource === "teams" && path[1] && path[2] === "invite-links") {
      {
        if (!(await asyncTenancy.tenancy.getTeam(path[1]))) throw new RelayError("team_not_found", "Team not found", 404);
        const url = new URL(request.url);
        const result = await application.queries.pageTeamInviteLinks(path[1], {
          page: positiveQueryInteger(url.searchParams.get("page"), 1, 10_000),
          pageSize: ownerQueryPageSize(url),
        });
        return json({ ...result, scope: "all" });
      }
    }
    if (resource === "teams" && path[1] && path[2] === "invite-settings") {
      return json(await asyncTenancy.getTeamInviteSettings(path[1], claims.sub, { allowPlatformOwner: true }));
    }
    if (resource === "teams" && path[1] && path[2] === "provider-entitlements") {
      if (!(await asyncTenancy.tenancy.getTeam(path[1]))) throw new RelayError("team_not_found", "Team not found", 404);
      const url = new URL(request.url);
      const cursor = url.searchParams.get("cursor") || undefined;
      return json({
        state: await authorityEntitlement.entitlement.getTeamProviderAccessState(path[1]),
        history: await authorityEntitlement.entitlement.cursorTeamProviderEntitlements(path[1], cursor, ownerQueryPageSize(url))
      });
    }
    if (resource === "teams" && path[1]) return json(await asyncTenancy.tenancy.getTeam(path[1]));
    if (resource === "teams") {
      const url = new URL(request.url);
      const search = parseAdminTeamsSearch(Object.fromEntries(url.searchParams), true);
      const result = await buildAdminTeamsAggregateAsync(application.queries, search);
      return json({ items: result.rows, metrics: result.metrics, page: result.page, pageSize: result.pageSize, total: result.total, totalPages: result.totalPages });
    }
    if (resource === "user-candidates") {
      const url = new URL(request.url);
      return json(await application.queries.searchUserCandidates(url.searchParams.get("q") ?? "", positiveQueryInteger(url.searchParams.get("page"), 1, 10_000)));
    }
    if (resource === "team-member-candidates" && path[1]) {
      const url = new URL(request.url);
      return json(await application.queries.searchNonMemberUserCandidates(path[1], url.searchParams.get("q") ?? "", positiveQueryInteger(url.searchParams.get("page"), 1, 10_000)));
    }
    if (resource === "credit-product-candidates") {
      const url = new URL(request.url);
      const query = url.searchParams.get("q") ?? "";
      const page = positiveQueryInteger(url.searchParams.get("page"), 1, 10_000);
      return json(await application.queries.searchCreditProductCandidates(query, page));
    }
    if (resource === "admin-card-candidates") {
      const url = new URL(request.url);
      const kind = url.searchParams.get("kind");
      const query = url.searchParams.get("q") ?? "";
      const page = positiveQueryInteger(url.searchParams.get("page"), 1, 10_000);
      if (kind === "plans") {
        const userId = url.searchParams.get("userId") ?? "";
        if (!(await asyncTenancy.identity.getUser(userId))) throw new RelayError("user_not_found", "User not found", 404);
        return json(await application.queries.searchAdminCardCandidates(userId, query, page));
      }
      if (kind === "credit-products") return json(await application.queries.searchCreditProductCandidates(query, page));
      throw new RelayError("invalid_admin_card_candidate_kind", "kind must be plans or credit-products", 400);
    }
    if (resource === "payment-channel-candidates") {
      const url = new URL(request.url);
      const query = url.searchParams.get("q") ?? "";
      const page = positiveQueryInteger(url.searchParams.get("page"), 1, 10_000);
      return json(await application.queries.searchPaymentChannelCandidates(query, page));
    }
    if (resource === "team-candidates") {
      const url = new URL(request.url);
      return json(await application.queries.searchTeamCandidates(url.searchParams.get("q") ?? "", positiveQueryInteger(url.searchParams.get("page"), 1, 10_000)));
    }
    if (resource === "provider-candidates") {
      const url = new URL(request.url);
      const query = url.searchParams.get("q") ?? "";
      const page = positiveQueryInteger(url.searchParams.get("page"), 1, 10_000);
      return json(await application.queries.searchProviderCandidates(query, page));
    }
    if (resource === "api-key-candidates") {
      const url = new URL(request.url);
      return json(await application.queries.searchApiKeyCandidates(url.searchParams.get("q") ?? "", positiveQueryInteger(url.searchParams.get("page"), 1, 10_000)));
    }
    if (resource === "budget-policy-candidates") {
      const url = new URL(request.url);
      return json(await application.queries.searchBudgetPolicyCandidates(url.searchParams.get("q") ?? "", positiveQueryInteger(url.searchParams.get("page"), 1, 10_000)));
    }
    if (resource === "governance-budget-policy-candidates") {
      const url = new URL(request.url);
      return json(await application.queries.searchGovernanceBudgetPolicyCandidates(url.searchParams.get("q") ?? "", positiveQueryInteger(url.searchParams.get("page"), 1, 10_000)));
    }
    if (resource === "access-point-candidates") {
      const url = new URL(request.url);
      const query = url.searchParams.get("q") ?? "";
      const page = positiveQueryInteger(url.searchParams.get("page"), 1, 10_000);
      return json(await application.queries.searchAccessPointCandidates(query, page));
    }
    if (resource === "plan-access-point-candidates") {
      const url = new URL(request.url);
      return json(await application.queries.searchPlanAccessPointCandidates(url.searchParams.get("q") ?? "", positiveQueryInteger(url.searchParams.get("page"), 1, 10_000)));
    }
    if (resource === "plan-replacement-candidates") {
      const url = new URL(request.url);
      const sourcePlanId = url.searchParams.get("sourcePlanId") ?? "";
      const query = url.searchParams.get("q") ?? "";
      const page = positiveQueryInteger(url.searchParams.get("page"), 1, 10_000);
      return json(await application.queries.searchPlanReplacementCandidates(sourcePlanId, query, page));
    }
    if (resource === "access-points" && path[1] && path[2] === "impact") return json(await application.queries.accessPointPlanImpact(path[1]));
    if (resource === "users") {
      const url = new URL(request.url);
      return json(await application.queries.pageOwnerUserDirectory({
          query: url.searchParams.get("q") ?? "",
          page: positiveQueryInteger(url.searchParams.get("page"), 1, 10_000),
          pageSize: ownerQueryPageSize(url)
        }));
    }
    if (resource === "grant-batches") {
      const url = new URL(request.url);
      const page = ownerQueryPage(url);
      const pageSize = ownerQueryPageSize(url);
      if (path[1]) {
        const detail = await application.queries.getAdminGrantBatchDetail(path[1], pageSize, (page - 1) * pageSize);
        if (!detail) throw new RelayError("admin_grant_batch_not_found", "Grant batch not found", 404);
        return json({ ...detail, page, pageSize, totalPages: Math.max(1, Math.ceil(detail.total / pageSize)) });
      }
      const total = await application.queries.countAdminGrantBatches();
      return json({ items: await application.queries.listAdminGrantBatches(pageSize, (page - 1) * pageSize), page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
    }
    if (resource === "api-keys" && path[1] && path[2] === "plan-source-restriction" && path.length === 3) {
      const apiKey = await asyncTenancy.identity.getApiKey(path[1]);
      if (!apiKey) throw new RelayError("api_key_not_found", "API key not found", 404);
      return json(await authorityEntitlement.entitlement.decideApiKeyPlanSourceRestriction(path[1]));
    }
    if (resource === "api-keys" && path[1] && path[2] === "plan-source-restriction" && path[3] === "candidates" && path.length === 4) {
      const url = new URL(request.url);
      return json(await authorityEntitlement.entitlement.pageApiKeyPlanSourceRestrictionCandidates(path[1], {
        query: url.searchParams.get("q") ?? "",
        page: positiveQueryInteger(url.searchParams.get("page"), 1, 10_000),
        pageSize: ownerQueryPageSize(url),
      }));
    }
    if (resource === "api-keys") {
      const url = new URL(request.url);
      return json(await application.queries.pageOwnerApiKeyDirectory({ query: url.searchParams.get("q") ?? "", page: positiveQueryInteger(url.searchParams.get("page"), 1, 10_000), pageSize: ownerQueryPageSize(url) }));
    }
    if (resource === "card-transfers") {
      const url = new URL(request.url);
      const referenceCode = url.searchParams.get("referenceCode")?.trim() || undefined;
      const page = await billingQueries.pageCardTransfers(referenceCode, ownerQueryPage(url), ownerQueryPageSize(url));
      const auditInput = { actor, source: "owner" as const, requestId, action: "card_transfer.read", resource: { resourceType: "card_transfer", resourceId: "list" }, metadata: { referenceCode: referenceCode ?? null, count: page.items.length } } as const;
      await auditSuccessAsync(application.audit, auditInput);
      return json(page);
    }
    if (resource === "dashboard") return json(await buildAdminDashboardAggregateAsync(application.queries, asyncTenancy.tenancy));
    if (resource === "providers" && path[2] === "oauth" && path[3] === "status") {
      const searchParams = new URL(request.url).searchParams;
      const sessionId = searchParams.get("sessionId") ?? "";
      const bindingRevision = positiveBindingRevision(searchParams.get("bindingRevision"));
      return json(await new AsyncProviderManagementService(application.queries, application.commands, application.modelAccess.providers, application.modelAccessQueries, application.audit).oauthStatus(String(path[1] ?? ""), sessionId, bindingRevision, { actor, source: "owner", requestId, privateProviderOrigin: process.env.FRIDAY_RELAY_PRIVATE_PROVIDER_ORIGIN }));
    }
    if (resource === "providers" && path[2] === "model-candidates") return json(await providerModelCandidatesAsync(application.modelAccessQueries, String(path[1] ?? "")));
    if (resource === "providers") {
      const url = new URL(request.url);
      const providers = await Promise.resolve(application.queries.pageProviderDirectory({
          page: ownerQueryPage(url),
          pageSize: ownerQueryPageSize(url),
          showRetained: true,
        })).catch(async (error: unknown) => {
          await appendSensitiveReadAudit({ actor, source: "owner", requestId, action: "provider_credential.read_summary", resourceType: "provider", resourceId: "list", result: "failure", metadata: { routePattern: "/api/owner/providers", errorCode: error instanceof RelayError ? error.code : "internal_error" } });
          throw error;
        });
      await appendSensitiveReadAudit({ actor, source: "owner", requestId, action: "provider_credential.read_summary", resourceType: "provider", resourceId: "list", result: "success", metadata: { count: providers.items.length, routePattern: "/api/owner/providers" } });
      return json({ ...providers, items: providers.items.map((provider) => ({ ...sanitizeProvider(provider), binding: provider.binding })) });
    }
    if (resource === "provider-models") {
      const url = new URL(request.url);
      return json(await application.modelAccessQueries.pageProviderModels(ownerQueryPage(url), ownerQueryPageSize(url)));
    }
    if (resource === "access-point-selectors") return json({ items: ACCESS_POINT_SELECTOR_CATALOG });
    if (resource === "access-points") {
      const url = new URL(request.url);
      const page = await application.queries.pageAccessPointDirectory({ page: ownerQueryPage(url), pageSize: ownerQueryPageSize(url) });
      return json({
        ...page,
        items: await Promise.all(page.items.map(async (item) => await application.modelAccessQueries.getAccessPointWithRouting(item.id) ?? item)),
      });
    }
    if (resource === "access-point-visibility-grants") throw new RelayError("access_point_visibility_grants_removed", "AccessPoint visibility grants were removed; use access_points.scopeRef", 410);
    if (resource === "provider-model-costs") {
      const url = new URL(request.url);
      return json(await application.queries.pageProviderModelCosts(ownerQueryPage(url), ownerQueryPageSize(url)));
    }
    if (resource === "access-point-prices") {
      const url = new URL(request.url);
      return json(await application.queries.pageAccessPointPrices(ownerQueryPage(url), ownerQueryPageSize(url)));
    }
    if (resource === "plan-access-point-prices") {
      const url = new URL(request.url);
      return json(await application.queries.pagePlanAccessPointPrices(ownerQueryPage(url), ownerQueryPageSize(url)));
    }
    if (resource === "credit-accounts") {
      const url = new URL(request.url);
      return json(await billingQueries.pageCreditAccounts(ownerQueryPage(url), ownerQueryPageSize(url)));
    }
    if (resource === "credit-products") {
      const url = new URL(request.url);
      return json(await billingQueries.pageCreditProducts(ownerQueryPage(url), ownerQueryPageSize(url)));
    }
    if (resource === "payment-channels") {
      if (path[1] && path[2] === "instruction-attachments" && path[3]) {
        const attachment = await billingQueries.getPaymentChannelInstructionAttachment(path[3]);
        if (!attachment || attachment.paymentChannelId !== path[1]) throw new RelayError("payment_channel_instruction_attachment_not_found", "Payment instruction attachment not found", 404);
        const bytes = await readFile(privateStoragePath(paymentChannelUploadDir(attachmentStorageRoot(config)), attachment.storageKey));
        await auditSuccessForBackend({ actor, source: "owner", requestId, action: "payment_channel_instruction_attachment.read", resource: { resourceType: "payment_channel_instruction_attachment", resourceId: attachment.id }, metadata: { paymentChannelId: path[1], attachmentCount: 1, attachmentContentType: attachment.contentType, attachmentByteSize: attachment.byteSize, attachmentSha256: attachment.sha256 } });
        return new Response(bytes, { headers: { "content-type": attachment.contentType, "content-length": String(attachment.byteSize), "content-disposition": `inline; filename="${attachment.id}${attachmentExtension(attachment.contentType)}"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
      }
      const url = new URL(request.url);
      return json(await billingQueries.pagePaymentChannels(ownerQueryPage(url), ownerQueryPageSize(url)));
    }
    if (resource === "credit-product-listings") {
      const url = new URL(request.url);
      return json(await billingQueries.pageCreditProductListings(ownerQueryPage(url), ownerQueryPageSize(url)));
    }
    if (resource === "credit-topups") {
      if (path[1] && path[2] === "attachments" && path[3]) {
        const topup = await billingQueries.getCreditTopup(path[1]);
        if (!topup) throw new RelayError("credit_topup_not_found", "Credit topup not found", 404);
        const attachment = await billingQueries.getTopupAttachment(topup.id, path[3]);
        if (!attachment) throw new RelayError("credit_topup_attachment_not_found", "Credit topup attachment not found", 404);
        const bytes = await readFile(privateStoragePath(creditTopupUploadDir(attachmentStorageRoot(config)), attachment.storageKey));
        await auditSuccessForBackend({ actor, source: "owner", requestId, action: "credit_topup_attachment.read", resource: { resourceType: "credit_topup_attachment", resourceId: attachment.id }, metadata: { topupId: topup.id, attachmentCount: 1, attachmentContentType: attachment.contentType, attachmentByteSize: attachment.byteSize, attachmentSha256: attachment.sha256 } });
        return new Response(bytes, {
          headers: {
            "content-type": attachment.contentType,
            "content-length": String(attachment.byteSize),
            "content-disposition": `inline; filename="${attachment.id}${attachmentExtension(attachment.contentType)}"`,
            "cache-control": "private, no-store",
            "x-content-type-options": "nosniff"
          }
        });
      }
      if (path[1]) {
        const topup = await billingQueries.getCreditTopup(path[1]);
        if (!topup) throw new RelayError("credit_topup_not_found", "Credit topup not found", 404);
        const url = new URL(request.url);
        const attachments = await billingQueries.pageTopupAttachments(topup.id, {
            page: ownerQueryPage(url),
            pageSize: ownerQueryPageSize(url),
          });
        return json({ ...topup, attachments: attachments.items, attachmentPage: pageMetadata(attachments) });
      }
      const url = new URL(request.url);
      try {
        return json(await billingQueries.cursorAdminTopups(url.searchParams.get("cursor") || undefined, undefined, url.searchParams.get("status") || undefined, ownerQueryPageSize(url)));
      } catch (error) {
        if (error instanceof CreditCursorError) throw new RelayError("invalid_credit_cursor", "Invalid Credit Topup cursor", 400);
        throw error;
      }
    }
    if (resource === "credit-transfer-policies") {
      const url = new URL(request.url);
      return json(await billingQueries.pageCreditTransferPolicies(ownerQueryPage(url), ownerQueryPageSize(url)));
    }
    if (resource === "budgets") {
      const url = new URL(request.url);
      return json(await application.queries.pageBudgetPolicies({ page: ownerQueryPage(url), pageSize: ownerQueryPageSize(url) }));
    }
    if (resource === "scope-budget-policies") {
      const url = new URL(request.url);
      return json(await application.queries.pageScopeBudgetPolicyAssignments({ page: ownerQueryPage(url), pageSize: ownerQueryPageSize(url) }));
    }
    if (resource === "governance-budgets") {
      const url = new URL(request.url);
      return json(await application.queries.pageGovernanceBudgetPolicies({ page: ownerQueryPage(url), pageSize: ownerQueryPageSize(url) }));
    }
    if (resource === "scope-governance-budget-policies") {
      const url = new URL(request.url);
      return json(await application.queries.pageScopeGovernanceBudgetPolicyAssignments({ page: ownerQueryPage(url), pageSize: ownerQueryPageSize(url) }));
    }
    if (resource === "plan-templates") {
      const url = new URL(request.url);
      if (path[1] && path[2] === "detail") {
        const plan = await application.queries.getPlan(path[1]);
        if (!plan) throw new RelayError("plan_template_not_found", `Plan template ${path[1]} not found`, 404);
        const budgetLimits = await application.queries.pageBudgetLimits(
            plan.id,
            positiveQueryInteger(url.searchParams.get("budgetPage"), 1, 10_000),
            ownerQueryPageSize(url, "budgetPageSize"),
          );
        const accessPoints = await application.queries.pagePlanAccessPoints(
            plan.id,
            positiveQueryInteger(url.searchParams.get("accessPage"), 1, 10_000),
            ownerQueryPageSize(url, "accessPageSize"),
          );
        return json({
          template: {
            ...plan,
            status: plan.planStatus,
            statusImpact: await application.queries.getPlanStatusImpact(plan.id),
          },
          budgetLimits,
          accessPoints,
        });
      }
      const directory = await application.queries.pagePlanDirectory({
          query: url.searchParams.get("q") ?? "",
          status: planDirectoryStatus(url.searchParams.get("status")),
          page: positiveQueryInteger(url.searchParams.get("page"), 1, 10_000),
          pageSize: ownerQueryPageSize(url),
        });
      return json({
        ...directory,
        items: directory.items.map((plan) => ({ ...plan, status: plan.planStatus })),
      });
    }
    if (resource === "subscription-candidates") {
      const url = new URL(request.url);
      const kind = url.searchParams.get("kind") ?? "";
      const search = (url.searchParams.get("search") ?? "").slice(0, 160);
      const page = positiveQueryInteger(url.searchParams.get("page"), 1, 10_000);
      const offset = (page - 1) * SUBSCRIPTIONS_PAGE_SIZE;
      const result = kind === "plans" ? (await application.queries.listPlanSubscriptionPlanCandidates(search, SUBSCRIPTIONS_PAGE_SIZE, offset))
        : kind === "scopes" ? (await application.queries.listPlanSubscriptionScopeCandidates(search, SUBSCRIPTIONS_PAGE_SIZE, offset))
          : kind === "accounts" ? (await application.queries.listPlanSubscriptionAccountCandidates(search, SUBSCRIPTIONS_PAGE_SIZE, offset))
            : kind === "users" ? (await application.queries.listPlanSubscriptionUserCandidates(url.searchParams.get("subscriptionId")?.trim() || "", search, SUBSCRIPTIONS_PAGE_SIZE, offset))
              : kind === "grant-users" ? (await application.queries.listAdminGrantUserCandidates(search, SUBSCRIPTIONS_PAGE_SIZE, offset))
                : kind === "grant-credit-products" ? (await application.queries.listAdminGrantCreditProductCandidates(search, SUBSCRIPTIONS_PAGE_SIZE, offset))
                  : (() => { throw new RelayError("invalid_subscription_candidate_kind", "kind must be plans, scopes, accounts, users, grant-users, or grant-credit-products", 400); })();
      return json({ ...result, page, pageSize: SUBSCRIPTIONS_PAGE_SIZE, totalPages: Math.max(1, Math.ceil(result.total / SUBSCRIPTIONS_PAGE_SIZE)) });
    }
    if (resource === "subscriptions") {
      const url = new URL(request.url);
      const at = new Date().toISOString();
      const subscriptionId = url.searchParams.get("subscriptionId")?.trim() || "";
      const targetUserId = url.searchParams.get("targetUserId")?.trim() || "";
      const metadata = { routePattern: "/api/owner/subscriptions", ...(subscriptionId ? { subscriptionId } : {}), ...(targetUserId ? { targetUserId } : {}) };
      try {
        if (subscriptionId) {
          const result = await readSubscriptionDetailAsync(application.queries, asyncTenancy.identity, subscriptionId, targetUserId, at);
          await appendSensitiveReadAudit({ actor, source: "owner", requestId, action: "plan_budget_usage.read", resourceType: "plan_subscription", resourceId: subscriptionId, result: "success", metadata });
          return json({ items: [result.usage], subscription: result.subscription, calculatedAt: at, page: 1, pageSize: ownerQueryPageSize(url), total: 1, totalPages: 1, nextCursor: null });
        }
        const state = parseSubscriptionSearch({
          subscriptionId: url.searchParams.get("subscriptionId") ?? undefined,
          planId: url.searchParams.get("planId") ?? undefined,
          scopeRef: url.searchParams.get("scopeRef") ?? undefined,
          scopeType: url.searchParams.get("scopeType") ?? undefined,
          status: url.searchParams.get("status") ?? url.searchParams.get("lifecycle") ?? undefined,
          source: url.searchParams.get("source") ?? undefined,
          effectiveState: url.searchParams.get("effectiveState") ?? undefined,
          page: url.searchParams.get("page") ?? undefined,
          pageSize: url.searchParams.get("pageSize") ?? undefined,
        });
        const result = await readSubscriptionOverviewAsync(application.queries, state, at);
        await appendSensitiveReadAudit({ actor, source: "owner", requestId, action: "plan_budget_usage.read", resourceType: "plan_subscription", resourceId: subscriptionId || "list", result: "success", metadata });
        return json({ items: result.usage, subscriptions: result.subscriptions, calculatedAt: at, page: result.page, pageSize: result.pageSize, total: result.total, totalPages: result.totalPages, nextCursor: null });
      } catch (error) {
        await appendSensitiveReadAudit({ actor, source: "owner", requestId, action: "plan_budget_usage.read", resourceType: "plan_subscription", resourceId: subscriptionId || "list", result: "failure", metadata: { ...metadata, errorCode: error instanceof RelayError ? error.code : "internal_error" } });
        throw error;
      }
    }
    if (resource === "plans") {
      const url = new URL(request.url);
      return json(await application.queries.pagePlanSubscriptions(ownerQueryPage(url), ownerQueryPageSize(url)));
    }
    if (resource === "request-logs" && path[1] === "captures" && path[2] === "download") {
      const filter = adminRequestCaptureDownloadFilter(request);
      const baseMetadata = adminRequestCaptureDownloadAuditMetadata(filter);
      const slot = await application.commands.acquireRequestCaptureDownloadSlot();
      if (!slot) {
        const error = new RelayError("request_capture_download_busy", "Request Capture batch download capacity is busy", 503);
        await auditFailureForBackend({ actor, source: "owner", requestId, action: "request_capture.download", resource: { resourceType: "request_capture", resourceId: "range" }, metadata: { routePattern: "/api/owner/request-logs/captures/download", ...baseMetadata }, error });
        throw error;
      }
      try {
        if (filter.apiKeyId && !(await asyncTenancy.identity.getApiKey(filter.apiKeyId))) throw new RelayError("api_key_not_found", "API key not found", 404);
        if (filter.userId && !(await asyncTenancy.identity.getUser(filter.userId))) throw new RelayError("user_not_found", "User not found", 404);
        if (filter.teamId && !(await asyncTenancy.tenancy.getTeam(filter.teamId))) throw new RelayError("team_not_found", "Team not found", 404);
        const logs = await queryRequestLogsAcrossStorageAsync(application.queries, requestLogArchiveReader, filter, config.requestCapture.download.maxFiles + 1);
        const prepared = await prepareRequestCaptureDownload(requestCaptureClient.repo.v3, logs, config.requestCapture.download);
        const metadata = { ...baseMetadata, count: prepared.files.length, missingCount: prepared.missingCount, byteCount: prepared.compressedBytes };
        const stream = requestCaptureTarStream(prepared.files, requestCaptureDownloadSlotHooksAsync(application.commands, slot, requestCaptureStreamAuditHooksAsync(application.audit, {
            actor,
            requestId,
            resourceId: "range",
            routePattern: "/api/owner/request-logs/captures/download",
            metadata
          })));
        return new Response(stream, { headers: downloadHeaders("application/x-tar", requestCaptureTarFilename(filter.startedAtGte, filter.startedAtLte)) });
      } catch (error) {
        try {
          await auditFailureForBackend({ actor, source: "owner", requestId, action: "request_capture.download", resource: { resourceType: "request_capture", resourceId: "range" }, metadata: { routePattern: "/api/owner/request-logs/captures/download", ...baseMetadata }, error });
        } finally {
          await application.commands.releaseRequestCaptureDownloadSlot(slot);
        }
        throw error;
      }
    }
    if (resource === "request-logs" && path[1] && path[2] === "capture") {
      const requestLogId = path[1];
      const isDownload = path[3] === "download";
      if (path[3] && !isDownload) throw new RelayError("not_found", "Owner request capture route not found", 404);
      let requestLog = await application.queries.getRequestLog(requestLogId);
      if (!requestLog) {
        const archiveEntry = await application.queries.getRequestLogArchiveEntry(requestLogId);
        if (archiveEntry) {
          requestLog = await requestLogArchiveReader.getRequestLogsForEntries([archiveEntry]).then((items: Map<string, RequestLog>) => items.get(requestLogId)).catch(async (error: unknown) => {
            const mapped = requestLogArchiveUnavailable(error);
            await auditFailureForBackend({ actor, source: "owner", requestId, action: isDownload ? "request_capture.download" : "request_capture.read", resource: { resourceType: "request_capture", resourceId: requestLogId }, metadata: { routePattern: isDownload ? "/api/owner/request-logs/:id/capture/download" : "/api/owner/request-logs/:id/capture", requestId: requestLogId, apiKeyId: archiveEntry.apiKeyId, format: isDownload ? "jsonl.zst" : "json" }, error: mapped });
            throw mapped;
          });
          if (!requestLog) {
            const error = requestLogArchiveUnavailable();
            await auditFailureForBackend({ actor, source: "owner", requestId, action: isDownload ? "request_capture.download" : "request_capture.read", resource: { resourceType: "request_capture", resourceId: requestLogId }, metadata: { routePattern: isDownload ? "/api/owner/request-logs/:id/capture/download" : "/api/owner/request-logs/:id/capture", requestId: requestLogId, apiKeyId: archiveEntry.apiKeyId, format: isDownload ? "jsonl.zst" : "json" }, error });
            throw error;
          }
        }
      }
      if (!requestLog) {
        const error = new RelayError("request_log_not_found", "Request log not found", 404);
        await auditFailureForBackend({ actor, source: "owner", requestId, action: isDownload ? "request_capture.download" : "request_capture.read", resource: { resourceType: "request_capture", resourceId: requestLogId }, metadata: { routePattern: isDownload ? "/api/owner/request-logs/:id/capture/download" : "/api/owner/request-logs/:id/capture", requestId: requestLogId, format: isDownload ? "jsonl.zst" : "json" }, error });
        throw error;
      }
      if (isDownload) {
        const metadata = { routePattern: "/api/owner/request-logs/:id/capture/download", requestId: requestLog.id, apiKeyId: requestLog.apiKeyId, format: "jsonl.zst" };
        try {
          const prepared = await prepareRequestCaptureDownload(requestCaptureClient.repo.v3, [requestLog], { maxFiles: 1, maxCompressedBytes: config.requestCapture.download.maxCompressedBytes });
          const file = prepared.files[0]!;
          return new Response(requestCaptureFileStream(file, requestCaptureStreamAuditHooksAsync(application.audit, {
              actor,
              requestId,
              resourceId: requestLog.id,
              routePattern: "/api/owner/request-logs/:id/capture/download",
              metadata: { ...metadata, byteCount: file.size }
            })), { headers: { ...downloadHeaders("application/zstd", `${requestLog.id}.jsonl.zst`), "content-length": String(file.size) } });
        } catch (error) {
          await auditFailureForBackend({ actor, source: "owner", requestId, action: "request_capture.download", resource: { resourceType: "request_capture", resourceId: requestLog.id }, metadata, error });
          throw error;
        }
      }
      const requestedView = parseRequestCaptureView(new URL(request.url).searchParams.get("view"));
      const locatedExchange = await requestCaptureReader.getCapturedExchangeForRequestLogAsync(requestLog).catch(async (error: unknown) => {
        await auditFailureForBackend({
          actor,
          source: "owner",
          requestId,
          action: "request_capture.read",
          resource: { resourceType: "request_capture", resourceId: requestLogId },
          metadata: { routePattern: "/api/owner/request-logs/:id/capture", requestId: requestLogId, apiKeyId: requestLog.apiKeyId, format: "json", requestCaptureView: requestedView ?? "original" },
          error
        });
        throw error;
      });
      const capturedRequest = locatedExchange?.exchange.request ?? null;
      const capturedResponse = locatedExchange?.exchange.response ?? null;
      if (!locatedExchange) {
        await auditFailureForBackend({
          actor,
          source: "owner",
          requestId,
          action: "request_capture.read",
          resource: { resourceType: "request_capture", resourceId: requestLogId },
          metadata: { routePattern: "/api/owner/request-logs/:id/capture", requestId: requestLogId, format: "json", requestCaptureView: requestedView ?? "original", effectiveCaptureStatus: "unavailable", effectiveRepresentation: null }
        });
        throw new RelayError("request_capture_not_found", "Request capture not found", 404);
      }
      await auditSuccessForBackend({
        actor,
        source: "owner",
        requestId,
        action: "request_capture.read",
        resource: { resourceType: "request_capture", resourceId: requestLogId },
        metadata: { routePattern: "/api/owner/request-logs/:id/capture", requestId: requestLogId, apiKeyId: requestLog.apiKeyId, format: "json", requestCaptureView: requestedView ?? "original", effectiveCaptureStatus: capturedRequest?.effective.status ?? "unavailable", effectiveRepresentation: capturedRequest?.effective.status === "verified" ? capturedRequest.effective.representation : null }
      });
      if (requestedView) return requestCaptureJson(requestCaptureViewResponse(locatedExchange.exchange, requestedView));
      return requestCaptureJson({
        requestPayload: capturedRequest?.payload ?? null,
        originalRequestPayload: capturedRequest?.payload ?? null,
        effectiveRequestPayload: capturedRequest?.effective.status === "verified" ? capturedRequest.effective.body : null,
        effectiveCaptureStatus: capturedRequest?.effective.status ?? "unavailable",
        effectiveRepresentation: capturedRequest?.effective.status === "verified" ? capturedRequest.effective.representation : null,
        effectiveUnavailableReason: capturedRequest?.effective.status === "unavailable" ? capturedRequest.effective.reason : null,
        requestCapturedAt: capturedRequest?.createdAt ?? null,
        responseBody: capturedResponse?.body ?? null,
        responseStatus: capturedResponse?.status ?? null,
        responseErrorCode: capturedResponse?.errorCode ?? null,
        responseCapturedAt: capturedResponse?.createdAt ?? null,
        errorMessage: errorMessageFromBody(capturedResponse?.body)
      });
    }
    if (resource === "request-logs") {
      const url = new URL(request.url);
      const pageSize = ownerQueryPageSize(url);
      const filter = ownerRequestLogCursorFilter(request);
      const rows = await (queryRequestLogsAcrossStorageAsync(application.queries, requestLogArchiveReader, filter, pageSize + 1)).catch(async (error: unknown) => {
        await appendSensitiveReadAudit({ actor, source: "owner", requestId, action: "request_log.read", resourceType: "request_log", resourceId: "list", result: "failure", metadata: { routePattern: "/api/owner/request-logs", errorCode: error instanceof RelayError ? error.code : "internal_error" } });
        throw error;
      });
      await appendSensitiveReadAudit({ actor, source: "owner", requestId, action: "request_log.read", resourceType: "request_log", resourceId: "list", result: "success", metadata: { routePattern: "/api/owner/request-logs" } });
      return json(requestLogCursorPage(rows, pageSize));
    }
    if (resource === "usage-logs") {
      const url = new URL(request.url);
      try {
        const page = await application.queries.pageUsageLogs(ownerQueryPage(url), ownerQueryPageSize(url));
        await appendSensitiveReadAudit({ actor, source: "owner", requestId, action: "usage_log.read", resourceType: "usage_log", resourceId: "list", result: "success", metadata: { routePattern: "/api/owner/usage-logs" } });
        return json(page);
      } catch (error) {
        await appendSensitiveReadAudit({ actor, source: "owner", requestId, action: "usage_log.read", resourceType: "usage_log", resourceId: "list", result: "failure", metadata: { routePattern: "/api/owner/usage-logs", errorCode: error instanceof RelayError ? error.code : "internal_error" } });
        throw error;
      }
    }
    if (resource === "provider-invocations" && path[1] === "unresolved" && path.length === 2) {
      const limit = positiveQueryInteger(new URL(request.url).searchParams.get("limit"), 100, 500);
      const unresolved = await application.requestExecutionReconciliationRead.execute({ actor, requestId, limit });
      return json({
        items: unresolved.map((item) => ({
          ...item,
          maxTotalTokens: item.maxTotalTokens?.toString() ?? null,
          maxChargeUnits: item.maxChargeUnits?.toString() ?? null,
          heldUnits: item.heldUnits?.toString() ?? null,
        })),
        limit,
      });
    }
    if (resource === "request-capture") return json(await application.queries.getRequestCaptureSetting());
    if (resource === "pipeline-plugins") {
      if (path[1]) {
        const plugin = (await pipelinePluginSettingViewsAsync(application.queries, asyncTenancy.identity)).find((item) => item.id === path[1]);
        if (!plugin) throw new RelayError("pipeline_plugin_not_found", "Pipeline plugin not found", 404);
        return json(plugin);
      }
      return json({ items: await pipelinePluginSettingViewsAsync(application.queries, asyncTenancy.identity), nextCursor: null });
    }
    if (resource === "ingress-plugins") {
      if (path[1]) {
        const plugin = (await ingressPluginSettingViewsAsync(application.queries, asyncTenancy.identity)).find((item) => item.id === path[1]);
        if (!plugin) throw new RelayError("ingress_plugin_not_found", "Ingress plugin not found", 404);
        return json(plugin);
      }
      return json({ items: await ingressPluginSettingViewsAsync(application.queries, asyncTenancy.identity), nextCursor: null });
    }
    if (resource === "request-captures") {
      try {
        const url = new URL(request.url);
        const pageSize = ownerQueryPageSize(url);
        const requestLogs = await queryRequestLogsAcrossStorageAsync(application.queries, requestLogArchiveReader, ownerRequestLogCursorFilter(request), pageSize + 1);
        const hasMore = requestLogs.length > pageSize;
        const visibleLogs = requestLogs.slice(0, pageSize);
        const items = (await Promise.all(visibleLogs.map(async (requestLog) => {
          const exchange = await requestCaptureReader.getCapturedExchangeForRequestLogAsync(requestLog);
          return exchange?.exchange.request ?? null;
        }))).filter((item): item is NonNullable<typeof item> => item !== null);
        await appendSensitiveReadAudit({ actor, source: "owner", requestId, action: "request_capture.read", resourceType: "request_capture", resourceId: "list", result: "success", metadata: { routePattern: "/api/owner/request-captures", count: items.length } });
        const last = visibleLogs.at(-1);
        return json({ items: items.map((item) => ({ id: item.id, requestId: item.requestId, apiKeyId: item.apiKeyId, userId: item.userId, teamId: item.teamId, kind: item.kind, reqModel: item.reqModel, createdAt: item.createdAt, original: item.payload, effective: item.effective })), pageSize, hasMore, nextCursor: hasMore && last ? `${last.startedAt}:${last.id}` : null });
      } catch (error) {
        await appendSensitiveReadAudit({ actor, source: "owner", requestId, action: "request_capture.read", resourceType: "request_capture", resourceId: "list", result: "failure", metadata: { routePattern: "/api/owner/request-captures", errorCode: error instanceof RelayError ? error.code : "internal_error" } });
        throw error;
      }
    }
    if (resource === "audit-logs") {
      const state = parseAuditLogUrlState(Object.fromEntries(new URL(request.url).searchParams));
      try {
        const page = await application.auditQueries.pageAuditLogs(state);
        await appendSensitiveReadAudit({ actor, source: "owner", requestId, action: "audit_log.read", resourceType: "audit_log", resourceId: "list", result: "success", metadata: { routePattern: "/api/owner/audit-logs", count: page.items.length } });
        return json(page);
      } catch (error) {
        await appendSensitiveReadAudit({ actor, source: "owner", requestId, action: "audit_log.read", resourceType: "audit_log", resourceId: "list", result: "failure", metadata: { routePattern: "/api/owner/audit-logs", errorCode: error instanceof RelayError ? error.code : "internal_error" } });
        throw error;
      }
    }
    if (resource === "usage") return json(await application.queries.usageSummary());
    if (resource === "owner-profit") {
      const scopeRef = requiredRuntimeScopeRef(new URL(request.url).searchParams.get("scopeRef") ?? "global:", "scopeRef");
      return json({ scopeRef, ...(await application.queries.ownerProfitSummary(scopeRef)) });
    }
    if (resource === "external-price-lookup") {
      const url = new URL(request.url);
      const providerId = url.searchParams.get("providerId") ?? "";
      const providerModelName = url.searchParams.get("providerModelName") ?? "";
      const source = url.searchParams.get("source") ?? "";
      try {
        const result = await externalPriceLookup(asyncExternalPricing, { requestId, source, providerId, providerModelName });
        await appendSensitiveReadAudit({ actor, source: "owner", requestId, action: "external_price.lookup", resourceType: "provider_model_cost", resourceId: `${providerId}:${providerModelName}`, result: "success", metadata: { providerId, providerModelName, routePattern: "/api/owner/external-price-lookup" } });
        return json(result);
      } catch (error) {
        await appendSensitiveReadAudit({ actor, source: "owner", requestId, action: "external_price.lookup", resourceType: "provider_model_cost", resourceId: `${providerId}:${providerModelName}`, result: "failure", metadata: { providerId, providerModelName, routePattern: "/api/owner/external-price-lookup", errorCode: error instanceof RelayError ? error.code : "internal_error" } });
        throw error;
      }
    }
    throw new RelayError("not_found", "Owner resource not found", 404);
  });
}

export async function POST(request: Request, context: Context) {
  return mutate(request, context);
}

export async function PATCH(request: Request, context: Context) {
  return mutate(request, context);
}

export async function DELETE(request: Request, context: Context) {
  return mutate(request, context);
}

async function mutate(request: Request, context: Context) {
  return handle(request, async () => {
    const { asyncTenancy, authorityEntitlement, billingCommerce, application, requestCaptureClient, asyncExternalPricing, asyncAccessResolution, config } = await services();
    ensureBillingCommerceRuntime(application);
    const path = (await context.params).path ?? [];
    const requestId = requestIdFromHeaders(request.headers);
    const isTeamDelete = request.method === "DELETE" && path[0] === "teams" && Boolean(path[1]) && path.length === 2;
    const claims = await asyncTenancy.requireOwner(request.headers);
    const platformRoles = isTeamDelete
      ? await asyncTenancy.authority.platformRolesForUser(claims.sub)
      : [];
    if (isTeamDelete && (!claims.platformRoles.includes("owner") || !platformRoles.includes("owner"))) {
      const error = new RelayError("forbidden", "Platform Owner role is required", 403);
      if (isTeamDelete && path[1]) {
        const team = await asyncTenancy.tenancy.getTeam(path[1]);
        const deniedInput = {
          actor: actorFromClaims(claims), source: "owner", requestId,
          action: "team.delete.request", resource: { resourceType: "team", resourceId: path[1] },
          metadata: { teamId: path[1], name: team?.name ?? null, status: team?.status ?? null, blockers: [] }, error
        } as const;
        await auditDeniedAsync(application.audit, deniedInput);
      }
      throw error;
    }
    const actor = actorFromClaims(claims);
    const audit = { actor, source: "owner" as const, requestId };
    const resource = path[0] ?? "";
    const billingQueries = application.billingQueries;
    const billingCommands = application.billingCommands;
    const billingApplication = billingCommerce ?? (process.env.NODE_ENV === "test" ? billingCommands : undefined);
    if (resource === "api-keys" && path[1] && path[2] === "plan-source-restriction" && path.length === 3) {
      if (request.method !== "PATCH" && request.method !== "POST") throw new RelayError("invalid_api_key_plan_source_restriction_method", "API key Plan source restriction can be updated with PATCH", 405);
      const body = await bodyJson<Record<string, unknown>>(request, config.gateway.maxRequestBodyBytes);
      const policy = apiKeyPlanSourceRestrictionInput(body);
      return json(await authorityEntitlement.replaceApiKeyPlanSourceRestriction({
        apiKeyId: path[1], actorUserId: actor.actorId, ...policy, auditSource: "owner", requestId,
      }));
    }
    if (resource === "payment-channels" && path[1] && path[2] === "instruction-attachments") {
      const attachment = await storePaymentChannelInstructionAttachment(request, attachmentStorageRoot(config), path[1], actor.actorId, {
        listPaymentChannelInstructionAttachments: (id) => billingQueries.listPaymentChannelInstructionAttachments(id),
        createPaymentChannelInstructionAttachment: (input) => billingCommands.createPaymentChannelInstructionAttachment(input),
      });
      const attachmentAudit = { actor, source: "owner" as const, requestId: audit.requestId, action: "payment_channel_instruction_attachment.create", resource: { resourceType: "payment_channel_instruction_attachment", resourceId: attachment.id }, metadata: { paymentChannelId: path[1], attachmentCount: 1, attachmentContentType: attachment.contentType, attachmentByteSize: attachment.byteSize, attachmentSha256: attachment.sha256 } } as const;
      await auditSuccessAsync(application.audit, attachmentAudit);
      return json(attachment);
    }
    if (resource === "credit-topups" && path[1] && path[2] === "attachments") {
      const topup = await billingQueries.getCreditTopup(path[1]);
      if (!topup) throw new RelayError("credit_topup_not_found", "Credit topup not found", 404);
      const attachment = await storeCreditTopupAttachment(request, attachmentStorageRoot(config), topup.id, actor.actorId, "admin_supplement", {
        listCreditTopupAttachments: (id) => billingQueries.listCreditTopupAttachments(id),
        createCreditTopupAttachment: (input) => billingCommands.createCreditTopupAttachment(input),
      });
      const attachmentAudit = { actor, source: "owner" as const, requestId: audit.requestId, action: "credit_topup_attachment.create", resource: { resourceType: "credit_topup_attachment", resourceId: attachment.id }, metadata: { topupId: topup.id, attachmentCount: 1, attachmentContentType: attachment.contentType, attachmentByteSize: attachment.byteSize, attachmentSha256: attachment.sha256 } } as const;
      await auditSuccessAsync(application.audit, attachmentAudit);
      return json(attachment);
    }
    if (resource === "providers" && path[1] && path[2] === "credential-import" && request.method === "POST") {
      const form = await readBoundedRequestFormData(request, 1024 * 1024 + 64 * 1024);
      const file = form.get("file");
      const location = String(form.get("location") ?? "").trim();
      if (!(file instanceof File) || file.size === 0 || file.size > 1024 * 1024 || (file.type && file.type !== "application/json")) throw new RelayError("cliproxy_vertex_credential_invalid", "A JSON service-account file up to 1 MiB is required", 400);
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/i.test(location)) throw new RelayError("cliproxy_vertex_credential_invalid", "Vertex location is invalid", 400);
      const managementContext = { actor, source: "owner" as const, requestId: audit.requestId, privateProviderOrigin: process.env.FRIDAY_RELAY_PRIVATE_PROVIDER_ORIGIN };
      const serviceAccountJson = await file.text();
      return json(await new AsyncProviderManagementService(application.queries, application.commands, application.modelAccess.providers, application.modelAccessQueries, application.audit).importCredential(path[1], serviceAccountJson, location, managementContext));
    }
    const body = await bodyJson<Record<string, unknown>>(request, config.gateway.maxRequestBodyBytes);
    if (resource === "provider-invocations" && path[1] && path[2] === "reconcile-final" && path.length === 3 && request.method === "POST") {
      const evidence = providerInvocationFinalEvidence(body);
      const settled = await application.requestExecutionCommands.reconcileFinalUsage({
        providerAttemptId: path[1],
        outcome: evidence.outcome,
        ...(evidence.failureClass ? { failureClass: evidence.failureClass } : {}),
        outputCommitted: evidence.outputCommitted,
        usage: evidence.usage,
        evidenceKind: evidence.evidenceKind,
        evidenceRef: evidence.evidenceRef,
        audit: { actor, requestId },
      });
      return json({
        providerAttemptId: path[1],
        billingEventId: settled.billingEventId,
        postingLedgerEventId: settled.postingLedgerEventId,
        actualChargeUnits: settled.actualChargeUnits.toString(),
      });
    }
    if (resource === "card-activation-batches" && !path[1] && request.method === "POST") {
      const cardType = body.cardType === "plan" || body.cardType === "credit" ? body.cardType : undefined;
      if (!cardType) throw new RelayError("card_activation_product_shape_invalid", "cardType must be plan or credit", 400);
      const result = await billingCommands.createCardActivationBatch({
        referenceCode: requiredString(body.referenceCode, "referenceCode"),
        cardType,
        planId: body.planId === undefined || body.planId === null ? null : requiredString(body.planId, "planId"),
        creditProductId: body.creditProductId === undefined || body.creditProductId === null ? null : requiredString(body.creditProductId, "creditProductId"),
        creditAmountUnits: body.creditAmountUnits === undefined || body.creditAmountUnits === null ? null : Number(body.creditAmountUnits),
        quantity: Number(body.quantity),
        redeemExpiresAt: requiredString(body.redeemExpiresAt, "redeemExpiresAt"),
        idempotencyKey: request.headers.get("idempotency-key") ?? "",
        createdByUserId: actor.actorId,
        requestId,
      });
      return json(cardActivationBatchView(result), { status: 201 });
    }
    if (resource === "card-activation-batches" && path[1] && path[2] === "revoke" && request.method === "POST") {
      return json(cardActivationBatchView(await billingCommands.revokeCardActivationBatch(path[1], actor.actorId, requiredString(body.reason, "reason"), requestId)));
    }
    if (resource === "card-activation-codes" && path[1] && path[2] === "revoke" && request.method === "POST") {
      return json(cardActivationCodeSafeView(await billingCommands.revokeCardActivationCode(path[1], actor.actorId, requiredString(body.reason, "reason"), requestId)));
    }
    if (resource === "authority-products" && path.length === 1 && request.method === "POST") {
      const input = { code: requiredString(body.code, "code"), actorOwnerUserId: claims.sub, ...authorityProductTerms(body), requestId };
      return json(ownerAuthorityProduct(await authorityEntitlement.createAuthorityProductVersion(input)), { status: 201 });
    }
    if (resource === "authority-products" && path[1] && path[2] === "versions" && request.method === "POST") {
      const source = await authorityEntitlement.commerce.getAuthorityProduct(path[1]);
      if (!source) throw new RelayError("authority_product_not_found", "Authority Product not found", 404);
      const input = { code: source.code, actorOwnerUserId: claims.sub, ...authorityProductTerms(body), requestId };
      return json(ownerAuthorityProduct(await authorityEntitlement.createAuthorityProductVersion(input)), { status: 201 });
    }
    if (resource === "authority-products" && path[1] && path.length === 2 && request.method === "PATCH") {
      if (body.lifecycle === "listed") return json(ownerAuthorityProduct(await authorityEntitlement.listAuthorityProductVersion(path[1], claims.sub, requestId)));
      if (body.lifecycle === "closed") return json(ownerAuthorityProduct(await authorityEntitlement.closeAuthorityProduct(path[1], claims.sub, requestId)));
      const input = { actorOwnerUserId: claims.sub, ...authorityProductTerms(body), requestId };
      return json(ownerAuthorityProduct(await authorityEntitlement.updateDraftAuthorityProduct(path[1], input)));
    }
    if (resource === "authority-grants" && path[1] && path[2] === "cancel" && request.method === "POST") {
      const reasonCode = requiredString(body.reasonCode, "reasonCode");
      return json(await authorityEntitlement.authorityCommands.cancelGrant({ grantId: path[1], actorOwnerUserId: claims.sub, reasonCode, requestId }));
    }
    if (resource === "authority-grants" && path[1] && path[2] === "refund-unused" && request.method === "POST") {
      const reasonCode = requiredString(body.reasonCode, "reasonCode");
      const idempotencyKey = request.headers.get("idempotency-key") ?? "";
      return json(await authorityEntitlement.refundUnusedAuthorityGrant({ grantId: path[1], actorOwnerUserId: claims.sub, reasonCode, idempotencyKey, requestId }));
    }
    if (resource === "team-provider-entitlements" && path[1] && path[2] === "cancel" && request.method === "POST") {
      const input = {
        entitlementId: path[1],
        actorOwnerUserId: claims.sub,
        reasonCode: requiredString(body.reasonCode, "reasonCode")
      };
      return json(await authorityEntitlement.entitlementCommands.cancelTeamProviderEntitlement({ ...input, requestId }));
    }
    if (resource === "api-keys" && path[2] === "revoke") {
      return json(await asyncTenancy.revokeKey(String(path[1] ?? ""), audit));
    }
    if (resource === "request-capture") {
      if (request.method !== "POST" && request.method !== "PATCH") throw new RelayError("invalid_request_capture_mutation", "Request capture can be updated with POST or PATCH", 405);
      const setting = await application.commands.setRequestCaptureEnabled(Boolean(body.enabled), actor.actorId);
      const auditInput = { actor, source: "owner" as const, requestId: audit.requestId, action: "request_capture.update", resource: { resourceType: "request_capture", resourceId: "global" }, metadata: { enabled: setting.enabled } } as const;
      await auditSuccessAsync(application.audit, auditInput);
      return json(setting);
    }
    if (resource === "pipeline-plugins") {
      if (request.method !== "PATCH") throw new RelayError("invalid_pipeline_plugin_mutation", "Pipeline plugin settings can be updated with PATCH", 405);
      const pluginId = String(path[1] ?? "");
      const plugin = pipelinePluginById(pluginId);
      if (!plugin) throw new RelayError("pipeline_plugin_not_found", "Pipeline plugin not found", 404);
      if (body.scopeRef !== GLOBAL_PIPELINE_PLUGIN_SCOPE) throw new RelayError("invalid_pipeline_plugin_scope", "Only global pipeline plugin settings are supported", 400);
      if (!plugin.manifest.userToggleable && !plugin.manifest.userConfigurable) throw new RelayError("pipeline_plugin_read_only", "Required pipeline plugin topology is read-only", 400);
      if (typeof body.enabled !== "boolean") throw new RelayError("invalid_pipeline_plugin_setting", "enabled must be boolean", 400);
      if (!plugin.manifest.userToggleable && body.enabled !== true) throw new RelayError("pipeline_plugin_required", "This pipeline plugin cannot be disabled", 400);
      if (!isPlainRecord(body.config)) throw new RelayError("invalid_pipeline_plugin_config", "config must be an object", 400);

      let validatedConfig: Record<string, unknown>;
      try { validatedConfig = validatePipelinePluginConfig(pluginId, body.config); }
      catch { throw new RelayError("invalid_pipeline_plugin_config", "Pipeline plugin config is invalid", 400); }
      const previous = await application.queries.getPipelinePluginSetting(pluginId, GLOBAL_PIPELINE_PLUGIN_SCOPE);
      const previousConfig = previous ? JSON.parse(previous.configJson) as Record<string, unknown> : plugin.defaultConfig as Record<string, unknown>;
      const changedConfigKeys = [...new Set([...Object.keys(previousConfig), ...Object.keys(validatedConfig)])]
        .filter((key) => JSON.stringify(previousConfig[key]) !== JSON.stringify(validatedConfig[key]))
        .sort();
      const settingInput = {
        pluginId,
        scopeRef: GLOBAL_PIPELINE_PLUGIN_SCOPE,
        enabled: body.enabled,
        configJson: JSON.stringify(validatedConfig),
        updatedByUserId: actor.actorId
      };
      await application.commands.upsertPipelinePluginSetting(settingInput);
      const saved = (await pipelinePluginSettingViewsAsync(application.queries, asyncTenancy.identity)).find((item) => item.id === pluginId);
      if (!saved) throw new RelayError("pipeline_plugin_not_found", "Pipeline plugin not found", 404);
      const auditInput = {
        actor,
        source: "owner",
        requestId: audit.requestId,
        action: "pipeline_plugin_setting.update",
        resource: { resourceType: "pipeline_plugin_setting", resourceId: `${GLOBAL_PIPELINE_PLUGIN_SCOPE}${pluginId}` },
        metadata: {
          pluginId,
          scopeRef: GLOBAL_PIPELINE_PLUGIN_SCOPE,
          apiVersion: plugin.manifest.apiVersion,
          behaviorVersion: plugin.manifest.behaviorVersion,
          configVersion: plugin.manifest.configVersion,
          previousEnabled: previous ? Boolean(previous.enabled) : false,
          enabled: saved.enabled,
          changedConfigKeys
        }
      } as const;
      await auditSuccessAsync(application.audit, auditInput);
      return json(saved);
    }
    if (resource === "ingress-plugins") {
      if (request.method !== "PATCH") throw new RelayError("invalid_ingress_plugin_mutation", "Ingress plugin settings can be updated with PATCH", 405);
      const pluginId = String(path[1] ?? "");
      const plugin = ingressPluginById(pluginId);
      if (!plugin) throw new RelayError("ingress_plugin_not_found", "Ingress plugin not found", 404);
      if (body.scopeRef !== GLOBAL_PLUGIN_SCOPE) throw new RelayError("invalid_ingress_plugin_scope", "Only global ingress plugin settings are supported", 400);
      if (typeof body.enabled !== "boolean") throw new RelayError("invalid_ingress_plugin_setting", "enabled must be boolean", 400);
      if (!isPlainRecord(body.config)) throw new RelayError("invalid_ingress_plugin_config", "config must be an object", 400);

      let validatedConfig: Record<string, unknown>;
      try {
        const candidate = GatewayCore.validateIngressPluginConfig(pluginId, body.config);
        if (!isPlainRecord(candidate)) throw new TypeError("Validated ingress plugin config must be an object");
        validatedConfig = candidate;
      } catch {
        throw new RelayError("invalid_ingress_plugin_config", "Ingress plugin config is invalid", 400);
      }
      const previous = await application.queries.getIngressPluginSetting(pluginId, GLOBAL_PLUGIN_SCOPE);
      const previousConfig = storedPluginConfig(previous) ?? plugin.defaultConfig;
      const changedConfigKeys = [...new Set([...Object.keys(previousConfig), ...Object.keys(validatedConfig)])]
        .filter((key) => JSON.stringify(previousConfig[key]) !== JSON.stringify(validatedConfig[key]))
        .sort();
      await application.commands.upsertIngressPluginSetting({ pluginId, scopeRef: GLOBAL_PLUGIN_SCOPE, enabled: body.enabled, configJson: JSON.stringify(validatedConfig), updatedByUserId: actor.actorId });
      const saved = (await ingressPluginSettingViewsAsync(application.queries, asyncTenancy.identity)).find((item) => item.id === pluginId);
      if (!saved) throw new RelayError("ingress_plugin_not_found", "Ingress plugin not found", 404);
      const auditInput = {
        actor,
        source: "owner",
        requestId: audit.requestId,
        action: "ingress_plugin_setting.update",
        resource: { resourceType: "ingress_plugin_setting", resourceId: `${GLOBAL_PLUGIN_SCOPE}${pluginId}` },
        metadata: {
          pluginId,
          scopeRef: GLOBAL_PLUGIN_SCOPE,
          pluginVersion: plugin.version,
          previousEnabled: previous ? Boolean(previous.enabled) : false,
          enabled: saved.enabled,
          changedConfigKeys
        }
      } as const;
      await auditSuccessAsync(application.audit, auditInput);
      return json(saved);
    }
    if (resource === "teams" && path[1]) {
      if (path[2] === "provider-entitlements" && !path[3]) {
        if (request.method !== "POST") throw new RelayError("invalid_team_provider_entitlement_mutation", "Team Provider entitlements are granted with POST", 405);
        const input = {
          teamId: path[1],
          productId: requiredString(body.productId, "productId"),
          actorOwnerUserId: claims.sub,
          idempotencyKey: request.headers.get("idempotency-key") ?? ""
        };
        const result = await authorityEntitlement.grantTeamProviderEntitlement({ ...input, requestId });
        return json(result.entitlement, { status: result.replayed ? 200 : 201 });
      }
      if (path[2] === "invite-links") {
        if (request.method !== "POST") throw new RelayError("invalid_team_invite_link_mutation", "Team invite links can be created or disabled with POST", 405);
        {
          if (path[3] && path[4] === "disable") return json(await asyncTenancy.disableTeamInviteLink(path[1], path[3], audit));
          if (!path[3]) return json(await asyncTenancy.createTeamInviteLink(path[1], audit, body.maxUses));
          throw new RelayError("team_invite_link_action_not_found", "Team invite link action not found", 404);
        }
      }
      if (path[2] === "invite-settings") {
        if (path[3] === "test") {
          if (request.method !== "POST") throw new RelayError("invalid_team_invite_setting_test", "Invitation email domain rules can be tested with POST", 405);
          {
            if (!(await asyncTenancy.tenancy.getTeam(path[1]))) throw new RelayError("team_not_found", "Team not found", 404);
          }
          if (typeof body.email !== "string" || !body.email.trim()) throw new RelayError("invalid_invite_email", "Email is required", 400);
          if (body.inviteEmailDomainPattern !== null && typeof body.inviteEmailDomainPattern !== "string") throw new RelayError("invalid_team_invite_setting", "inviteEmailDomainPattern must be a string or null", 400);
          return json(testInviteEmailDomainPattern(body.email, body.inviteEmailDomainPattern as string | null));
        }
        if (request.method !== "PATCH") throw new RelayError("invalid_team_invite_setting_mutation", "Invite settings can be updated with PATCH", 405);
        if (body.memberInvitesEnabled !== undefined && typeof body.memberInvitesEnabled !== "boolean") throw new RelayError("invalid_team_invite_setting", "memberInvitesEnabled must be boolean", 400);
        if (body.inviteEmailDomainPattern !== undefined && body.inviteEmailDomainPattern !== null && typeof body.inviteEmailDomainPattern !== "string") throw new RelayError("invalid_team_invite_setting", "inviteEmailDomainPattern must be a string or null", 400);
        const input = {
          ...(body.memberInvitesEnabled !== undefined ? { memberInvitesEnabled: body.memberInvitesEnabled } : {}),
          ...(body.inviteEmailDomainPattern !== undefined ? { inviteEmailDomainPattern: body.inviteEmailDomainPattern as string | null } : {})
        };
        return json(await asyncTenancy.updateTeamInviteSettings(path[1], input, audit));
      }
      if (path[2] === "members") {
        if (path[4] === "roles") {
          if (request.method !== "PATCH") throw new RelayError("invalid_team_member_roles_mutation", "Team member roles can be updated with PATCH", 405);
          const roles = Array.isArray(body.roles) ? body.roles.map((role) => String(role)) : [];
          const normalizedRoles = roles.filter((role): role is "viewer" | "billing" | "manager" => role === "viewer" || role === "billing" || role === "manager");
          return json(await asyncTenancy.updateTeamMemberRoles(path[1], path[3] ?? "", normalizedRoles, audit));
        }
        if (request.method === "POST" && !path[3]) return json(await asyncTenancy.addTeamMember(path[1], requiredString(body.userId, "userId"), audit));
        if (request.method === "DELETE" && path[3]) return json(await asyncTenancy.removeTeamMember(path[1], path[3], audit));
        throw new RelayError("invalid_team_member_mutation", "Team members can be added with POST or removed with DELETE", 405);
      }
      if (path[2] === "permissions") {
        if (request.method !== "POST" && request.method !== "PATCH") throw new RelayError("invalid_resource_permission_mutation", "Resource permissions can be updated with POST or PATCH", 405);
        const permissionInput = {
          teamId: path[1],
          resourceType: String(body.resourceType ?? "team"),
          resourceId: String(body.resourceId ?? path[1]),
          action: requiredString(body.action, "action"),
          subjectType: normalizeResourcePermissionSubjectType(body.subjectType),
          subjectRef: String(body.subjectRef ?? path[1]),
          subjectRole: body.subjectRole === null || body.subjectRole === undefined ? null : String(body.subjectRole),
          status: body.status === "disabled" ? "disabled" as const : "enabled" as const
        };
        {
          const permission = await application.commands.upsertResourcePermission(permissionInput);
          await auditSuccessAsync(application.audit, { actor, source: "owner", requestId: audit.requestId, action: "resource_permission.update", resource: { resourceType: "resource_permission", resourceId: permission.id }, metadata: { teamId: path[1], resourceType: permission.resourceType, resourceId: permission.resourceId, action: permission.action, status: permission.status } });
          return json(permission);
        }
      }
      if (path[2] === "owner") {
        if (request.method !== "PATCH") throw new RelayError("invalid_team_owner_mutation", "Team owner can be updated with PATCH", 405);
        const ownerId = requiredString(body.ownerId, "ownerId");
        return json(await asyncTenancy.transferTeamOwnership({
          teamId: path[1],
          nextOwnerUserId: ownerId,
          actorUserId: claims.sub,
          requestId: audit.requestId,
        }));
      }
      if (path[2] === "cancel-deletion") {
        if (request.method !== "POST") throw new RelayError("invalid_team_deletion_mutation", "Team deletion can be cancelled with POST", 405);
        {
          const lifecycle = await asyncTenancy.cancelTeamDeletion(path[1], audit);
          return json(lifecycle);
        }
      }
      if (path[2] === "purge") {
        if (request.method !== "POST") throw new RelayError("invalid_team_purge_mutation", "Archived Team purge requires POST", 405);
        throw new RelayError("team_purge_controlled_archive_required", "Archived Team purge requires the controlled archive executor", 409);
      }
      if (request.method === "DELETE") {
        {
          const lifecycle = await asyncTenancy.requestTeamDeletion(path[1], audit);
          return json(lifecycle, { status: 202 });
        }
      }
      if (body.teamOwnerCanCreateCustomProvider !== undefined) {
        throw new RelayError("team_provider_entitlement_api_required", "teamOwnerCanCreateCustomProvider is deprecated; use the Team Provider entitlement API", 409);
      }
      if (body.status !== undefined) {
        throw new RelayError("team_status_managed_by_deletion_lifecycle", "Team status can only change through soft deletion or recovery", 409);
      }
      const input: { name?: string; status?: string; teamOwnerCanManageMemberApiKeyLimit?: number; teamOwnerCanManageMemberCredit?: number; teamOwnerCanCreateAccessPoint?: number } = {};
      if (body.name !== undefined) input.name = String(body.name);
      if (body.teamOwnerCanManageMemberApiKeyLimit !== undefined) input.teamOwnerCanManageMemberApiKeyLimit = body.teamOwnerCanManageMemberApiKeyLimit === true ? 1 : 0;
      if (body.teamOwnerCanManageMemberCredit !== undefined) input.teamOwnerCanManageMemberCredit = body.teamOwnerCanManageMemberCredit === true ? 1 : 0;
      if (body.teamOwnerCanCreateAccessPoint !== undefined) input.teamOwnerCanCreateAccessPoint = body.teamOwnerCanCreateAccessPoint === true ? 1 : 0;
      return json(await asyncTenancy.updateTeam(path[1], input, audit));
    }
    if (resource === "teams") {
      return json(await asyncTenancy.createTeam({ name: requiredString(body.name, "name") }, audit));
    }
    if (resource === "users" && path[1]) {
      if (request.method !== "PATCH") throw new RelayError("invalid_user_mutation", "Users can be updated with PATCH", 405);
      const existingUser = await asyncTenancy.identity.getUser(path[1]);
      if (!existingUser) throw new RelayError("user_not_found", "User not found", 404);
      const profileInput: { adminNote?: string | null; userCanCreateCustomProvider?: number; userCanCreateAccessPoint?: number } = {};
      if (Object.prototype.hasOwnProperty.call(body, "adminNote")) {
        profileInput.adminNote = body.adminNote === null ? null : String(body.adminNote ?? "");
      }
      if (Object.prototype.hasOwnProperty.call(body, "platformOwner")) {
        throw new RelayError("platform_owner_role_immutable", "Platform Owner is managed only by bootstrap handover and cannot be granted or revoked from Owner API", 403);
      }
      if (body.teamOwnerTeamId || Object.prototype.hasOwnProperty.call(body, "teamOwnerEnabled")) {
        throw new RelayError("team_owner_role_immutable", "Team owner is derived from teams.owner_id and cannot be granted or revoked", 403);
      }
      if (body.userCanCreateCustomProvider !== undefined || body.userCanCreateAccessPoint !== undefined) {
        Object.assign(profileInput, {
          ...(body.userCanCreateCustomProvider !== undefined ? { userCanCreateCustomProvider: body.userCanCreateCustomProvider === true ? 1 : 0 } : {}),
          ...(body.userCanCreateAccessPoint !== undefined ? { userCanCreateAccessPoint: body.userCanCreateAccessPoint === true ? 1 : 0 } : {})
        });
      }
      return json(Object.keys(profileInput).length > 0
        ? await asyncTenancy.updateUserProfile(path[1], profileInput, audit)
        : existingUser);
    }
    if (resource === "users") {
      if (request.method !== "POST") throw new RelayError("invalid_user_mutation", "Users can be created with POST", 405);
      if (body.grantPlatformOwner === true) throw new RelayError("platform_owner_role_immutable", "Platform Owner is managed only by bootstrap handover and cannot be granted from Owner API", 403);
      const input = {
        teamId: String(body.teamId),
        email: String(body.email),
        password: body.password
      };
      return json(await asyncTenancy.createUserWithPassword(input, audit));
    }
    if (resource === "api-keys") {
      return json(await asyncTenancy.createKey({ userId: String(body.userId), name: String(body.name ?? ""), expiresAt: body.expiresAt ? String(body.expiresAt) : null }, audit));
    }
    if (resource === "marketing-cards") {
      if (request.method !== "POST") throw new RelayError("invalid_owner_card_mutation", "Owner Cards can be created with POST", 405);
      const cardType = requiredString(body.cardType, "cardType");
      if (cardType !== "plan" && cardType !== "credit") throw new RelayError("invalid_owner_card_type", "cardType must be plan or credit", 400);
      const input = {
        cardType,
        senderUserId: actor.actorId,
        recipientUserId: requiredString(body.recipientUserId, "recipientUserId"),
        expiresAt: body.expiresAt ? String(body.expiresAt) : null,
        planId: body.planId ? String(body.planId) : null,
        creditProductId: body.creditProductId ? String(body.creditProductId) : null,
        referenceCode: requiredString(body.referenceCode, "referenceCode"),
        note: body.note ? String(body.note) : null,
        requestId: audit.requestId
      } as const;
      return json(await billingCommands.grantAdminCard(input));
    }
    if (resource === "grant-batches") {
      if (request.method !== "POST" || path[1]) throw new RelayError("invalid_admin_grant_batch_mutation", "Grant batches can be created with POST", 405);
      const actionType = requiredString(body.actionType, "actionType");
      if (actionType !== "subscription" && actionType !== "plan_card" && actionType !== "credit_card") throw new RelayError("invalid_admin_grant_action_type", "actionType must be subscription, plan_card, or credit_card", 400);
      const targetUserIds = requiredStringArray(body.targetUserIds, "targetUserIds", 500);
      const idempotencyKey = request.headers.get("idempotency-key")?.trim();
      if (!idempotencyKey) throw new RelayError("idempotency_key_required", "Idempotency-Key header is required", 400);
      const input = {
        actionType,
        requestedByUserId: actor.actorId,
        targetUserIds,
        planId: body.planId ? String(body.planId) : null,
        creditProductId: body.creditProductId ? String(body.creditProductId) : null,
        expiresAt: body.expiresAt ? String(body.expiresAt) : null,
        referenceCode: requiredString(body.referenceCode, "referenceCode"),
        note: body.note ? String(body.note) : null,
        fallbackToPlanCard: body.fallbackToPlanCard === true,
        idempotencyKey,
        requestId: audit.requestId
      } as const;
      const detail = await application.commands.createAdminGrantBatch(input);
      return json({ ...detail, page: 1, pageSize: 20, totalPages: Math.max(1, Math.ceil(detail.total / 20)) });
    }
    if (resource === "credit-transfer-policies") {
      const scopeRef = requiredScopeRef(body.scopeRef, "scopeRef");
      const policy = await billingCommands.setCreditTransferPolicy({ scopeRef, transferOutEnabled: body.transferOutEnabled === true, updatedBy: actor.actorId });
      const auditInput = { actor, source: "owner" as const, requestId: audit.requestId, action: "credit_transfer_policy.update", resource: { resourceType: "credit_transfer_policy", resourceId: policy.id }, metadata: { scopeRef: policy.scopeRef, transferOutEnabled: policy.transferOutEnabled } } as const;
      await auditSuccessAsync(application.audit, auditInput);
      return json(policy);
    }
    if (resource === "credit-products") {
      const product = path[1] && path[2] === "disable"
          ? await billingCommands.disableCreditProduct(path[1])
          : await billingCommands.createCreditProduct({ code: requiredString(body.code, "code"), displayName: requiredString(body.displayName, "displayName"), description: body.description ? String(body.description) : null, adminNote: body.adminNote ? String(body.adminNote) : null, creditedAmountUnits: requiredInteger(body.creditedAmountUnits, "creditedAmountUnits"), displayOrder: body.displayOrder == null ? 0 : requiredInteger(body.displayOrder, "displayOrder") });
      const auditInput = { actor, source: "owner" as const, requestId: audit.requestId, action: path[2] === "disable" ? "credit_product.disable" : "credit_product.create", resource: { resourceType: "credit_product", resourceId: product.id }, metadata: { productId: product.id, creditedAmountUnits: product.creditedAmountUnits } } as const;
      await auditSuccessAsync(application.audit, auditInput);
      return json(product);
    }
    if (resource === "payment-channels") {
      const channelInput = () => ({ code: requiredString(body.code, "code"), displayName: requiredString(body.displayName, "displayName"), paymentNetwork: requiredString(body.paymentNetwork, "paymentNetwork"), paymentAsset: requiredString(body.paymentAsset, "paymentAsset"), settlementMode: requiredString(body.settlementMode, "settlementMode"), recipientIdentifierType: requiredString(body.recipientIdentifierType, "recipientIdentifierType"), transactionReferenceType: requiredString(body.transactionReferenceType, "transactionReferenceType"), recipientIdentifier: requiredString(body.recipientIdentifier, "recipientIdentifier"), recipientIdentifierDisplay: requiredString(body.recipientIdentifierDisplay, "recipientIdentifierDisplay"), paymentInstruction: body.paymentInstruction ? String(body.paymentInstruction) : null, createdByUserId: actor.actorId });
      const channel = path[1] && path[2] === "enable"
          ? await billingCommands.setPaymentChannelStatus(path[1], "enabled")
          : path[1] && path[2] === "disable"
            ? await billingCommands.setPaymentChannelStatus(path[1], "disabled")
            : await billingCommands.createPaymentChannel(channelInput());
      const action = path[2] === "enable" ? "payment_channel.enable" : path[2] === "disable" ? "payment_channel.disable" : "payment_channel.create";
      const auditInput = { actor, source: "owner" as const, requestId: audit.requestId, action, resource: { resourceType: "payment_channel", resourceId: channel.id }, metadata: { paymentChannelId: channel.id, paymentNetwork: channel.paymentNetwork, paymentAsset: channel.paymentAsset, settlementMode: channel.settlementMode, recipientIdentifierType: channel.recipientIdentifierType, normalizedRecipientIdentifierHash: channel.normalizedRecipientIdentifierHash, transactionReferenceType: channel.transactionReferenceType } } as const;
      await auditSuccessAsync(application.audit, auditInput);
      return json(channel);
    }
    if (resource === "credit-product-listings") {
      const listing = path[1] && path[2] === "disable"
          ? await billingCommands.disableCreditProductListing(path[1])
          : path[1] === "switch-channel"
            ? await billingCommands.switchCreditProductListingsChannel({ sourcePaymentChannelId: requiredString(body.sourcePaymentChannelId, "sourcePaymentChannelId"), targetPaymentChannelId: requiredString(body.targetPaymentChannelId, "targetPaymentChannelId") })
            : await billingCommands.createCreditProductListing({ productId: requiredString(body.productId, "productId"), paymentChannelId: requiredString(body.paymentChannelId, "paymentChannelId"), priceAmountUnits: requiredInteger(body.priceAmountUnits, "priceAmountUnits") });
      const auditInput = { actor, source: "owner" as const, requestId: audit.requestId, action: path[1] === "switch-channel" ? "credit_product_listing.switch_channel" : path[2] === "disable" ? "credit_product_listing.disable" : "credit_product_listing.create", resource: { resourceType: "credit_product_listing", resourceId: Array.isArray(listing) ? "batch" : listing.id }, metadata: { productListingId: Array.isArray(listing) ? "batch" : listing.id } } as const;
      await auditSuccessAsync(application.audit, auditInput);
      return json(listing);
    }
    if (resource === "credit-topups") {
      if (path[1] && path[2] === "approve") {
        if (!billingApplication) throw new RelayError("billing_commerce_application_unavailable", "Billing/Commerce application service is unavailable", 503);
        const result = await billingApplication.approveCreditTopup({ topupId: path[1], ownerUserId: actor.actorId, confirmedReceivedAmountUnits: requiredInteger(body.confirmedReceivedAmountUnits, "confirmedReceivedAmountUnits"), reviewNote: requiredString(body.reviewNote, "reviewNote") });
        await auditSuccessAsync(application.audit, { actor, source: "owner", requestId: audit.requestId, action: "credit_topup.approve", resource: { resourceType: "credit_topup", resourceId: result.topup.id }, metadata: creditTopupAuditMetadata(result.topup) });
        return json(result);
      }
      if (path[1] && path[2] === "reject") {
        const topup = await billingCommands.rejectCreditTopup({ topupId: path[1], ownerUserId: actor.actorId, reviewNote: requiredString(body.reviewNote, "reviewNote"), confirmedReceivedAmountUnits: body.confirmedReceivedAmountUnits == null ? null : requiredInteger(body.confirmedReceivedAmountUnits, "confirmedReceivedAmountUnits") });
        await auditSuccessAsync(application.audit, { actor, source: "owner", requestId: audit.requestId, action: "credit_topup.reject", resource: { resourceType: "credit_topup", resourceId: topup.id }, metadata: creditTopupAuditMetadata(topup) });
        return json(topup);
      }
      if (path[1] && path[2] === "reverse") {
        if (!billingApplication) throw new RelayError("billing_commerce_application_unavailable", "Billing/Commerce application service is unavailable", 503);
        const result = await billingApplication.reverseCreditTopup({ topupId: path[1], ownerUserId: actor.actorId, reversalReason: requiredString(body.reversalReason, "reversalReason"), requestId: audit.requestId });
        return json(result);
      }
      if (path[1] && path[2] === "refund-note") {
        const topup = await billingCommands.recordCreditTopupRefundNote({ topupId: path[1], ownerUserId: actor.actorId, refundNote: requiredString(body.refundNote, "refundNote") });
        await auditSuccessAsync(application.audit, { actor, source: "owner", requestId: audit.requestId, action: "credit_topup.refund_note.record", resource: { resourceType: "credit_topup", resourceId: topup.id }, metadata: creditTopupAuditMetadata(topup) });
        return json(topup);
      }
      throw new RelayError("owner_direct_topup_removed", "Use credit grant for operational credit; paid topups must be created by users from a listing", 405);
    }
    if (resource === "credit-ledger-events") {
      if (request.method !== "POST") throw new RelayError("invalid_credit_ledger_mutation", "Credit ledger events can be created with POST", 405);
      const input = {
        scopeRef: requiredRuntimeScopeRef(body.scopeRef, "scopeRef"),
        eventType: normalizeCreditLedgerEventType(body.eventType),
        amountUnits: requiredInteger(body.amountUnits, "amountUnits"),
        actorUserId: actor.actorId,
        reason: requiredString(body.reason, "reason"),
        relatedEventId: body.relatedEventId ? String(body.relatedEventId) : null
      } as const;
      const result = await billingCommands.createAdminCreditLedgerEvent(input);
      const auditInput = {
        actor,
        source: "owner",
        requestId: audit.requestId,
        action: "credit_ledger_event.create",
        resource: { resourceType: "credit_ledger_event", resourceId: result.ledgerEvent.id },
        metadata: { scopeRef: result.account.scopeRef, accountId: result.account.id, eventType: result.ledgerEvent.eventType, amountUnits: result.ledgerEvent.amountUnits, relatedEventId: result.ledgerEvent.relatedEventId }
      } as const;
      {
        await auditSuccessAsync(application.audit, auditInput);
        return json({ ...result.ledgerEvent, account: result.account, balance: await billingQueries.getCreditAccountBalance(result.account.id) });
      }
    }
    if (resource === "providers" && path[1] === "reconcile-status" && request.method === "POST") {
      const management = new AsyncProviderManagementService(application.queries, application.commands, application.modelAccess.providers, application.modelAccessQueries, application.audit);
      return json(await management.reconcileVisible(providerBindingRefreshItems(body.items), { actor: audit.actor, source: "owner", requestId: audit.requestId, privateProviderOrigin: process.env.FRIDAY_RELAY_PRIVATE_PROVIDER_ORIGIN }));
    }
    if (resource === "providers" && path[1]) {
      const managementContext = { actor: audit.actor, source: "owner" as const, requestId: audit.requestId, privateProviderOrigin: process.env.FRIDAY_RELAY_PRIVATE_PROVIDER_ORIGIN };
      {
        const management = new AsyncProviderManagementService(application.queries, application.commands, application.modelAccess.providers, application.modelAccessQueries, application.audit);
        if (path[2] === "credential" && request.method === "POST") return json(await management.saveCredential(path[1], body, managementContext));
        if (path[2] === "credential" && request.method === "DELETE") return json(await management.clearCredential(path[1], managementContext));
        if (path[2] === "reconcile" && request.method === "POST") return json(await management.reconcile(path[1], managementContext));
        if (path[2] === "sync-models") return json(await management.syncModels(path[1], managementContext));
        if (path[2] === "oauth" && path[3] === "start") return json(await management.startOAuth(path[1], managementContext));
        if (path[2] === "oauth" && path[3] === "callback") return json(await management.submitOAuthCallback(path[1], body, managementContext));
      }
    }
    if (resource === "providers") return json(await mutProviderPostgres(request.method, application.queries, application.commands, application.modelAccess, application.modelAccessQueries, application.audit, body, audit.actor, audit.requestId));
    if (resource === "provider-models") {
      const providerId = String(body.providerId ?? "").trim();
      const providerModelName = String(body.providerModelName ?? "").trim();
      const modelAudit = { actor, source: "owner" as const, requestId: audit.requestId };
      if (request.method === "POST") {
        return json(await application.modelAccess.providers.registerProviderModel(
          providerId,
          providerModelName,
          String(body.displayName ?? providerModelName),
          modelAudit,
        ));
      }
      if (request.method === "PATCH") {
        const status = body.status === undefined ? undefined : normalizeProviderModelStatus(body.status);
        return json(await application.modelAccess.providers.changeProviderModel(providerId, providerModelName, {
          ...(body.displayName === undefined ? {} : { displayName: String(body.displayName) }),
          ...(status === undefined ? {} : { status }),
        }, modelAudit));
      }
      throw new RelayError("invalid_provider_model_mutation", "Provider models can be registered with POST or updated with PATCH", 405);
    }
    if (resource === "provider-model-costs") {
      if (request.method === "PATCH") {
        rejectLegacyPlanBudgetBindings(body);
        const id = requiredString(body.id, "id");
        const price = await application.commands.updateProviderModelCostStatus(id, normalizePriceStatus(body.status));
        if (!price) throw new RelayError("provider_model_cost_not_found", `Provider model cost ${id} not found`, 404);
        const auditInput = { actor, source: "owner" as const, requestId: audit.requestId, action: "provider_model_cost.update", resource: { resourceType: "provider_model_cost", resourceId: price.id }, metadata: { providerId: price.providerId, providerModelName: price.providerModelName, status: price.status } } as const;
        await auditSuccessAsync(application.audit, auditInput);
        return json(price);
      }
      if (request.method !== "POST") throw new RelayError("invalid_provider_model_cost_mutation", "Provider model costs can be created with POST or status-updated with PATCH", 405);
      const priceInput = {
        providerId: requiredString(body.providerId, "providerId"),
        providerModelName: requiredString(body.providerModelName, "providerModelName"),
        inputPer1M: requiredNumber(body.inputPer1M, "inputPer1M"),
        cachedInputPer1M: requiredNumber(body.cachedInputPer1M, "cachedInputPer1M"),
        cacheWritePer1M: cacheWritePriceNumber(body.cacheWritePer1M, body.inputPer1M, "cacheWritePer1M"),
        outputPer1M: requiredNumber(body.outputPer1M, "outputPer1M"),
        tiers: body.tiers === undefined ? [] : requiredPriceTiers(body.tiers, "tiers"),
        source: "fixed-admin"
      };
      const price = await application.commands.createProviderModelCost(priceInput);
      const auditInput = { actor, source: "owner" as const, requestId: audit.requestId, action: "provider_model_cost.create", resource: { resourceType: "provider_model_cost", resourceId: price.id }, metadata: { providerId: price.providerId, providerModelName: price.providerModelName, source: price.source } } as const;
      await auditSuccessAsync(application.audit, auditInput);
      return json(price);
    }
    if (resource === "access-point-prices") {
      if (request.method === "PATCH") {
        const id = requiredString(body.id, "id");
        const price = await application.commands.updateAccessPointPriceStatus(id, normalizePriceStatus(body.status));
        if (!price) throw new RelayError("access_point_price_not_found", `AccessPoint price ${id} not found`, 404);
        const auditInput = { actor, source: "owner" as const, requestId: audit.requestId, action: "access_point_price.update", resource: { resourceType: "access_point_price", resourceId: price.id }, metadata: { accessPointId: price.accessPointId, status: price.status } } as const;
        await auditSuccessAsync(application.audit, auditInput);
        return json(price);
      }
      if (request.method !== "POST") throw new RelayError("invalid_access_point_price_mutation", "AccessPoint prices can be created with POST or status-updated with PATCH", 405);
      const priceInput = {
        accessPointId: requiredString(body.accessPointId, "accessPointId"),
        inputPer1M: requiredNumber(body.inputPer1M, "inputPer1M"),
        cachedInputPer1M: requiredNumber(body.cachedInputPer1M, "cachedInputPer1M"),
        cacheWritePer1M: cacheWritePriceNumber(body.cacheWritePer1M, body.inputPer1M, "cacheWritePer1M"),
        outputPer1M: requiredNumber(body.outputPer1M, "outputPer1M"),
        tiers: body.tiers === undefined ? [] : requiredPriceTiers(body.tiers, "tiers")
      };
      const price = await application.commands.createAccessPointPrice(priceInput, { actor, source: "owner", requestId: audit.requestId });
      return json(price);
    }
    if (resource === "plan-access-point-prices") {
      if (request.method === "PATCH") {
        const id = requiredString(body.id, "id");
        const price = await application.commands.updatePlanAccessPointPriceStatus(id, normalizePriceStatus(body.status));
        if (!price) throw new RelayError("plan_access_point_price_not_found", `Plan AccessPoint price ${id} not found`, 404);
        const auditInput = { actor, source: "owner" as const, requestId: audit.requestId, action: "plan_access_point_price.update", resource: { resourceType: "plan_access_point_price", resourceId: price.id }, metadata: { planId: price.planId, accessPointId: price.accessPointId, status: price.status } } as const;
        await auditSuccessAsync(application.audit, auditInput);
        return json(price);
      }
      if (request.method !== "POST") throw new RelayError("invalid_plan_access_point_price_mutation", "Plan AccessPoint prices can be created with POST or status-updated with PATCH", 405);
      const priceInput = {
        planId: requiredString(body.planId, "planId"),
        accessPointId: requiredString(body.accessPointId, "accessPointId"),
        inputPer1M: requiredNumber(body.inputPer1M, "inputPer1M"),
        cachedInputPer1M: requiredNumber(body.cachedInputPer1M, "cachedInputPer1M"),
        cacheWritePer1M: cacheWritePriceNumber(body.cacheWritePer1M, body.inputPer1M, "cacheWritePer1M"),
        outputPer1M: requiredNumber(body.outputPer1M, "outputPer1M"),
        tiers: body.tiers === undefined ? [] : requiredPriceTiers(body.tiers, "tiers")
      };
      const price = await application.commands.createPlanAccessPointPrice(priceInput);
      const auditInput = { actor, source: "owner" as const, requestId: audit.requestId, action: "plan_access_point_price.create", resource: { resourceType: "plan_access_point_price", resourceId: price.id }, metadata: { planId: price.planId, accessPointId: price.accessPointId } } as const;
      await auditSuccessAsync(application.audit, auditInput);
      return json(price);
    }
    if (resource === "api-test" && path[1] === "curl") {
      assertProductionHttps(request, config, "Copy curl command");
      const result = await buildRelayApiTestCurlAsync(application.queries, application.audit, asyncTenancy.identity, body, audit.actor, audit.requestId);
      return json(result, {
        headers: { "cache-control": "private, no-store", pragma: "no-cache" }
      });
    }
    if (resource === "api-test") {
      {
        return json(await runRelayApiTestAsync(
          application.queries,
          application.audit,
          asyncTenancy.identity,
          asyncTenancy.tenancy,
          body,
          audit.actor,
          audit.requestId,
          request.signal,
          createAsyncAbuseGuard({
            queries: application.queries,
            commands: application.commands,
            config,
            source: "admin",
          }).canonicalClientIp(request.headers)
        ));
      }
    }
    if (resource === "access-resolution" && path[1] === "preview") {
      const apiKey = body.apiKeyId
        ? await asyncTenancy.identity.getApiKey(String(body.apiKeyId))
        : (await asyncTenancy.identity.listApiKeys()).find((key) => key.userId === body.userId);
      const user = apiKey
        ? await asyncTenancy.identity.getUser(apiKey.userId)
        : body.userId
          ? await asyncTenancy.identity.getUser(String(body.userId))
          : undefined;
      if (!apiKey || !user) throw new RelayError("preview_principal_required", "Access resolution preview requires apiKeyId or a user with an API key", 400);
      const effectiveScopes = await asyncTenancy.tenancy.listEffectiveSubscriptionScopesForUser(user.id);
      const options = body.accessPointId
        ? { accessPointId: String(body.accessPointId), bypassVisibility: true, allowUnavailable: true }
        : { bypassVisibility: true, allowUnavailable: true };
      const reqModel = String(body.reqModel ?? body.model ?? "*");
      const metadata = { routePattern: "/api/owner/access-resolution/preview", apiKeyId: apiKey.id, userId: user.id, effectiveScopeCount: effectiveScopes.length, reqModel, accessPointId: body.accessPointId ? String(body.accessPointId) : null };
      const result = await asyncAccessResolution.explain({ apiKey, user, effectiveScopes }, reqModel, options).catch(async (error: unknown) => {
        await application.audit.record({ actor, source: "owner", requestId: audit.requestId, action: "access_resolution.preview", resourceType: "access_resolution", resourceId: apiKey.id, result: "failure", metadata: { ...metadata, errorCode: error instanceof RelayError ? error.code : "internal_error" } });
        throw error;
      });
      await application.audit.record({ actor, source: "owner", requestId: audit.requestId, action: "access_resolution.preview", resourceType: "access_resolution", resourceId: apiKey.id, result: "success", metadata });
      return json({
        ...result,
        actor: { actorType: audit.actor.actorType, actorId: audit.actor.actorId },
        principal: { apiKeyId: apiKey.id, userId: user.id, effectiveScopes }
      });
    }
    if (resource === "access-points") {
      try {
        return json(await mutAccessPointPostgres(request.method, application.modelAccess, application.modelAccessQueries, application.billing, body, audit.actor, audit.requestId, request.headers.get("idempotency-key")));
      } catch (error) {
        if (request.method === "POST") {
          await application.audit.record({
            actor, source: "owner", requestId: audit.requestId,
            action: "access_point.create", resourceType: "access_point", resourceId: "pending",
            result: error instanceof RelayError && (error.status === 401 || error.status === 403) ? "denied" : "failure",
            metadata: { scopeRef: typeof body.scopeRef === "string" ? body.scopeRef : "global:", errorCode: error instanceof RelayError ? error.code : "internal_error" },
          });
        }
        throw error;
      }
    }
    if (resource === "access-point-visibility-grants") throw new RelayError("access_point_visibility_grants_removed", "AccessPoint visibility grants were removed; use access_points.scopeRef", 410);
    if (resource === "budgets") {
      if (request.method === "PATCH") {
        const id = requiredString(body.id, "id");
        const policyInput = {
          ...(body.metric !== undefined ? { metric: normalizeBudgetMetric(body.metric) } : {}),
          ...(body.limitValue !== undefined ? { limitValue: requiredNumber(body.limitValue, "limitValue") } : {}),
          ...(body.windowType !== undefined ? { windowType: normalizeBudgetWindowType(body.windowType) } : {}),
          ...(Object.prototype.hasOwnProperty.call(body, "windowSeconds") ? { windowSeconds: nullableNumber(body.windowSeconds) } : {}),
          ...(body.status !== undefined ? { status: String(body.status) } : {})
        };
        const policy = await application.commands.updateBudgetPolicy(id, policyInput);
        if (!policy) throw new RelayError("budget_policy_not_found", `Budget policy ${id} not found`, 404);
        const auditInput = { actor, source: "owner" as const, requestId: audit.requestId, action: "budget_policy.update", resource: { resourceType: "budget_policy", resourceId: policy.id }, metadata: { metric: policy.metric, limitValue: policy.limitValue, windowType: policy.windowType, windowSeconds: policy.windowSeconds, status: policy.status } } as const;
        await auditSuccessAsync(application.audit, auditInput);
        return json(policy);
      }
      if (request.method === "DELETE") {
        const id = requiredString(body.id, "id");
        const deleted = await application.commands.deleteBudgetPolicy(id);
        const auditInput = { actor, source: "owner" as const, requestId: audit.requestId, action: "budget_policy.delete", resource: { resourceType: "budget_policy", resourceId: id }, metadata: { id } } as const;
        if (deleted) await auditSuccessAsync(application.audit, auditInput);
        return json({ deleted });
      }
      if (request.method !== "POST") throw new RelayError("invalid_budget_policy_mutation", "Budget policies can be created, updated, or deleted", 405);
      const policyInput = {
        metric: normalizeBudgetMetric(body.metric),
        limitValue: requiredNumber(body.limitValue, "limitValue"),
        windowType: normalizeBudgetWindowType(body.windowType),
        windowSeconds: nullableNumber(body.windowSeconds),
        ...(body.status ? { status: String(body.status) } : {})
      };
      const policy = await application.commands.createBudgetPolicy(policyInput);
      const auditInput = { actor, source: "owner" as const, requestId: audit.requestId, action: "budget_policy.create", resource: { resourceType: "budget_policy", resourceId: policy.id }, metadata: { metric: policy.metric, limitValue: policy.limitValue, windowType: policy.windowType, windowSeconds: policy.windowSeconds, status: policy.status } } as const;
      await auditSuccessAsync(application.audit, auditInput);
      return json(policy);
    }
    if (resource === "scope-budget-policies") {
      if (request.method === "PATCH") {
        const id = requiredString(body.id, "id");
        const assignmentInput = {
          ...(body.scopeRef !== undefined ? { scopeRef: requiredString(body.scopeRef, "scopeRef") as ScopeRef } : {}),
          ...(body.budgetPolicyId !== undefined ? { budgetPolicyId: requiredString(body.budgetPolicyId, "budgetPolicyId") } : {}),
          ...(body.status !== undefined ? { status: String(body.status) } : {})
        };
        const assignment = await application.commands.updateScopeBudgetPolicyAssignment(id, assignmentInput);
        if (!assignment) throw new RelayError("scope_budget_policy_not_found", `Scope budget policy ${id} not found`, 404);
        const auditInput = { actor, source: "owner" as const, requestId: audit.requestId, action: "scope_budget_policy.update", resource: { resourceType: "scope_budget_policy", resourceId: assignment.id }, metadata: { scopeRef: assignment.scopeRef, budgetPolicyId: assignment.budgetPolicyId, status: assignment.status } } as const;
        await auditSuccessAsync(application.audit, auditInput);
        return json(assignment);
      }
      if (request.method === "DELETE") {
        const id = requiredString(body.id, "id");
        const deleted = await application.commands.deleteScopeBudgetPolicyAssignment(id);
        const auditInput = { actor, source: "owner" as const, requestId: audit.requestId, action: "scope_budget_policy.delete", resource: { resourceType: "scope_budget_policy", resourceId: id }, metadata: { id } } as const;
        if (deleted) await auditSuccessAsync(application.audit, auditInput);
        return json({ deleted });
      }
      if (request.method !== "POST") throw new RelayError("invalid_scope_budget_policy_mutation", "Direct scope budget policies can be assigned, updated, or deleted", 405);
      const assignmentInput = {
        scopeRef: requiredString(body.scopeRef, "scopeRef") as ScopeRef,
        budgetPolicyId: requiredString(body.budgetPolicyId, "budgetPolicyId"),
        ...(body.status ? { status: String(body.status) } : {})
      };
      const assignment = await application.commands.assignBudgetPolicyToScope(assignmentInput);
      const auditInput = { actor, source: "owner" as const, requestId: audit.requestId, action: "budget_policy.create", resource: { resourceType: "scope_budget_policy", resourceId: assignment.id }, metadata: { scopeRef: assignment.scopeRef, budgetPolicyId: assignment.budgetPolicyId, status: assignment.status } } as const;
      await auditSuccessAsync(application.audit, auditInput);
      return json(assignment);
    }
    if (resource === "governance-budgets") {
      if (request.method === "PATCH") {
        const id = requiredString(body.id, "id");
        const policyInput = {
          ...(body.metric !== undefined ? { metric: normalizeBudgetMetric(body.metric) } : {}),
          ...(body.limitValue !== undefined ? { limitValue: requiredNumber(body.limitValue, "limitValue") } : {}),
          ...(body.windowType !== undefined ? { windowType: normalizeBudgetWindowType(body.windowType) } : {}),
          ...(Object.prototype.hasOwnProperty.call(body, "windowSeconds") ? { windowSeconds: nullableNumber(body.windowSeconds) } : {}),
          ...(body.status !== undefined ? { status: String(body.status) } : {})
        };
        const policy = await application.commands.updateGovernanceBudgetPolicy(id, policyInput);
        if (!policy) throw new RelayError("governance_budget_policy_not_found", `Governance budget policy ${id} not found`, 404);
        const auditInput = { actor, source: "owner" as const, requestId: audit.requestId, action: "governance_budget_policy.update", resource: { resourceType: "governance_budget_policy", resourceId: policy.id }, metadata: { metric: policy.metric, limitValue: policy.limitValue, windowType: policy.windowType, windowSeconds: policy.windowSeconds, status: policy.status } } as const;
        await auditSuccessAsync(application.audit, auditInput);
        return json(policy);
      }
      if (request.method === "DELETE") {
        const id = requiredString(body.id, "id");
        const deleted = await application.commands.deleteGovernanceBudgetPolicy(id);
        const auditInput = { actor, source: "owner" as const, requestId: audit.requestId, action: "governance_budget_policy.delete", resource: { resourceType: "governance_budget_policy", resourceId: id }, metadata: { id } } as const;
        if (deleted) await auditSuccessAsync(application.audit, auditInput);
        return json({ deleted });
      }
      if (request.method !== "POST") throw new RelayError("invalid_governance_budget_policy_mutation", "Governance budget policies can be created, updated, or deleted", 405);
      const policyInput = {
        metric: normalizeBudgetMetric(body.metric),
        limitValue: requiredNumber(body.limitValue, "limitValue"),
        windowType: normalizeBudgetWindowType(body.windowType),
        windowSeconds: nullableNumber(body.windowSeconds),
        ...(body.status ? { status: String(body.status) } : {})
      };
      const policy = await application.commands.createGovernanceBudgetPolicy(policyInput);
      const auditInput = { actor, source: "owner" as const, requestId: audit.requestId, action: "governance_budget_policy.create", resource: { resourceType: "governance_budget_policy", resourceId: policy.id }, metadata: { metric: policy.metric, limitValue: policy.limitValue, windowType: policy.windowType, windowSeconds: policy.windowSeconds, status: policy.status } } as const;
      await auditSuccessAsync(application.audit, auditInput);
      return json(policy);
    }
    if (resource === "scope-governance-budget-policies") {
      if (request.method === "PATCH") {
        const id = requiredString(body.id, "id");
        const assignmentInput = {
          ...(body.scopeRef !== undefined ? { scopeRef: requiredGovernanceBudgetScopeRef(body.scopeRef, "scopeRef") } : {}),
          ...(body.governanceBudgetPolicyId !== undefined ? { governanceBudgetPolicyId: requiredString(body.governanceBudgetPolicyId, "governanceBudgetPolicyId") } : {}),
          ...(body.status !== undefined ? { status: String(body.status) } : {})
        };
        const assignment = await application.commands.updateScopeGovernanceBudgetPolicyAssignment(id, assignmentInput);
        if (!assignment) throw new RelayError("scope_governance_budget_policy_not_found", `Scope governance budget policy ${id} not found`, 404);
        const auditInput = { actor, source: "owner" as const, requestId: audit.requestId, action: "scope_governance_budget_policy.update", resource: { resourceType: "scope_governance_budget_policy", resourceId: assignment.id }, metadata: { scopeRef: assignment.scopeRef, governanceBudgetPolicyId: assignment.governanceBudgetPolicyId, status: assignment.status } } as const;
        await auditSuccessAsync(application.audit, auditInput);
        return json(assignment);
      }
      if (request.method === "DELETE") {
        const id = requiredString(body.id, "id");
        const deleted = await application.commands.deleteScopeGovernanceBudgetPolicyAssignment(id);
        const auditInput = { actor, source: "owner" as const, requestId: audit.requestId, action: "scope_governance_budget_policy.delete", resource: { resourceType: "scope_governance_budget_policy", resourceId: id }, metadata: { id } } as const;
        if (deleted) await auditSuccessAsync(application.audit, auditInput);
        return json({ deleted });
      }
      if (request.method !== "POST") throw new RelayError("invalid_scope_governance_budget_policy_mutation", "Governance budget policies can be assigned, updated, or deleted", 405);
      const assignmentInput = {
        scopeRef: requiredGovernanceBudgetScopeRef(body.scopeRef, "scopeRef"),
        governanceBudgetPolicyId: requiredString(body.governanceBudgetPolicyId, "governanceBudgetPolicyId"),
        ...(body.status ? { status: String(body.status) } : {})
      };
      const assignment = await application.commands.assignGovernanceBudgetPolicyToScope(assignmentInput);
      const auditInput = { actor, source: "owner" as const, requestId: audit.requestId, action: "scope_governance_budget_policy.create", resource: { resourceType: "scope_governance_budget_policy", resourceId: assignment.id }, metadata: { scopeRef: assignment.scopeRef, governanceBudgetPolicyId: assignment.governanceBudgetPolicyId, status: assignment.status } } as const;
      await auditSuccessAsync(application.audit, auditInput);
      return json(assignment);
    }
    if (resource === "plan-templates") {
      rejectLegacyPlanBudgetBindings(body);
      if (path[1] && path[2] === "replace-cards") {
        if (request.method !== "POST") throw new RelayError("invalid_plan_card_replacement_mutation", "Plan Cards can be replaced with POST", 405);
        const input = {
          sourcePlanId: path[1],
          targetPlanId: requiredString(body.targetPlanId, "targetPlanId"),
          ownerUserId: actor.actorId,
          requestId: audit.requestId
        } as const;
        return json(await billingCommands.replaceAvailablePlanCards(input));
      }
      if (request.method === "PATCH") {
        const id = requiredString(body.id, "id");
        const before = await authorityEntitlement.entitlement.getPlan(id);
        if (!before) throw new RelayError("plan_template_not_found", `Plan template ${id} not found`, 404);
        const input = {
          ...(body.name !== undefined ? { name: requiredString(body.name, "name") } : {}),
          ...(body.ownerId !== undefined ? { ownerId: requiredString(body.ownerId, "ownerId") } : {}),
          ...(body.scopeRef !== undefined ? { scopeRef: requiredRuntimeScopeRef(body.scopeRef, "scopeRef") } : {}),
          ...(body.version !== undefined ? { version: requiredNumber(body.version, "version") } : {}),
          ...(Object.prototype.hasOwnProperty.call(body, "description") ? { description: normalizeNullableDescription(body.description) } : {}),
          ...(Object.prototype.hasOwnProperty.call(body, "adminNote") ? { adminNote: normalizeNullableDescription(body.adminNote) } : {}),
          ...(body.billingMode !== undefined ? { billingMode: normalizePlanBillingMode(body.billingMode) } : {}),
          ...(body.purchaseAmount !== undefined ? { purchaseAmount: requiredNumber(body.purchaseAmount, "purchaseAmount") } : {}),
          ...(body.durationSeconds !== undefined ? { durationSeconds: requiredNumber(body.durationSeconds, "durationSeconds") } : {}),
          ...(body.status !== undefined ? { status: normalizePlanTemplateStatus(body.status) as "enabled" | "closed" | "disabled" } : {}),
          ...(body.catalogStatus !== undefined ? { catalogStatus: normalizePlanCatalogStatus(body.catalogStatus) } : {}),
          ...(body.budgetLimits !== undefined ? { budgetLimits: requiredPlanBudgetLimits(body.budgetLimits, "budgetLimits") } : {}),
          ...(body.accessPointIds !== undefined ? { accessPointIds: Array.isArray(body.accessPointIds) ? body.accessPointIds.map(String) : [] } : {}),
          ...(body.accessPointPriceOverrides !== undefined ? { accessPointPriceOverrides: requiredPlanAccessPointPriceOverrides(body.accessPointPriceOverrides, "accessPointPriceOverrides") } : {})
        };
        const revised = await authorityEntitlement.revisePlanDefinition(id, { ...input, actorUserId: actor.actorId, requestId: audit.requestId });
        const template = planTemplateCompatibility(revised.plan);
        return json({ ...template, statusImpact: { availableCardCount: revised.references.availableCardCount, activeOrFutureSubscriptionCount: revised.references.activeOrFutureSubscriptionCount } });
      }
      if (request.method === "DELETE") {
        const id = requiredString(body.id, "id");
        const result = await authorityEntitlement.retirePlanDefinition(id, { actorUserId: actor.actorId, requestId: audit.requestId });
        return json({ deleted: result.retired });
      }
      if (request.method !== "POST") throw new RelayError("invalid_plan_template_mutation", "Plan templates can be created, updated, or deleted", 405);
      const input = {
        ownerId: requiredString(body.ownerId ?? actor.actorId, "ownerId"),
        scopeRef: body.scopeRef !== undefined ? requiredRuntimeScopeRef(body.scopeRef, "scopeRef") : "global:",
        name: requiredString(body.name, "name"),
        description: normalizeNullableDescription(body.description),
        adminNote: normalizeNullableDescription(body.adminNote),
        billingMode: normalizePlanBillingMode(body.billingMode ?? "prepaid"),
        catalogStatus: normalizePlanCatalogStatus(body.catalogStatus ?? "unlisted"),
        purchaseAmount: body.purchaseAmount === undefined ? 0 : requiredNumber(body.purchaseAmount, "purchaseAmount"),
        durationSeconds: requiredNumber(body.durationSeconds, "durationSeconds"),
        budgetLimits: requiredPlanBudgetLimits(body.budgetLimits, "budgetLimits"),
        accessPointIds: Array.isArray(body.accessPointIds) ? body.accessPointIds.map(String) : [],
        accessPointPriceOverrides: body.accessPointPriceOverrides === undefined ? [] : requiredPlanAccessPointPriceOverrides(body.accessPointPriceOverrides, "accessPointPriceOverrides")
      };
      const template = authorityEntitlement
        ? planTemplateCompatibility(await authorityEntitlement.createPlanDefinition({ ...input, actorUserId: actor.actorId, requestId: audit.requestId }))
        : await testOnlyLegacyPlanCreate(application.commands, input);
      return json({ ...template, statusImpact: { availableCardCount: 0, activeOrFutureSubscriptionCount: 0 } });
    }
    if (resource === "plans") {
      if (request.method === "DELETE") {
        const id = requiredString(body.id, "id");
        const deleted = await authorityEntitlement.deletePlanSubscriptionCompatibility(id, { actorUserId: actor.actorId, requestId: audit.requestId });
        return json({ deleted });
      }
      if (request.method === "PATCH") {
        const id = requiredString(body.id, "id");
        if (body.action !== undefined) {
          const action = requiredString(body.action, "action");
          if (action !== "cancel") throw new RelayError("invalid_plan_subscription_action", `Unsupported Plan subscription action ${action}`, 400);
          const canceled = await authorityEntitlement.cancelPlanSubscription(id, { actorUserId: actor.actorId, requestId: audit.requestId });
          return json(planSubscriptionResponse(canceled));
        }
        const subscriptionInput = {
          ...(body.planTemplateId !== undefined ? { planId: requiredString(body.planTemplateId, "planTemplateId") } : {}),
          ...(body.planId !== undefined ? { planId: requiredString(body.planId, "planId") } : {}),
          ...(body.source !== undefined ? { source: String(body.source) } : {}),
          ...(body.scopeRef !== undefined ? { scopeRef: requiredString(body.scopeRef, "scopeRef") as ScopeRef } : {}),
          ...(Object.prototype.hasOwnProperty.call(body, "purchasedByUserId") ? { purchasedByUserId: body.purchasedByUserId ? String(body.purchasedByUserId) : null } : {}),
          ...(Object.prototype.hasOwnProperty.call(body, "fundingAccountId") ? { fundingAccountId: body.fundingAccountId ? String(body.fundingAccountId) : null } : {}),
          ...(body.priority !== undefined ? { priority: requiredNumber(body.priority, "priority") } : {}),
          ...(body.effectiveStart !== undefined ? { effectiveStart: String(body.effectiveStart) } : {}),
          ...(Object.prototype.hasOwnProperty.call(body, "effectiveEnd") ? { effectiveEnd: body.effectiveEnd ? String(body.effectiveEnd) : null } : {}),
          ...(body.status !== undefined ? { subscriptionLifecycle: normalizeSubscriptionLifecycle(body.status) } : {}),
          ...(body.subscriptionLifecycle !== undefined ? { subscriptionLifecycle: normalizeSubscriptionLifecycle(body.subscriptionLifecycle) } : {})
        };
        try {
          const subscription = await authorityEntitlement.revisePlanSubscriptionCompatibility(id, { ...subscriptionInput, actorUserId: actor.actorId, requestId: audit.requestId });
          return json(planSubscriptionResponse(subscription));
        } catch (error) {
          await auditFailureAsync(application.audit, {
            actor,
            source: "owner",
            requestId: audit.requestId,
            action: "plan_subscription.update",
            resource: { resourceType: "plan_subscription", resourceId: id },
            error,
          });
          throw error;
        }
      }
      if (request.method !== "POST") throw new RelayError("invalid_plan_mutation", "Plans can be created, updated, or deleted", 405);
      const paymentMode = normalizePlanSubscriptionPaymentMode(body.paymentMode);
      const units = requiredNumber(body.units, "units");
      if (!Number.isInteger(units) || units <= 0) throw new RelayError("invalid_plan_units", "Plan subscription units must be a positive integer", 400);
      const paymentAccountId = body.paymentAccountId === null ? null : requiredString(body.paymentAccountId, "paymentAccountId");
      const subscriptionUnitsInput = {
        planId: requiredString(body.planTemplateId, "planTemplateId"),
        scopeRef: requiredString(body.scopeRef, "scopeRef") as ScopeRef,
        units,
        source: body.source !== undefined ? String(body.source) : paymentMode === "charge_account" ? "balance_purchase" : "admin_grant",
        purchasedByUserId: body.purchasedByUserId ? String(body.purchasedByUserId) : actor.actorId,
        paymentAccountId,
        chargePurchaseAmount: paymentMode === "charge_account",
        ...(body.priority !== undefined ? { priority: requiredNumber(body.priority, "priority") } : {}),
        ...(body.effectiveStart ? { effectiveStart: String(body.effectiveStart) } : {})
      };
      const result = await authorityEntitlement.createPlanSubscriptionUnits({
        planId: subscriptionUnitsInput.planId,
        scopeRef: subscriptionUnitsInput.scopeRef,
        units: subscriptionUnitsInput.units,
        source: subscriptionUnitsInput.source,
        purchasedByUserId: subscriptionUnitsInput.purchasedByUserId,
        paymentMode,
        paymentAccountId: subscriptionUnitsInput.paymentAccountId,
        ...(subscriptionUnitsInput.priority === undefined ? {} : { priority: subscriptionUnitsInput.priority }),
        ...(subscriptionUnitsInput.effectiveStart === undefined ? {} : { effectiveStart: subscriptionUnitsInput.effectiveStart }),
        actorUserId: actor.actorId,
        requestId: audit.requestId,
      });
      return json({ items: result.subscriptions.map(planSubscriptionResponse), ledgerEventIds: result.ledgerEventIds, nextCursor: null });
    }
    if (resource === "external-price-lookup") {
      const providerId = String(body.providerId ?? "");
      const providerModelName = String(body.providerModelName ?? "");
      const source = String(body.source ?? "");
      try {
        const result = await externalPriceLookup(asyncExternalPricing, { requestId: audit.requestId, source, providerId, providerModelName });
        await application.audit.record({ actor, source: "owner", requestId: audit.requestId, action: "external_price.lookup", resourceType: "provider_model_cost", resourceId: `${providerId}:${providerModelName}`, result: "success", metadata: { providerId, providerModelName, routePattern: "/api/owner/external-price-lookup" } });
        return json(result);
      } catch (error) {
        await application.audit.record({ actor, source: "owner", requestId: audit.requestId, action: "external_price.lookup", resourceType: "provider_model_cost", resourceId: `${providerId}:${providerModelName}`, result: "failure", metadata: { providerId, providerModelName, routePattern: "/api/owner/external-price-lookup", errorCode: error instanceof RelayError ? error.code : "internal_error" } });
        throw error;
      }
    }
    throw new RelayError("not_found", "Owner resource not found", 404);
  });
}

async function externalPriceLookup(pricing: ExternalPriceLookupService, input: { requestId: string; source: string; providerId: string; providerModelName: string }) {
  const startedAt = Date.now();
  try {
    if (input.source === "openai-official-reference") return await pricing.lookupOpenAiReferencePrices();
    return await pricing.lookupExternal(input.providerId, input.providerModelName);
  } catch (error) {
    console.error("[admin] external price lookup failed", {
      requestId: input.requestId,
      routePattern: "/api/owner/external-price-lookup",
      source: input.source || null,
      providerId: input.providerId || null,
      providerModelName: input.providerModelName || null,
      status: error instanceof RelayError ? error.status : 500,
      code: error instanceof RelayError ? error.code : "internal_error",
      reason: error instanceof Error ? error.message : "External price lookup failed",
      elapsedMs: Date.now() - startedAt
    });
    throw error;
  }
}

async function mutProviderPostgres(
  method: string,
  queries: UiQueryPort,
  commands: UiCommandPort,
  modelAccess: ModelAccessCommandService,
  modelAccessQueries: ModelAccessManagementQueryService,
  audit: Pick<AuditCommands, "record">,
  body: Record<string, unknown>,
  actor: AuditActor,
  requestId: string,
) {
  if (method === "DELETE") {
    const id = String(body.id ?? "").trim();
    if (!id) throw new RelayError("invalid_provider", "Provider id is required", 400);
    return modelAccess.providers.removeProvider(id, { actor, source: "owner", requestId });
  }
  if (method !== "POST" && method !== "PATCH") throw new RelayError("invalid_provider_mutation", "Providers can be created with POST or updated with PATCH", 405);
  return new AsyncProviderManagementService(queries, commands, modelAccess.providers, modelAccessQueries, audit).mutate(method, body, { actor, source: "owner", requestId, privateProviderOrigin: process.env.FRIDAY_RELAY_PRIVATE_PROVIDER_ORIGIN });
}

async function runRelayApiTestAsync(
  queries: AsyncApiTestQueries,
  audit: AsyncApiTestCommands,
  identity: ApiTestIdentityQueries,
  tenancy: ApiTestTenancyQueries,
  body: Record<string, unknown>,
  actor: AuditActor,
  requestId: string,
  signal: AbortSignal,
  canonicalClientIp: { header: "x-real-ip" | "cf-connecting-ip"; value: string } | null
) {
  const principal = await resolveRelayTestPrincipalAsync(identity, tenancy, body);
  const apiType = apiTestTypeFromRequest(body.apiType);
  if (!apiType) throw new RelayError("invalid_api_test_type", "API type must be chat, responses, or messages", 400);
  const protocol = apiTestProtocol(apiType);
  let payload = normalizeRelayTestPayload(body.payload, apiType);
  const accessPointId = String(body.accessPointId ?? "").trim();
  const requestModel = accessPointId ? await requestModelFromAccessPointAsync(queries, accessPointId) : "";
  if (requestModel) payload = { ...payload, model: requestModel };
  const model = String(payload.model ?? "").trim();
  if (!model) throw new RelayError("invalid_api_test_payload", "Payload must include model or select an enabled AccessPoint", 400);
  const startedAt = Date.now();
  const response = await InternalGatewayClient.fromEnv().invoke({
    path: protocol.requestPath,
    apiKey: principal.apiKeyValue,
    payload,
    requestId,
    canonicalClientIp,
    signal
  });
  const result = {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    elapsedMs: Date.now() - startedAt,
    requestId: response.requestId ?? requestId,
    body: response.body,
    error: response.status >= 400 ? apiTestErrorFromBody(response.body, response.status) : null
  };
  await auditSuccessAsync(audit, {
    actor,
    source: "owner",
    requestId,
    action: "api_test.run",
    resource: { resourceType: "api_test", resourceId: principal.apiKey.id },
    metadata: { apiKeyId: principal.apiKey.id, userId: principal.user.id, effectiveScopeCount: principal.effectiveScopes.length, model, accessPointId: accessPointId || null, apiType, requestPath: protocol.requestPath, status: result.status, ok: result.ok, gatewayRequestId: result.requestId }
  });
  return result;
}

async function buildRelayApiTestCurlAsync(queries: AsyncApiTestQueries, audit: AsyncApiTestCommands, identity: ApiTestIdentityQueries, body: Record<string, unknown>, actor: AuditActor, requestId: string) {
  const apiKeyId = String(body.apiKeyId ?? "").trim();
  const apiKey = await identity.getApiKey(apiKeyId);
  if (!apiKey || apiKey.status !== "enabled") throw new RelayError("api_key_not_found", "Selected API key is not enabled or does not exist", 404);
  const apiType = apiTestTypeFromRequest(body.apiType);
  if (!apiType) throw new RelayError("invalid_api_test_type", "API type must be chat, responses, or messages", 400);
  const protocol = apiTestProtocol(apiType);
  let payload = normalizeRelayTestPayload(body.payload, apiType);
  const accessPointId = String(body.accessPointId ?? "").trim();
  const requestModel = accessPointId ? await requestModelFromAccessPointAsync(queries, accessPointId) : "";
  if (requestModel) payload = { ...payload, model: requestModel };
  const model = String(payload.model ?? "").trim();
  if (!model) throw new RelayError("invalid_api_test_payload", "Payload must include model or select an enabled AccessPoint", 400);
  const gatewayBaseUrl = normalizeApiTestGatewayBaseUrl(body.gatewayBaseUrl);
  const command = curlCommand(apiType, gatewayBaseUrl, apiKey.keyValue, JSON.stringify(payload, null, 2));
  await auditSuccessAsync(audit, {
    actor,
    source: "owner",
    requestId,
    action: "api_test.curl_copy",
    resource: { resourceType: "api_key", resourceId: apiKey.id },
    metadata: { apiKeyId: apiKey.id, userId: apiKey.userId, accessPointId: accessPointId || null, model, apiType, requestPath: protocol.requestPath }
  });
  return { command };
}

async function resolveRelayTestPrincipalAsync(identity: ApiTestIdentityQueries, tenancy: ApiTestTenancyQueries, body: Record<string, unknown>) {
  const manualKey = stripBearerPrefix(String(body.apiKey ?? "")).trim();
  const savedKey = manualKey ? await identity.findApiKeyByHash(sha256(manualKey)) : await identity.getApiKey(String(body.apiKeyId ?? "").trim());
  const apiKeyId = String(body.apiKeyId ?? "").trim();
  if (!manualKey && !apiKeyId) throw new RelayError("api_key_required", "Select a saved API key or paste a manual API key", 400);
  if (!savedKey || savedKey.status !== "enabled") throw new RelayError("api_key_not_found", "API key is not enabled or does not exist", 404);
  const user = await identity.getUser(savedKey.userId);
  if (!user) throw new RelayError("principal_not_found", "API key principal not found", 401);
  return { apiKey: savedKey, apiKeyValue: manualKey || savedKey.keyValue, user, effectiveScopes: await tenancy.listEffectiveSubscriptionScopesForUser(user.id) };
}

function normalizeRelayTestPayload(value: unknown, apiType: ApiTestType): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new RelayError("invalid_api_test_payload", "Payload must be a JSON object", 400);
  }
  const payload = value as Record<string, unknown>;
  const validationError = apiTestPayloadValidationError(apiType, payload);
  if (validationError) throw new RelayError("invalid_api_test_payload", validationError, 400);
  return payload;
}

async function requestModelFromAccessPointAsync(repo: Pick<UiQueryPort, "getAccessPoint">, accessPointId: string, visitedIds = new Set<string>()): Promise<string> {
  if (visitedIds.has(accessPointId)) return "";
  visitedIds.add(accessPointId);
  const accessPoint = await repo.getAccessPoint(accessPointId);
  if (!accessPoint || accessPoint.status !== "enabled") return "";
  return accessPoint.exposedModel;
}

function stripBearerPrefix(value: string): string {
  return value.replace(/^Bearer\s+/i, "");
}

function normalizeApiTestGatewayBaseUrl(value: unknown): string {
  const raw = String(value ?? "").trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new RelayError("invalid_api_test_gateway_url", "Gateway Base URL must be a valid HTTP or HTTPS URL", 400);
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== "/" && parsed.pathname !== "")) {
    throw new RelayError("invalid_api_test_gateway_url", "Gateway Base URL must be an HTTP or HTTPS origin without credentials, path, query, or fragment", 400);
  }
  return raw;
}

function apiTestErrorFromBody(body: unknown, status: number) {
  const extracted = extractErrorFields(body);
  return {
    code: extracted.code || (status >= 500 ? "provider_error" : "request_failed"),
    message: extracted.message || `Request failed with HTTP ${status}`,
    category: errorCategory(extracted.code, status)
  };
}

function extractErrorFields(body: unknown): { code: string; message: string } {
  if (!body || typeof body !== "object") return { code: "", message: "" };
  const record = body as Record<string, unknown>;
  const nested = record.error;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const error = nested as Record<string, unknown>;
    return {
      code: typeof error.code === "string" ? error.code : "",
      message: typeof error.message === "string" ? error.message : ""
    };
  }
  return {
    code: typeof record.code === "string" ? record.code : "",
    message: typeof record.message === "string" ? record.message : ""
  };
}

function errorCategory(code: string, status: number): string {
  if (code === "insufficient_credit_balance") return "credit_balance";
  if (code === "plan_subscription_unavailable") return "plan_budget";
  if (code === "plan_subscription_required") return "plan_required";
  if (code === "plan_entitlement_required") return "plan_entitlement";
  if (code.includes("budget")) return "budget";
  if (code.includes("rate_limit")) return "rate_limit";
  if (code.startsWith("provider_") || status >= 500) return "provider";
  if (code.includes("access_point")) return "access_point";
  return "request";
}

function apiKeyPlanSourceRestrictionInput(body: Record<string, unknown>): {
  mode: "all" | "restricted";
  sourceKeys: Array<{ planId: string; subscriptionScopeRef: import("@frely/core").ScopeRef }>;
  teamScopeRefs: import("@frely/core").ScopeRef[];
} {
  if (body.mode !== "all" && body.mode !== "restricted") throw new RelayError("api_key_plan_source_restriction_invalid", "mode must be all or restricted", 400);
  const sourceKeys = body.sourceKeys === undefined ? [] : body.sourceKeys;
  const teamScopeRefs = body.teamScopeRefs === undefined ? [] : body.teamScopeRefs;
  if (!Array.isArray(sourceKeys) || !Array.isArray(teamScopeRefs)) throw new RelayError("api_key_plan_source_restriction_invalid", "sourceKeys and teamScopeRefs must be arrays", 400);
  if (sourceKeys.some((value) => !value || typeof value !== "object" || typeof (value as Record<string, unknown>).planId !== "string" || typeof (value as Record<string, unknown>).subscriptionScopeRef !== "string")) {
    throw new RelayError("api_key_plan_source_restriction_invalid", "Each source key must include planId and subscriptionScopeRef", 400);
  }
  if (teamScopeRefs.some((value) => typeof value !== "string")) throw new RelayError("api_key_plan_source_restriction_invalid", "teamScopeRefs must contain strings", 400);
  return {
    mode: body.mode,
    sourceKeys: sourceKeys as Array<{ planId: string; subscriptionScopeRef: import("@frely/core").ScopeRef }>,
    teamScopeRefs: teamScopeRefs as import("@frely/core").ScopeRef[],
  };
}

function accessPointAuditMetadata(accessPoint: {
  ownerId: string;
  scopeRef: string;
  name: string;
  apiFamily: string;
  exposedModel: string;
  targetModel: string;
  targetType: string;
  targetId: string | null;
  targetProviderId: string | null;
  targetProviderModelName: string | null;
  status: string;
  description: string | null;
}) {
  return {
    ownerId: accessPoint.ownerId,
    scopeRef: accessPoint.scopeRef,
    name: accessPoint.name,
    apiFamily: accessPoint.apiFamily,
    exposedModel: accessPoint.exposedModel,
    targetModel: accessPoint.targetModel,
    targetType: accessPoint.targetType,
    targetId: accessPoint.targetId,
    targetProviderId: accessPoint.targetProviderId,
    targetProviderModelName: accessPoint.targetProviderModelName,
    status: accessPoint.status,
    descriptionLength: accessPoint.description ? [...accessPoint.description].length : 0
  };
}

async function mutAccessPointPostgres(method: string, modelAccess: ModelAccessCommandService, modelAccessQueries: ModelAccessManagementQueryService, billing: BillingCommands, body: Record<string, unknown>, actor: AuditActor, requestId: string, idempotencyKey: string | null) {
  if (method === "DELETE") {
    const id = String(body.id ?? "");
    if (!id) throw new RelayError("invalid_access_point", "AccessPoint id is required", 400);
    await modelAccess.removeAccessPoint(id, { actor, source: "owner", requestId });
    return { id, removed: true, deleted: false };
  }

  const ownerId = body.ownerId === undefined ? (method === "POST" ? actor.actorId : undefined) : String(body.ownerId);
  const scopeRef = String(body.scopeRef ?? (method === "POST" ? `user:${actor.actorId}` : "")) as ScopeRef;
  assertNoLegacyAccessPointFields(body);
  const routing = body.routing === undefined ? undefined : requiredAccessPointRouting(body.routing);
  const targetType = routing ? undefined : normalizeAccessPointTargetType(body.targetType);
  const targetId = String(body.targetId ?? "");
  const targetProviderId = String(body.targetProviderId ?? "");
  const exposedModel = requiredString(body.exposedModel, "exposedModel");
  const targetModel = requiredString(body.targetModel, "targetModel");
  const targetProviderModelName = String(body.targetProviderModelName ?? targetModel);
  const description = body.description === undefined ? undefined : normalizeAccessPointDescription(body.description);
  const resolvedRouting = routing ?? {
    selector: { id: "direct" as const, behaviorVersion: 1 as const, config: {} },
    targets: [{
      type: targetType!,
      targetAccessPointId: targetType === "access-point" ? targetId : null,
      targetProviderId: targetType === "provider-model" ? targetProviderId : null,
      targetProviderModelName: targetType === "provider-model" ? targetProviderModelName : null,
      position: 0,
      status: "enabled" as const,
    }],
  };
  const salePrice = priceInputFromBody(body.salePrice);
  const input = {
    ...(ownerId ? { ownerId } : {}), scopeRef, name: String(body.name ?? "Access Point"),
    ...(description === undefined ? {} : { description }),
    apiFamily: String(body.apiFamily ?? "openai-compatible"), exposedModel, targetModel,
    routing: resolvedRouting,
    priority: Number(body.priority ?? 100), weight: Number(body.weight ?? 1), fallbackOrder: Number(body.fallbackOrder ?? 100),
    ...(body.status !== undefined ? { status: String(body.status) } : method === "PATCH" ? {} : { status: "disabled" }),
  };
  if (method === "PATCH") {
    const id = String(body.id ?? "");
    if (!id) throw new RelayError("invalid_access_point", "AccessPoint id is required", 400);
    if (targetType === "access-point" && targetId === id) throw new RelayError("invalid_access_point", "AccessPoint cannot target itself", 400);
    if (routing?.targets.some((target) => target.type === "access-point" && target.targetAccessPointId === id)) throw new RelayError("invalid_access_point", "AccessPoint cannot target itself", 400);
    await modelAccess.changeAccessPoint(id, input, { actor, source: "owner", requestId });
    const result = await modelAccessQueries.getAccessPointWithRouting(id);
    if (!result) throw new RelayError("access_point_not_found", `AccessPoint ${id} not found`, 404);
    return result;
  }
  const createKey = idempotencyKey?.trim();
  if (!createKey) throw new RelayError("idempotency_key_required", "Idempotency-Key header is required", 400);
  const created = await modelAccess.createAccessPoint({ ...input, idempotencyKey: createKey, ownerId: ownerId ?? actor.actorId }, { actor, source: "owner", requestId });
  try {
    await billing.configureInitialAccessPointPrice(created.id, { price: salePrice }, { actor, source: "owner", requestId });
  } catch (error) {
    throw new RelayError("access_point_price_configuration_failed", `AccessPoint ${created.id} was created disabled, but its initial price was not configured. Retry the same create action with the same Idempotency-Key.`, 409, {
      accessPointId: created.id,
      pricingConfigured: false,
      retryAction: "retry_create_access_point_with_same_idempotency_key",
      errorCode: error instanceof RelayError ? error.code : "price_configuration_failed",
    });
  }
  const result = await modelAccessQueries.getAccessPointWithRouting(created.id);
  if (!result) throw new RelayError("access_point_not_found", `AccessPoint ${created.id} not found`, 404);
  return result;
}

function requiredAccessPointRouting(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RelayError("invalid_access_point_routing", "routing must be an object", 400);
  const routing = value as Record<string, unknown>;
  const selectorValue = routing.selector;
  if (!selectorValue || typeof selectorValue !== "object" || Array.isArray(selectorValue)) throw new RelayError("invalid_access_point_routing", "routing.selector must be an object", 400);
  const selector = selectorValue as Record<string, unknown>;
  if (!Array.isArray(routing.targets)) throw new RelayError("invalid_access_point_routing", "routing.targets must be an array", 400);
  return {
    selector: {
      id: requiredString(selector.id, "routing.selector.id") as "direct" | "ordered-fallback",
      behaviorVersion: requiredNumber(selector.behaviorVersion, "routing.selector.behaviorVersion") as 1,
      config: selector.config ?? {},
    },
    ...(routing.requestOverrides === undefined ? {} : { requestOverrides: routing.requestOverrides }),
    targets: routing.targets.map((value, position) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new RelayError("invalid_access_point_routing", `routing.targets[${position}] must be an object`, 400);
      const target = value as Record<string, unknown>;
      return {
        ...(target.id === undefined ? {} : { id: requiredString(target.id, `routing.targets[${position}].id`) }),
        type: normalizeAccessPointTargetType(target.type),
        targetAccessPointId: target.targetAccessPointId === undefined || target.targetAccessPointId === null ? null : String(target.targetAccessPointId),
        targetProviderId: target.targetProviderId === undefined || target.targetProviderId === null ? null : String(target.targetProviderId),
        targetProviderModelName: target.targetProviderModelName === undefined || target.targetProviderModelName === null ? null : String(target.targetProviderModelName),
        position: requiredNumber(target.position, `routing.targets[${position}].position`),
        status: target.status === "disabled" ? "disabled" as const : "enabled" as const,
      };
    }),
    ...(routing.routingRevision === undefined ? {} : { expectedRoutingRevision: requiredNumber(routing.routingRevision, "routing.routingRevision") }),
  };
}

function accessPointRoutingAuditMetadata(
  previous: Awaited<ReturnType<UiQueryPort["getAccessPointWithRouting"]>>,
  current: NonNullable<Awaited<ReturnType<UiQueryPort["getAccessPointWithRouting"]>>>,
) {
  const previousConfig = previous?.routing.selector.config && typeof previous.routing.selector.config === "object"
    ? Object.keys(previous.routing.selector.config as Record<string, unknown>)
    : [];
  const currentConfig = current.routing.selector.config && typeof current.routing.selector.config === "object"
    ? Object.keys(current.routing.selector.config as Record<string, unknown>)
    : [];
  const previousRequestOverrides = previous?.routing.requestOverrides ?? {};
  const currentRequestOverrides = current.routing.requestOverrides;
  return {
    id: current.id,
    selectorId: current.routing.selector.id,
    selectorBehaviorVersion: current.routing.selector.behaviorVersion,
    oldRoutingRevision: previous?.routing.routingRevision ?? null,
    newRoutingRevision: current.routing.routingRevision,
    descriptionChanged: previous?.description !== current.description,
    descriptionLength: current.description ? [...current.description].length : 0,
    targetEdgeIds: current.routing.targets.map((target) => target.id),
    changedConfigKeys: [...new Set([...previousConfig, ...currentConfig])].filter((key) =>
      JSON.stringify((previous?.routing.selector.config as Record<string, unknown> | undefined)?.[key])
      !== JSON.stringify((current.routing.selector.config as Record<string, unknown>)[key])),
    changedRequestOverrideKeys: [...new Set([
      ...Object.keys(previousRequestOverrides),
      ...Object.keys(currentRequestOverrides),
    ])].filter((key) =>
      JSON.stringify(previousRequestOverrides[key]) !== JSON.stringify(currentRequestOverrides[key])),
  };
}

function assertNoLegacyAccessPointFields(body: Record<string, unknown>) {
  for (const field of ["mode", "kind", "sourceModelListResolver", "sourceModelMatch", "aliasModel", "targetModelResolver"]) {
    if (Object.prototype.hasOwnProperty.call(body, field)) throw new RelayError("legacy_access_point_field_removed", `${field} is no longer accepted; use exposedModel and targetModel`, 400);
  }
}

function priceInputFromBody(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new RelayError("invalid_sale_price", "salePrice must be an object", 400);
  const price = value as Record<string, unknown>;
  return {
    inputPer1M: requiredNumber(price.inputPer1M, "salePrice.inputPer1M"),
    cachedInputPer1M: requiredNumber(price.cachedInputPer1M, "salePrice.cachedInputPer1M"),
    cacheWritePer1M: cacheWritePriceNumber(price.cacheWritePer1M, price.inputPer1M, "salePrice.cacheWritePer1M"),
    outputPer1M: requiredNumber(price.outputPer1M, "salePrice.outputPer1M"),
    tiers: price.tiers === undefined ? [] : requiredPriceTiers(price.tiers, "salePrice.tiers")
  };
}

async function providerModelCandidatesAsync(queries: ModelAccessManagementQueryService, providerId: string) {
  const provider = await queries.getProvider(providerId);
  if (!provider) throw new RelayError("provider_not_found", `Provider ${providerId} not found`, 404);
  const items = (await queries.listProviderModels({ providerIds: [provider.id], status: "enabled" }))
    .map((model) => ({ providerModelName: model.providerModelName, displayName: model.displayName ?? model.providerModelName }));
  return { providerId: provider.id, modelsResolver: provider.modelsResolver, items };
}

async function readSubscriptionDetailAsync(
  repo: Pick<UiQueryPort, "getPlanSubscription" | "isPlanSubscriptionUserEligible" | "listPlanSubscriptionBudgetUsage">,
  identity: Pick<import("@frely/identity/server").IdentityQueries, "getUser">,
  subscriptionId: string,
  targetUserId: string,
  at: string,
) {
  const subscription = await repo.getPlanSubscription(subscriptionId);
  if (!subscription) throw new RelayError("plan_subscription_not_found", "Plan Subscription not found", 404);
  if (targetUserId && !(await identity.getUser(targetUserId))) throw new RelayError("user_not_found", "Target user not found", 404);
  if (targetUserId && !(await repo.isPlanSubscriptionUserEligible(subscriptionId, targetUserId, at))) throw new RelayError("target_user_not_eligible", "Target user is not eligible for this Subscription", 409);
  const usage = (await repo.listPlanSubscriptionBudgetUsage([subscriptionId], targetUserId || null, at))[0];
  if (!usage) throw new RelayError("plan_subscription_not_found", "Plan Subscription not found", 404);
  return { subscription, usage, calculatedAt: at, targetUserId: targetUserId || null };
}

async function readSubscriptionOverviewAsync(
  repo: Pick<UiQueryPort, "countPlanSubscriptions" | "listPlanSubscriptions" | "listPlanSubscriptionBudgetUsage">,
  state: SubscriptionSearchState,
  at: string,
) {
  const filter = subscriptionFilter(state, at);
  const total = await repo.countPlanSubscriptions(filter);
  const totalPages = Math.max(1, Math.ceil(total / state.pageSize));
  const page = Math.min(state.page, totalPages);
  const subscriptions = await repo.listPlanSubscriptions(filter, state.pageSize, (page - 1) * state.pageSize);
  const usage = await repo.listPlanSubscriptionBudgetUsage(subscriptions.map(({ id }) => id), null, at);
  return { subscriptions, usage, page, pageSize: state.pageSize, total, totalPages, calculatedAt: at };
}

function normalizeAccessPointTargetType(value: unknown): AccessPointTargetType {
  if (value === "provider-model" || value === "access-point") return value;
  throw new RelayError("invalid_access_point_target", "AccessPoint targetType must be provider-model or access-point", 400);
}

function normalizeBudgetMetric(value: unknown): "amount" | "tokens" {
  if (value === "amount" || value === "tokens") return value;
  throw new RelayError("invalid_budget_metric", "Budget policy metric must be amount or tokens", 400);
}

function normalizeBudgetWindowType(value: unknown): "rolling" | "cumulative" {
  if (value === "rolling" || value === "cumulative") return value;
  throw new RelayError("invalid_budget_window_type", "Budget policy windowType must be rolling or cumulative", 400);
}

function nullableNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function ensureBillingCommerceRuntime(application: Awaited<ReturnType<typeof services>>["application"]): void {
  if (application.billingQueries && application.billingCommands) return;
  if (process.env.NODE_ENV === "test") {
    Object.assign(application, { billingQueries: application.queries, billingCommands: application.commands });
    return;
  }
  throw new RelayError("billing_commerce_service_unavailable", "Billing/Commerce service is unavailable", 503);
}

function requiredString(value: unknown, field: string): string {
  const text = String(value ?? "").trim();
  if (!text) throw new RelayError("invalid_model_price", `${field} is required`, 400);
  return text;
}

function requiredStringArray(value: unknown, field: string, max: number): string[] {
  if (!Array.isArray(value)) throw new RelayError("invalid_admin_grant_targets", `${field} must be an array`, 400);
  const result = [...new Set(value.map((item) => String(item ?? "").trim()).filter(Boolean))];
  if (!result.length || result.length > max) throw new RelayError("invalid_admin_grant_targets", `${field} must contain between 1 and ${max} users`, 400);
  return result;
}

function requiredScopeRef(value: unknown, field: string): ScopeRef {
  const scopeRef = requiredString(value, field);
  if (!isRuntimeScopeRef(scopeRef)) throw new RelayError("invalid_scope_ref", `${field} must be a runtime scope_ref`, 400);
  if (!scopeRef.startsWith("user:") && !scopeRef.startsWith("team:")) throw new RelayError("invalid_scope_ref", `${field} must be a user or team scope_ref`, 400);
  return scopeRef;
}

function normalizeResourcePermissionSubjectType(value: unknown): "user" | "team" | "team_role" | "member" {
  const subjectType = String(value ?? "").trim();
  if (subjectType === "user" || subjectType === "team" || subjectType === "team_role" || subjectType === "member") return subjectType;
  throw new RelayError("invalid_permission_subject_type", "Permission subjectType must be user, team, team_role, or member", 400);
}

function requiredGovernanceBudgetScopeRef(value: unknown, field: string): ScopeRef {
  const scopeRef = requiredString(value, field);
  if (!isRuntimeScopeRef(scopeRef)) throw new RelayError("invalid_scope_ref", `${field} must be a runtime scope_ref`, 400);
  if (scopeRef !== "global:" && !scopeRef.startsWith("team:") && !scopeRef.startsWith("user:")) {
    throw new RelayError("invalid_scope_ref", `${field} must be a global, team, or user scope_ref`, 400);
  }
  return scopeRef;
}

function requiredRuntimeScopeRef(value: unknown, field: string): ScopeRef {
  const scopeRef = requiredString(value, field);
  if (!isRuntimeScopeRef(scopeRef)) throw new RelayError("invalid_scope_ref", `${field} must be a runtime scope_ref`, 400);
  return scopeRef;
}

function normalizeCreditLedgerEventType(value: unknown): "grant" | "adjustment" | "reversal" {
  const eventType = String(value ?? "").trim();
  if (eventType === "grant" || eventType === "adjustment" || eventType === "reversal") return eventType;
  throw new RelayError("invalid_credit_ledger_event_type", "Credit ledger event type must be grant, adjustment, or reversal", 400);
}

function normalizeNullableDescription(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text || null;
}

function normalizePlanTemplateStatus(value: unknown): string {
  const status = String(value ?? "").trim();
  if (status === "enabled" || status === "active") return "enabled";
  if (status === "closed") return "closed";
  if (status === "disabled" || status === "archived") return "disabled";
  throw new RelayError("invalid_plan_status", "Plan template status must be enabled, closed, or disabled", 400);
}

function normalizePlanCatalogStatus(value: unknown): "listed" | "unlisted" {
  const status = String(value ?? "unlisted").trim();
  if (status === "listed" || status === "unlisted") return status;
  throw new RelayError("invalid_plan_catalog_status", "Plan catalog status must be listed or unlisted", 400);
}

function normalizePlanBillingMode(value: unknown): "prepaid" | "paygo" {
  const mode = String(value ?? "prepaid").trim().toLowerCase();
  if (mode === "prepaid" || mode === "included") return "prepaid";
  if (mode === "paygo" || mode === "pay_as_you_go" || mode === "pay-as-you-go") return "paygo";
  throw new RelayError("invalid_plan_billing_mode", "Plan billing mode must be prepaid or paygo", 400);
}

function requiredPlanBudgetLimits(value: unknown, field: string): PlanBudgetLimitInput[] {
  if (!Array.isArray(value)) throw new RelayError("invalid_plan_budget_limits", `${field} must be an array`, 400);
  const parsed = value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new RelayError("invalid_plan_budget_limit", `${field}[${index}] must be an object`, 400);
    const record = item as Record<string, unknown>;
    const allowed = new Set(["limitScope", "metric", "limitValue", "windowType", "windowSeconds"]);
    if (Object.keys(record).some((key) => !allowed.has(key))) throw new RelayError("invalid_plan_budget_limit", `${field}[${index}] contains an unknown field`, 400);
    return {
      limitScope: String(record.limitScope ?? "").trim() as PlanBudgetLimitInput["limitScope"],
      metric: String(record.metric ?? "").trim() as PlanBudgetLimitInput["metric"],
      limitValue: requiredNumber(record.limitValue, `${field}[${index}].limitValue`),
      windowType: String(record.windowType ?? "").trim() as PlanBudgetLimitInput["windowType"],
      windowSeconds: record.windowSeconds === null ? null : requiredNumber(record.windowSeconds, `${field}[${index}].windowSeconds`)
    };
  });
  return normalizePlanBudgetLimits(parsed);
}

function rejectLegacyPlanBudgetBindings(body: Record<string, unknown>): void {
  if (Object.prototype.hasOwnProperty.call(body, "budgetPolicyBindings")) {
    throw new RelayError("plan_budget_policy_bindings_removed", "budgetPolicyBindings was removed; use budgetLimits", 400);
  }
}

function positiveBindingRevision(value: string | null): number {
  if (!value || !/^[1-9]\d*$/u.test(value)) throw new RelayError("invalid_provider_oauth", "bindingRevision must be a positive integer", 400);
  const revision = Number(value);
  if (!Number.isSafeInteger(revision)) throw new RelayError("invalid_provider_oauth", "bindingRevision must be a positive integer", 400);
  return revision;
}

function normalizeProviderModelStatus(value: unknown): "enabled" | "disabled" {
  const status = String(value ?? "").trim();
  if (status === "enabled" || status === "disabled") return status;
  throw new RelayError("invalid_provider_model_status", "ProviderModel status must be enabled or disabled", 400);
}

function normalizePriceStatus(value: unknown): string {
  const status = String(value ?? "").trim();
  if (status === "enabled" || status === "active") return "enabled";
  if (status === "disabled" || status === "inactive") return "disabled";
  throw new RelayError("invalid_price_status", "Price status must be enabled or disabled", 400);
}

function normalizeSubscriptionLifecycle(value: unknown): "active" | "canceled" {
  if (value === "active" || value === "canceled") return value;
  throw new RelayError("invalid_plan_subscription_lifecycle", "Subscription lifecycle must be active or canceled", 400);
}

function normalizePlanSubscriptionPaymentMode(value: unknown): "admin_grant" | "charge_account" {
  const mode = String(value ?? "").trim();
  if (mode === "admin_grant") return "admin_grant";
  if (mode === "charge_account") return "charge_account";
  throw new RelayError("invalid_plan_payment_mode", "Plan payment mode must be admin_grant or charge_account", 400);
}

function planSubscriptionResponse(subscription: PlanSubscriptionSnapshot) {
  return {
    id: subscription.id,
    planTemplateId: subscription.planId,
    source: subscription.source,
    scopeRef: subscription.scopeRef,
    purchasedByUserId: subscription.purchasedByUserId,
    fundingAccountId: subscription.fundingAccountId,
    priority: subscription.priority,
    effectiveStart: subscription.effectiveStart,
    effectiveEnd: subscription.effectiveEnd ?? "9999-12-31T23:59:59.999Z",
    status: subscription.subscriptionLifecycle,
    createdAt: subscription.createdAt,
    updatedAt: subscription.updatedAt
  };
}

function applyRequestLogSearchFilters(filter: RequestLogListFilter, searchParams: URLSearchParams, options: { includeOwner: boolean }): void {
  const providerId = searchParams.get("providerId")?.trim();
  if (providerId) filter.providerId = providerId;
  const apiKeyId = searchParams.get("apiKeyId")?.trim();
  if (apiKeyId) filter.apiKeyId = apiKeyId;
  const model = searchParams.get("model")?.trim();
  if (model) filter.model = model.slice(0, 120);
  if (options.includeOwner) {
    const owner = searchParams.get("owner")?.trim() ?? "";
    if (owner.startsWith("user:")) filter.userId = owner.slice("user:".length);
    if (owner.startsWith("team:")) filter.teamId = owner.slice("team:".length);
  }
  applyRequestLogDurationFilter(filter, searchParams.get("duration")?.trim() ?? "");
}

type AdminRequestCaptureDownloadFilter = RequestLogListFilter & { startedAtGte: string; startedAtLte: string };

function adminRequestCaptureDownloadFilter(request: Request): AdminRequestCaptureDownloadFilter {
  const searchParams = new URL(request.url).searchParams;
  const rawStatus = searchParams.get("status")?.trim() ?? "";
  const status = normalizeRequestLogStatus(rawStatus);
  if (rawStatus && !status) throw new RelayError("invalid_request_capture_range", "status is invalid", 400);
  const duration = searchParams.get("duration")?.trim() ?? "";
  if (duration && !["open", "lt1s", "1s-5s", "5s-30s", "30s+"].includes(duration)) throw new RelayError("invalid_request_capture_range", "duration is invalid", 400);
  const owner = searchParams.get("owner")?.trim() ?? "";
  if (owner && !owner.startsWith("user:") && !owner.startsWith("team:")) throw new RelayError("invalid_request_capture_range", "owner is invalid", 400);
  const filter: RequestLogListFilter = { ...requiredTimeWindowFilter(searchParams) };
  if (status) filter.status = status;
  applyRequestLogSearchFilters(filter, searchParams, { includeOwner: true });
  return filter as AdminRequestCaptureDownloadFilter;
}

function adminRequestCaptureDownloadAuditMetadata(filter: AdminRequestCaptureDownloadFilter) {
  return {
    start: filter.startedAtGte,
    end: filter.startedAtLte,
    status: filter.status ?? "",
    apiKeyId: filter.apiKeyId ?? "",
    userId: filter.userId ?? "",
    teamId: filter.teamId ?? "",
    reqModel: filter.model ?? "",
    format: "tar"
  };
}

function requestCaptureStreamAuditHooksAsync(repo: Pick<AuditCommands, "record">, input: {
  actor: AuditActor;
  requestId: string;
  resourceId: string;
  routePattern: string;
  metadata: Readonly<Record<string, AuditMetadataValue>>;
}): RequestCaptureStreamHooks {
  const event = {
    actor: input.actor,
    source: "owner" as const,
    requestId: input.requestId,
    action: "request_capture.download" as const,
    resource: { resourceType: "request_capture" as const, resourceId: input.resourceId },
    metadata: { ...input.metadata, routePattern: input.routePattern }
  };
  return {
    onComplete: () => auditSuccessAsync(repo, event),
    onError: (error: unknown) => auditFailureAsync(repo, { ...event, error }),
    onCancel: () => auditFailureAsync(repo, { ...event, error: new RelayError("request_capture_download_aborted", "Request Capture download was aborted", 499) })
  };
}

function requestCaptureDownloadSlotHooksAsync(repo: Pick<UiCommandPort, "releaseRequestCaptureDownloadSlot">, slot: RequestCaptureDownloadSlot, hooks: RequestCaptureStreamHooks): RequestCaptureStreamHooks {
  let released = false;
  const release = async () => {
    if (released) return;
    await repo.releaseRequestCaptureDownloadSlot(slot);
    released = true;
  };
  return {
    onComplete: async () => { try { await hooks.onComplete?.(); } finally { await release(); } },
    onError: async (error) => { try { await hooks.onError?.(error); } finally { await release(); } },
    onCancel: async () => { try { await hooks.onCancel?.(); } finally { await release(); } }
  };
}

function downloadHeaders(contentType: string, filename: string): Record<string, string> {
  return {
    "content-type": contentType,
    "content-disposition": `attachment; filename="${filename}"`,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff"
  };
}

function requestCaptureJson(data: unknown): Response {
  return json(data, { headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
}

function requestCaptureTarFilename(startedAtGte: string, startedAtLte: string): string {
  const compact = (value: string) => value.replace(/[-:.]/g, "");
  return `friday-relay-request-captures-${compact(startedAtGte)}-${compact(startedAtLte)}.tar`;
}

function applyRequestLogDurationFilter(filter: RequestLogListFilter, duration: string): void {
  if (duration === "open") filter.durationOpen = true;
  if (duration === "lt1s") filter.durationMsLte = 999;
  if (duration === "1s-5s") {
    filter.durationMsGte = 1000;
    filter.durationMsLte = 5000;
  }
  if (duration === "5s-30s") {
    filter.durationMsGte = 5000;
    filter.durationMsLte = 30000;
  }
  if (duration === "30s+") filter.durationMsGte = 30000;
}

function normalizeRequestLogStatus(value: string): string {
  const normalized = value.trim().toLowerCase();
  return ["started", "pending", "completed", "failed"].includes(normalized) ? normalized : "";
}

function requiredTimeWindowFilter(searchParams: URLSearchParams): { startedAtGte: string; startedAtLte: string } {
  const start = searchParams.get("start")?.trim();
  const timeWindow = normalizeTimeWindow(searchParams.get("timeWindow") ?? "");
  if (!start) throw new RelayError("invalid_request_capture_range", "start is required", 400);
  if (!timeWindow) throw new RelayError("invalid_request_capture_range", "timeWindow is required", 400);
  const startedAtLte = dateParamToIso(start, "start");
  const duration = durationMs(timeWindow);
  if (duration <= 0) throw new RelayError("invalid_request_capture_range", "timeWindow must be 24h, 3d, 7d, 1mo, or a valid custom duration", 400);
  return { startedAtGte: new Date(Date.parse(startedAtLte) - duration).toISOString(), startedAtLte };
}

function dateParamToIso(value: string, field: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new RelayError("invalid_request_capture_range", `${field} must be a valid date`, 400);
  return date.toISOString();
}

function normalizeTimeWindow(value: string): string {
  const normalized = value.trim().toLowerCase();
  return durationMs(normalized) > 0 ? normalized : "";
}

function durationMs(value: string): number {
  if (value === "24h") return 24 * 60 * 60 * 1000;
  if (value === "3d") return 3 * 24 * 60 * 60 * 1000;
  if (value === "7d") return 7 * 24 * 60 * 60 * 1000;
  if (value === "1mo") return 31 * 24 * 60 * 60 * 1000;
  const match = value.match(/^(\d+(?:\.\d+)?)(m|h|d|w|mo)$/);
  if (!match) return 0;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  const unit = match[2];
  if (unit === "m") return amount * 60 * 1000;
  if (unit === "h") return amount * 60 * 60 * 1000;
  if (unit === "d") return amount * 24 * 60 * 60 * 1000;
  if (unit === "w") return amount * 7 * 24 * 60 * 60 * 1000;
  if (unit === "mo") return amount * 31 * 24 * 60 * 60 * 1000;
  return 0;
}

function requestLogArchiveUnavailable(error?: unknown): RelayError {
  if (error instanceof RelayError && error.code === "request_capture_archive_unavailable") return error;
  return new RelayError("request_capture_archive_unavailable", "Request Log archive is temporarily unavailable", 503);
}

function errorMessageFromBody(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const record = body as Record<string, unknown>;
  const error = record.error;
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string") return message;
  }
  const message = record.message;
  return typeof message === "string" ? message : "";
}

function requiredNumber(value: unknown, field: string): number {
  if (value === undefined || value === null || value === "") throw new RelayError("invalid_model_price", `${field} is required`, 400);
  const number = Number(value);
  if (!Number.isFinite(number)) throw new RelayError("invalid_model_price", `${field} must be a finite number`, 400);
  return number;
}

function cacheWritePriceNumber(value: unknown, fallbackInput: unknown, field: string): number | null {
  if (value === null) return null;
  return requiredNumber(value === undefined ? fallbackInput : value, field);
}

function creditTopupAuditMetadata(topup: {
  id: string;
  userId: string;
  scopeRef: string | null;
  creditAccountId: string | null;
  cardId?: string | null;
  useImmediately?: boolean | null;
  creditedAmountUnits: number;
  expectedPaymentAmountUnits: number;
  confirmedReceivedAmountUnits: number | null;
  productId: string;
  productListingId: string;
  paymentChannelId: string;
  paymentNetwork: string;
  paymentAsset: string;
  settlementMode: string;
  recipientIdentifierType: string;
  normalizedRecipientIdentifierHash: string;
  transactionReferenceType: string;
  normalizedTransactionReferenceHash: string | null;
  transactionReferenceTail: string | null;
  expiresAt: string;
  paymentSubmittedAt: string | null;
  ledgerEventId: string | null;
  reviewedByUserId: string | null;
}) {
  return {
    topupId: topup.id,
    userId: topup.userId,
    scopeRef: topup.scopeRef,
    creditAccountId: topup.creditAccountId,
    cardId: topup.cardId ?? null,
    useImmediately: topup.useImmediately ?? null,
    creditedAmountUnits: topup.creditedAmountUnits,
    expectedPaymentAmountUnits: topup.expectedPaymentAmountUnits,
    confirmedReceivedAmountUnits: topup.confirmedReceivedAmountUnits,
    productId: topup.productId,
    productListingId: topup.productListingId,
    paymentChannelId: topup.paymentChannelId,
    paymentNetwork: topup.paymentNetwork,
    paymentAsset: topup.paymentAsset,
    settlementMode: topup.settlementMode,
    recipientIdentifierType: topup.recipientIdentifierType,
    normalizedRecipientIdentifierHash: topup.normalizedRecipientIdentifierHash,
    transactionReferenceType: topup.transactionReferenceType,
    normalizedTransactionReferenceHash: topup.normalizedTransactionReferenceHash,
    transactionReferenceTail: topup.transactionReferenceTail,
    expiresAt: topup.expiresAt,
    paymentSubmittedAt: topup.paymentSubmittedAt,
    ledgerEventId: topup.ledgerEventId,
    reviewedByUserId: topup.reviewedByUserId
  };
}

async function storeCreditTopupAttachment(request: Request, storageRoot: string, topupId: string, uploadedByUserId: string, attachmentPurpose: "payment_evidence" | "admin_supplement", repo: Pick<UiQueryPort, "listCreditTopupAttachments"> & Pick<UiCommandPort, "createCreditTopupAttachment">) {
  const form = await readBoundedRequestFormData(request, 5 * 1024 * 1024 + 64 * 1024);
  const file = form.get("file");
  if (!(file instanceof File)) throw new RelayError("credit_topup_attachment_required", "file is required", 400);
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new RelayError("invalid_credit_topup_attachment_type", "Only jpeg, png, and webp images are supported", 400);
  if (file.size <= 0 || file.size > 5 * 1024 * 1024) throw new RelayError("invalid_credit_topup_attachment_size", "Attachment size must be between 1 byte and 5 MiB", 400);
  const bytes = Buffer.from(await file.arrayBuffer());
  if (!matchesImageContentType(bytes, file.type)) throw new RelayError("invalid_credit_topup_attachment_type", "Attachment content does not match its declared image type", 400);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const existingAttachments = await repo.listCreditTopupAttachments(topupId);
  const existing = existingAttachments.find((item) => item.sha256 === sha256 && item.attachmentPurpose === attachmentPurpose);
  if (existing) return existing;
  const extension = attachmentExtension(file.type);
  const id = `credit_topup_attachment_${randomBytes(16).toString("hex")}`;
  const storageKey = `${topupId}/${new Date().toISOString().replace(/[^0-9TZ]/g, "")}-${sha256.slice(0, 12)}-${id.slice(-8)}${extension}`;
  const path = privateStoragePath(creditTopupUploadDir(storageRoot), storageKey);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes, { flag: "wx" });
  try {
    return await repo.createCreditTopupAttachment({ id, topupId, storageKey, contentType: file.type, byteSize: file.size, sha256, uploadedByUserId, attachmentPurpose });
  } catch (error) {
    await rm(path, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function storePaymentChannelInstructionAttachment(request: Request, storageRoot: string, paymentChannelId: string, createdByUserId: string, repo: Pick<UiQueryPort, "listPaymentChannelInstructionAttachments"> & Pick<UiCommandPort, "createPaymentChannelInstructionAttachment">) {
  const form = await readBoundedRequestFormData(request, 5 * 1024 * 1024 + 64 * 1024);
  const file = form.get("file");
  if (!(file instanceof File)) throw new RelayError("payment_channel_instruction_attachment_required", "file is required", 400);
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size <= 0 || file.size > 5 * 1024 * 1024) throw new RelayError("invalid_payment_channel_instruction_attachment", "Instruction attachment must be a jpeg, png, or webp up to 5 MiB", 400);
  const bytes = Buffer.from(await file.arrayBuffer());
  if (!matchesImageContentType(bytes, file.type)) throw new RelayError("invalid_payment_channel_instruction_attachment", "Instruction attachment content does not match its declared image type", 400);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const existingAttachments = await repo.listPaymentChannelInstructionAttachments(paymentChannelId);
  const existing = existingAttachments.find((item) => item.sha256 === sha256);
  if (existing) return existing;
  const id = `payment_channel_attachment_${randomBytes(16).toString("hex")}`;
  const storageKey = `${paymentChannelId}/${new Date().toISOString().replace(/[^0-9TZ]/g, "")}-${sha256.slice(0, 12)}-${id.slice(-8)}${attachmentExtension(file.type)}`;
  const path = privateStoragePath(paymentChannelUploadDir(storageRoot), storageKey);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes, { flag: "wx" });
  try {
    return await repo.createPaymentChannelInstructionAttachment({ id, paymentChannelId, storageKey, contentType: file.type, byteSize: file.size, sha256, createdByUserId });
  } catch (error) {
    await rm(path, { force: true }).catch(() => undefined);
    throw error;
  }
}

function attachmentStorageRoot(config: { archive: { directory: string } }): string {
  return dirname(config.archive.directory);
}

function creditTopupUploadDir(storageRoot: string): string {
  return resolve(storageRoot, "admin-uploads", "credit-topups");
}

function paymentChannelUploadDir(storageRoot: string): string { return resolve(storageRoot, "admin-uploads", "payment-channels"); }

function privateStoragePath(baseDir: string, storageKey: string): string {
  const path = resolve(baseDir, storageKey);
  if (!path.startsWith(`${resolve(baseDir)}/`)) throw new RelayError("invalid_storage_key", "Invalid storage key", 500);
  return path;
}

function attachmentExtension(contentType: string): string {
  if (contentType === "image/jpeg") return ".jpg";
  if (contentType === "image/png") return ".png";
  if (contentType === "image/webp") return ".webp";
  return extname(contentType);
}

function sanitizeAttachmentFilename(filename: string): string {
  const sanitized = filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return sanitized || "receipt";
}

async function testOnlyLegacyPlanCreate<TInput, TResult>(postgres: { createPlanTemplate(input: TInput): Promise<TResult> | TResult }, input: TInput): Promise<TResult> {
  if (process.env.NODE_ENV !== "test") throw new Error("authority_entitlement_host_adapter_missing");
  return postgres.createPlanTemplate(input);
}

function planTemplateCompatibility(plan: PlanDefinitionSnapshot) {
  return { ...plan, status: plan.planStatus };
}

function ownerAuthorityProduct(product: AuthorityProductSnapshot) {
  return { ...product, purchaseAmountUnits: Number(product.purchaseAmountUnits) };
}

function authorityProductTerms(body: Record<string, unknown>): AuthorityProductTerms {
  const effectCode = requiredString(body.effectCode, "effectCode") as AuthorityProductTerms["effectCode"];
  const grantDurationSeconds = effectCode === "user_custom_provider_access"
    ? requiredInteger(body.grantDurationDays, "grantDurationDays") * 86_400
    : requiredInteger(body.grantDurationSeconds, "grantDurationSeconds");
  return {
    displayName: requiredString(body.displayName, "displayName"),
    effectCode,
    grantUnits: Number(body.grantUnits),
    purchaseAmountUnits: BigInt(requiredInteger(body.purchaseAmountUnits, "purchaseAmountUnits")),
    grantDurationSeconds,
    maxLifetimePurchasesPerUser: optionalNumber(body.maxLifetimePurchasesPerUser),
    maxUnconsumedUnitsPerUser: optionalNumber(body.maxUnconsumedUnitsPerUser),
    maxCurrentOwnedTeams: optionalNumber(body.maxCurrentOwnedTeams),
    maxLifetimeCreatedTeams: optionalNumber(body.maxLifetimeCreatedTeams),
    refundMode: requiredString(body.refundMode, "refundMode") as AuthorityProductTerms["refundMode"],
    refundDeadlineSeconds: optionalNumber(body.refundDeadlineSeconds),
    settlementHoldSeconds: Number(body.settlementHoldSeconds),
    sellerScopeRef: requiredString(body.sellerScopeRef, "sellerScopeRef") as ScopeRef
  };
}

function optionalNumber(value: unknown): number | null {
  return value === null || value === undefined || value === "" ? null : Number(value);
}

function requiredPlanAccessPointPriceOverrides(value: unknown, field: string): PlanAccessPointPriceOverrideInput[] {
  if (!Array.isArray(value)) throw new RelayError("invalid_plan_access_point_price", `${field} must be an array`, 400);
  return value.map((item, index) => {
    if (!item || typeof item !== "object") throw new RelayError("invalid_plan_access_point_price", `${field}[${index}] must be an object`, 400);
    const record = item as Record<string, unknown>;
    return {
      accessPointId: requiredString(record.accessPointId, `${field}[${index}].accessPointId`),
      inputPer1M: requiredNumber(record.inputPer1M, `${field}[${index}].inputPer1M`),
      cachedInputPer1M: requiredNumber(record.cachedInputPer1M, `${field}[${index}].cachedInputPer1M`),
      cacheWritePer1M: cacheWritePriceNumber(record.cacheWritePer1M, record.inputPer1M, `${field}[${index}].cacheWritePer1M`),
      outputPer1M: requiredNumber(record.outputPer1M, `${field}[${index}].outputPer1M`),
      tiers: record.tiers === undefined ? [] : requiredPriceTiers(record.tiers, `${field}[${index}].tiers`)
    };
  });
}

function requiredPriceTiers(value: unknown, field: string): PriceTierInput[] {
  if (!Array.isArray(value)) throw new RelayError("invalid_price_tiers", `${field} must be an array`, 400);
  return value.map((item, index) => {
    if (!item || typeof item !== "object") throw new RelayError("invalid_price_tiers", `${field}[${index}] must be an object`, 400);
    const record = item as Record<string, unknown>;
    return {
      ...(record.serviceTier !== undefined ? { serviceTier: String(record.serviceTier) } : {}),
      ...(record.tierKey !== undefined ? { tierKey: requiredString(record.tierKey, `${field}[${index}].tierKey`) } : {}),
      minInputTokens: requiredInteger(record.minInputTokens, `${field}[${index}].minInputTokens`),
      maxInputTokens: record.maxInputTokens === undefined || record.maxInputTokens === null ? null : requiredInteger(record.maxInputTokens, `${field}[${index}].maxInputTokens`),
      inputPer1M: requiredNumber(record.inputPer1M, `${field}[${index}].inputPer1M`),
      cachedInputPer1M: requiredNumber(record.cachedInputPer1M, `${field}[${index}].cachedInputPer1M`),
      cacheWritePer1M: cacheWritePriceNumber(record.cacheWritePer1M, record.inputPer1M, `${field}[${index}].cacheWritePer1M`),
      outputPer1M: requiredNumber(record.outputPer1M, `${field}[${index}].outputPer1M`)
    };
  });
}

function requiredInteger(value: unknown, field: string): number {
  const number = requiredNumber(value, field);
  if (!Number.isInteger(number)) throw new RelayError("invalid_integer", `${field} must be an integer`, 400);
  return number;
}

const PROVIDER_INVOCATION_EVIDENCE_KINDS = ["provider_operation_query", "provider_billing_record", "provider_response"] as const;
const PROVIDER_INVOCATION_FAILURE_CLASSES = ["connect_error", "timeout", "rate_limited", "upstream_5xx", "non_retryable"] as const;

function providerInvocationFinalEvidence(body: Record<string, unknown>): {
  evidenceKind: (typeof PROVIDER_INVOCATION_EVIDENCE_KINDS)[number];
  evidenceRef: string;
  outcome: "succeeded" | "failed" | "aborted";
  failureClass?: (typeof PROVIDER_INVOCATION_FAILURE_CLASSES)[number];
  outputCommitted: boolean;
  usage: InvocationUsageUnits;
} {
  const evidenceKind = PROVIDER_INVOCATION_EVIDENCE_KINDS.find((candidate) => candidate === body.evidenceKind);
  if (!evidenceKind) throw new RelayError("invalid_provider_reconciliation_evidence", "evidenceKind must identify a final Provider operation, billing record, or response", 400);
  const evidenceRef = String(body.evidenceRef ?? "").trim();
  if (!isSafeExternalEvidenceRef(evidenceRef)) {
    throw new RelayError("invalid_provider_reconciliation_evidence", "evidenceRef must be a bounded non-secret external reference", 400);
  }
  const outcome = body.outcome === "succeeded" || body.outcome === "failed" || body.outcome === "aborted" ? body.outcome : null;
  if (!outcome) throw new RelayError("invalid_provider_reconciliation_outcome", "outcome must be succeeded, failed, or aborted", 400);
  const failureClass = PROVIDER_INVOCATION_FAILURE_CLASSES.find((candidate) => candidate === body.failureClass);
  if (outcome === "failed" && !failureClass) throw new RelayError("invalid_provider_reconciliation_outcome", "failed reconciliation requires a failureClass", 400);
  if (outcome !== "failed" && body.failureClass !== undefined && body.failureClass !== null) {
    throw new RelayError("invalid_provider_reconciliation_outcome", "failureClass is only valid for a failed outcome", 400);
  }
  const outputCommitted = body.outputCommitted === undefined ? false : requiredBoolean(body.outputCommitted, "outputCommitted");
  const inputTokens = providerInvocationToken(body.inputTokens, "inputTokens");
  const cachedInputTokens = providerInvocationToken(body.cachedInputTokens, "cachedInputTokens");
  const cacheWriteTokens = providerInvocationToken(body.cacheWriteTokens, "cacheWriteTokens");
  const outputTokens = providerInvocationToken(body.outputTokens, "outputTokens");
  const totalTokens = providerInvocationToken(body.totalTokens, "totalTokens");
  if (totalTokens !== inputTokens + outputTokens || cachedInputTokens + cacheWriteTokens > inputTokens) {
    throw new RelayError("invalid_provider_reconciliation_usage", "Final usage token totals or input partitions are inconsistent", 400);
  }
  return {
    evidenceKind,
    evidenceRef,
    outcome,
    ...(failureClass ? { failureClass } : {}),
    outputCommitted,
    usage: {
      inputTokens,
      cachedInputTokens,
      cacheWriteTokens,
      outputTokens,
      totalTokens,
      source: evidenceKind === "provider_response" ? "response" : "provider",
    },
  };
}

function providerInvocationToken(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/u.test(value)) {
    throw new RelayError("invalid_provider_reconciliation_usage", `${field} must be a non-negative base-10 integer string`, 400);
  }
  const parsed = BigInt(value);
  if (parsed > 9_223_372_036_854_775_807n) throw new RelayError("invalid_provider_reconciliation_usage", `${field} is outside PostgreSQL BIGINT range`, 400);
  return parsed;
}

function ownerQueryPage(url: URL): number {
  return positiveQueryInteger(url.searchParams.get("page"), 1, 10_000);
}

function ownerQueryPageSize(url: URL, key = "pageSize") {
  const raw = url.searchParams.get(key);
  if (raw && (!/^\d+$/.test(raw) || normalizeDirectoryPageSize(Number(raw)) !== Number(raw))) {
    throw new RelayError("invalid_pagination", `${key} must be an integer from 1 to 200`, 400);
  }
  return normalizeDirectoryPageSize(raw ? Number(raw) : undefined);
}

function pageMetadata(page: { page: number; pageSize: number; total: number; totalPages: number }) {
  return { page: page.page, pageSize: page.pageSize, total: page.total, totalPages: page.totalPages };
}

function ownerRequestLogCursorFilter(request: Request): RequestLogListFilter {
  const params = new URL(request.url).searchParams;
  const ingress = params.get("ingressHostname");
  const ingressHostname = ingress === null ? undefined : normalizeAuthorityHostname(ingress);
  const cursor = params.get("cursor")?.trim();
  if (!cursor) return ingressHostname ? { ingressHostname } : {};
  const separator = cursor.lastIndexOf(":");
  if (separator <= 0 || separator >= cursor.length - 1) throw new RelayError("invalid_request_log_cursor", "Invalid Request Log cursor", 400);
  return { ...(ingressHostname ? { ingressHostname } : {}), cursorStartedAt: cursor.slice(0, separator), cursorId: cursor.slice(separator + 1) };
}

function requestLogCursorPage(rows: RequestLog[], pageSize: number) {
  const hasMore = rows.length > pageSize;
  const items = rows.slice(0, pageSize);
  const last = items.at(-1);
  return { items, pageSize, hasMore, nextCursor: hasMore && last ? `${last.startedAt}:${last.id}` : null };
}

function providerBindingRefreshItems(value: unknown): Array<{ providerId: string; expectedRevision: number }> {
  if (!Array.isArray(value)) throw new RelayError("provider_reconcile_batch_invalid", "Provider reconcile batch items are required", 400);
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new RelayError("provider_reconcile_batch_invalid", "Provider reconcile batch item is invalid", 400);
    const record = item as Record<string, unknown>;
    return { providerId: String(record.providerId ?? ""), expectedRevision: Number(record.expectedRevision) };
  });
}

function positiveQueryInteger(value: string | null, fallback: number, maximum: number): number {
  if (!value) return fallback;
  if (!/^\d+$/.test(value)) throw new RelayError("invalid_pagination", "Pagination values must be positive integers", 400);
  return Math.min(maximum, Math.max(1, Number(value)));
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new RelayError("invalid_boolean", `${field} must be a boolean`, 400);
  return value;
}

function csvField(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function planDirectoryStatus(value: string | null): "all" | "enabled" | "closed" | "disabled" {
  return value === "enabled" || value === "closed" || value === "disabled" ? value : "all";
}

async function pipelinePluginSettingViewsAsync(
  repo: Pick<UiQueryPort, "listPipelinePluginSettings">,
  identity: Pick<import("@frely/identity/server").IdentityQueries, "getUser">,
) {
  const settings = await repo.listPipelinePluginSettings([GLOBAL_PIPELINE_PLUGIN_SCOPE]);
  const settingsById = new Map(settings.map((setting) => [setting.pluginId, setting]));
  const updatedByIds = [...new Set(settings.map((setting) => setting.updatedByUserId).filter((id): id is string => Boolean(id)))];
  const users = new Map((await Promise.all(updatedByIds.map(async (id) => [id, await identity.getUser(id)] as const))).filter((entry): entry is readonly [string, NonNullable<typeof entry[1]>] => Boolean(entry[1])));
  return pipelinePluginRegistry().map((plugin) => {
    const setting = settingsById.get(plugin.manifest.id);
    const required = plugin.manifest.availability === "required" || !plugin.manifest.userToggleable;
    const updatedByUserId = setting?.updatedByUserId ?? null;
    return {
      id: plugin.manifest.id,
      desc: plugin.manifest.desc,
      apiVersion: plugin.manifest.apiVersion,
      behaviorVersion: plugin.manifest.behaviorVersion,
      configVersion: plugin.manifest.configVersion,
      availability: plugin.manifest.availability,
      userConfigurable: plugin.manifest.userConfigurable,
      userToggleable: plugin.manifest.userToggleable,
      phases: Object.freeze([...new Set(plugin.hooks.map((hook) => hook.phase))]),
      scopeRef: GLOBAL_PIPELINE_PLUGIN_SCOPE,
      enabled: required ? true : Boolean(setting?.enabled),
      config: setting ? asyncPluginObjectConfig(setting.configJson) : asyncPluginObjectConfig(plugin.defaultConfig),
      configUi: plugin.configUi,
      settingRevision: setting?.settingRevision ?? null,
      updatedAt: asyncPluginDate(setting?.updatedAt),
      updatedBy: updatedByUserId ? users.get(updatedByUserId)?.email ?? updatedByUserId : null,
    };
  });
}

async function ingressPluginSettingViewsAsync(
  repo: Pick<UiQueryPort, "listIngressPluginSettings">,
  identity: Pick<import("@frely/identity/server").IdentityQueries, "getUser">,
) {
  const settings = await repo.listIngressPluginSettings([GLOBAL_PLUGIN_SCOPE]);
  const settingsById = new Map(settings.map((setting) => [setting.pluginId, setting]));
  const updatedByIds = [...new Set(settings.map((setting) => setting.updatedByUserId).filter((id): id is string => Boolean(id)))];
  const users = new Map((await Promise.all(updatedByIds.map(async (id) => [id, await identity.getUser(id)] as const))).filter((entry): entry is readonly [string, NonNullable<typeof entry[1]>] => Boolean(entry[1])));
  return ingressPluginRegistry().map((plugin) => {
    const setting = settingsById.get(plugin.id);
    const updatedByUserId = setting?.updatedByUserId ?? null;
    return {
      id: plugin.id,
      desc: plugin.desc,
      version: plugin.version,
      scopeRef: GLOBAL_PLUGIN_SCOPE,
      enabled: setting ? Boolean(setting.enabled) : false,
      config: setting ? asyncPluginObjectConfig(setting.configJson) : plugin.defaultConfig,
      configUi: plugin.configUi,
      updatedAt: asyncPluginDate(setting?.updatedAt),
      updatedBy: updatedByUserId ? users.get(updatedByUserId)?.email ?? updatedByUserId : null,
    };
  });
}

function asyncPluginObjectConfig(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try { return asyncPluginObjectConfig(JSON.parse(value) as unknown); } catch { return {}; }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asyncPluginDate(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
