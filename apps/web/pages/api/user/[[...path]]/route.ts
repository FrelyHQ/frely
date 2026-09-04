import { createHash, randomBytes } from "node:crypto";
import type { AuditCommands, AuditMetadataValue } from "@frely/audit";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { isRuntimeScopeRef, matchesImageContentType, readBoundedRequestFormData, RelayError, requestIdFromHeaders, teamScopeRef, userScopeRef, type ScopeRef } from "@frely/core";
import type { AuthorityGrantQuotaSnapshot, AuthorityGrantSnapshot } from "@frely/authority";
import type { AuthorityProductSnapshot, AuthorityPurchaseSnapshot } from "@frely/billing/server";
import type { PersonalProviderEntitlementPeriodSnapshot, PersonalProviderSlotSnapshot, TeamProviderEntitlementSnapshot } from "@frely/entitlement";
import { AsyncProviderManagementService } from "@frely/providers";
import { actorFromClaims, auditDeniedAsync, auditFailureAsync, auditSuccessAsync, CreditCursorError, normalizeDirectoryPageSize, parseRequestCaptureView, prepareRequestCaptureDownload, queryRequestLogsAcrossStorageAsync, requestCaptureFileStream, requestCaptureTarStream, requestCaptureViewResponse, type UiCommandPort, type UiQueryPort, type AuditActor, type CreditTopupAttachment, type RequestCaptureDownloadSlot, type RequestCaptureStreamHooks, type RequestLog, type RequestLogListFilter } from "@frely/ui-application/server";
import { InternalGatewayClient } from "@frely/gateway-core";
import { createAsyncAbuseGuard } from "@frely/tenancy";
import { parseUserAccessDirectoryApiState } from "../../../../features/access/lib/user-access-url-state";
import { parseUserApiKeyDirectoryApiState } from "../../../../features/api-keys/lib/user-api-key-url-state";
import { parseCardInventoryApiState } from "../../../../features/cards/lib/cards-url-state";
import { bodyJson, handle, json, services } from "../../../../lib/server";
import { stripeClient } from "../../../../lib/stripe";
import { publicPersonalOAuthStart, publicPersonalOAuthStatus, publicPersonalProvider, publicPersonalProviderModel, publicPersonalProviderSlot } from "./personal-provider-public";

interface Context {
  params: Promise<{ path?: string[] }>;
}

export async function GET(request: Request, context: Context) {
  return handle(request, async () => {
    const { asyncTenancy, authorityEntitlement, application, requestCaptureClient, requestCaptureReader, requestLogArchiveReader, config } = await services();
    ensureBillingCommerceRuntime(application);
    const claims = await asyncTenancy.requireUser(request.headers);
    const actor = actorFromClaims(claims);
    const auditRequestId = requestIdFromHeaders(request.headers);
    const auditSuccessForBackend = async (input: Parameters<typeof auditSuccessAsync>[1]) => {
      await auditSuccessAsync(application.audit, input);
    };
    const auditFailureForBackend = async (input: Parameters<typeof auditFailureAsync>[1]) => {
      await auditFailureAsync(application.audit, input);
    };
    const auditDeniedForBackend = async (input: Parameters<typeof auditDeniedAsync>[1]) => {
      await auditDeniedAsync(application.audit, input);
    };
    const path = (await context.params).path ?? [];
    const resource = path[0] ?? "";
    if (resource === "authority-products") {
      const page = await authorityEntitlement.commerce.pageAuthorityProducts(queryPage(request), queryPageSize(request), true);
      return json({ ...page, items: page.items.map(publicAuthorityProduct) });
    }
    if (resource === "authority-grants") {
      return json(await authorityEntitlement.authority.pageUserGrants(claims.sub, queryPage(request), undefined, queryPageSize(request)));
    }
    if (resource === "team-provider-purchase-candidates") {
      const url = new URL(request.url);
      return json(await application.queries.searchTeamProviderPurchaseCandidates(claims.sub, url.searchParams.get("q") ?? "", queryPage(request)));
    }
    if (resource === "me") return json({ user: claims });
    if (resource === "card-inventory" && path.length === 1) {
      const state = cardInventoryApiState(request);
      const inventory = await application.billingQueries.pageUserCardInventory(claims.sub, state.page, undefined, state.pageSize, state.inventoryStatus);
      return json({
        ...inventory,
        viewerUserId: claims.sub,
        canSetReferenceCode: await application.queries.canUserSetCardReferenceCode(claims.sub),
      });
    }
    if (resource === "card-inventory" && path[1] === "plans" && path[2] && path.length === 3) {
      return json(
        await application.billingQueries.pageUserPlanCards(claims.sub, path[2], cardQueryPage(request), undefined, cardQueryPageSize(request)),
      );
    }
    if (resource === "card-transfers" && path.length === 1) {
      return json({
        ...(await application.billingQueries.pageUserCardTransfers(claims.sub, cardQueryPage(request), cardQueryPageSize(request))),
        viewerUserId: claims.sub,
      });
    }
    if (resource === "api-keys" && path[1] && path[2] === "plan-source-restriction" && path.length === 3) {
      const apiKey = await asyncTenancy.identity.getApiKey(path[1]);
      if (!apiKey || apiKey.userId !== claims.sub) throw new RelayError("api_key_not_found", "API key not found", 404);
      return json(await authorityEntitlement.entitlement.decideApiKeyPlanSourceRestriction(apiKey.id));
    }
    if (resource === "api-keys" && path[1] && path[2] === "plan-source-restriction" && path[3] === "candidates" && path.length === 4) {
      const apiKey = await asyncTenancy.identity.getApiKey(path[1]);
      if (!apiKey || apiKey.userId !== claims.sub) throw new RelayError("api_key_not_found", "API key not found", 404);
      const url = new URL(request.url);
      return json(await authorityEntitlement.entitlement.pageApiKeyPlanSourceRestrictionCandidates(apiKey.id, {
        query: url.searchParams.get("q") ?? "",
        page: queryPage(request),
        pageSize: queryPageSize(request),
      }));
    }
    if (resource === "api-keys") {
      return json(await application.queries.pageUserApiKeyDirectory(claims.sub, userApiKeyDirectoryApiState(request)));
    }
    if (resource === "credit-products") {
      return json(await application.billingQueries.pageUserCreditCatalog(queryPage(request), queryPageSize(request)));
    }
    if (resource === "payment-channels" && path[1] && path[2] === "instruction-attachments" && path[3]) {
      const channel = await application.billingQueries.getPaymentChannel(path[1]);
      const attachment = await application.billingQueries.getPaymentChannelInstructionAttachment(path[3]);
      const available = channel?.status === "enabled" && (await application.billingQueries.isEnabledPaymentChannelListed(channel.id));
      if (!channel || !attachment || attachment.paymentChannelId !== channel.id || !available) throw new RelayError("payment_channel_instruction_attachment_not_found", "Payment instruction attachment not found", 404);
      const bytes = await readFile(privateStoragePath(paymentChannelUploadDir(attachmentStorageRoot(config)), attachment.storageKey));
      const auditInput = { actor, source: "web" as const, requestId: auditRequestId, action: "payment_channel_instruction_attachment.read", resource: { resourceType: "payment_channel_instruction_attachment", resourceId: attachment.id }, metadata: { paymentChannelId: channel.id, attachmentCount: 1, attachmentContentType: attachment.contentType, attachmentByteSize: attachment.byteSize, attachmentSha256: attachment.sha256 } } as const;
      await auditSuccessAsync(application.audit, auditInput);
      return new Response(bytes, { headers: { "content-type": attachment.contentType, "content-length": String(attachment.byteSize), "content-disposition": `inline; filename="${attachment.id}${attachmentExtension(attachment.contentType)}"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
    }
    if (resource === "credit-topups") {
      await application.billingCommands.expireCreditTopups(undefined, claims.sub);
      if (path[1] && path[2] === "attachments" && path[3]) {
        const topup = await application.billingQueries.getCreditTopup(path[1]);
        if (!topup || topup.userId !== claims.sub) throw new RelayError("credit_topup_not_found", "Credit topup not found", 404);
        const attachment = await application.billingQueries.getTopupAttachment(topup.id, path[3], claims.sub);
        if (!attachment) throw new RelayError("credit_topup_attachment_not_found", "Credit topup attachment not found", 404);
        const bytes = await readFile(privateStoragePath(creditTopupUploadDir(attachmentStorageRoot(config)), attachment.storageKey));
        const auditInput = { actor, source: "web" as const, requestId: auditRequestId, action: "credit_topup_attachment.read", resource: { resourceType: "credit_topup_attachment", resourceId: attachment.id }, metadata: { topupId: topup.id, attachmentCount: 1, attachmentContentType: attachment.contentType, attachmentByteSize: attachment.byteSize, attachmentSha256: attachment.sha256 } } as const;
        await auditSuccessAsync(application.audit, auditInput);
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
        const topup = await application.billingQueries.getCreditTopup(path[1]);
        if (!topup || topup.userId !== claims.sub) throw new RelayError("credit_topup_not_found", "Credit topup not found", 404);
        const attachments = await application.billingQueries.pageTopupAttachments(topup.id, {
            userId: claims.sub,
            purpose: "payment_evidence",
            page: queryPage(request),
            pageSize: queryPageSize(request),
          });
        return json({
          ...topup,
          paymentChannel: await application.billingQueries.getPaymentChannel(topup.paymentChannelId),
          attachments: attachments.items,
          attachmentPage: {
            page: attachments.page,
            pageSize: attachments.pageSize,
            total: attachments.total,
            totalPages: attachments.totalPages,
          },
        });
      }
      try {
        return json(await application.billingQueries.cursorUserTopups(claims.sub, new URL(request.url).searchParams.get("cursor") || undefined, queryPageSize(request)));
      } catch (error) {
        if (error instanceof CreditCursorError) throw new RelayError("invalid_credit_cursor", "Invalid Credit Topup cursor", 400);
        throw error;
      }
    }
    if (resource === "request-logs") {
      if (path[1] === "captures" && path[2] === "download") {
        const filter = requestCaptureDownloadFilter(request);
        const baseMetadata = requestCaptureDownloadAuditMetadata(filter);
        const slot = await application.commands.acquireRequestCaptureDownloadSlot();
        if (!slot) {
          const error = new RelayError("request_capture_download_busy", "Request Capture batch download capacity is busy", 503);
          await auditFailureForBackend({ actor, source: "web", requestId: auditRequestId, action: "request_capture.download", resource: { resourceType: "request_capture", resourceId: "range" }, metadata: { routePattern: "/api/user/request-logs/captures/download", ...baseMetadata }, error });
          throw error;
        }
        try {
          if (filter.apiKeyId) {
            const apiKey = await asyncTenancy.identity.getApiKey(filter.apiKeyId);
            if (!apiKey || apiKey.userId !== claims.sub) throw new RelayError("api_key_not_found", "API key not found", 404);
          }
          const logs = await queryRequestLogsAcrossStorageAsync(application.queries, requestLogArchiveReader, { ...filter, userId: claims.sub }, config.requestCapture.download.maxFiles + 1);
          const prepared = await prepareRequestCaptureDownload(requestCaptureClient.repo.v3, logs, config.requestCapture.download);
          const metadata = { ...baseMetadata, count: prepared.files.length, missingCount: prepared.missingCount, byteCount: prepared.compressedBytes };
          const stream = requestCaptureTarStream(prepared.files, requestCaptureDownloadSlotHooksAsync(application.commands, slot, requestCaptureStreamAuditHooksAsync(application.audit, {
              actor,
              requestId: auditRequestId,
              resourceId: "range",
              routePattern: "/api/user/request-logs/captures/download",
              metadata
            })));
          return new Response(stream, {
            headers: downloadHeaders("application/x-tar", requestCaptureTarFilename(filter.startedAtGte, filter.startedAtLte))
          });
        } catch (error) {
          try {
            await auditFailureForBackend({ actor, source: "web", requestId: auditRequestId, action: "request_capture.download", resource: { resourceType: "request_capture", resourceId: "range" }, metadata: { routePattern: "/api/user/request-logs/captures/download", ...baseMetadata }, error });
          } finally {
            await application.commands.releaseRequestCaptureDownloadSlot(slot);
          }
          throw error;
        }
      }

      const requestLogId = path[1] ?? "";
      if (requestLogId && path[2] === "capture") {
        const isDownload = path[3] === "download";
        if (path[3] && !isDownload) throw new RelayError("not_found", "User request capture route not found", 404);
        let requestLog = await application.queries.getRequestLogForUser(requestLogId, claims.sub);
        if (!requestLog) {
          const archiveEntry = await application.queries.getRequestLogArchiveEntryForUser(requestLogId, claims.sub);
          if (archiveEntry) {
            requestLog = await requestLogArchiveReader.getRequestLogsForEntries([archiveEntry]).then((items: Map<string, RequestLog>) => items.get(requestLogId)).catch(async (error: unknown) => {
              const mapped = requestLogArchiveUnavailable(error);
              await auditFailureForBackend({ actor, source: "web", requestId: auditRequestId, action: isDownload ? "request_capture.download" : "request_capture.read", resource: { resourceType: "request_capture", resourceId: requestLogId }, metadata: { routePattern: isDownload ? "/api/user/request-logs/:requestId/capture/download" : "/api/user/request-logs/:requestId/capture", requestId: requestLogId, apiKeyId: archiveEntry.apiKeyId, format: isDownload ? "jsonl.zst" : "json" }, error: mapped });
              throw mapped;
            });
            if (!requestLog) {
              const error = requestLogArchiveUnavailable();
              await auditFailureForBackend({ actor, source: "web", requestId: auditRequestId, action: isDownload ? "request_capture.download" : "request_capture.read", resource: { resourceType: "request_capture", resourceId: requestLogId }, metadata: { routePattern: isDownload ? "/api/user/request-logs/:requestId/capture/download" : "/api/user/request-logs/:requestId/capture", requestId: requestLogId, apiKeyId: archiveEntry.apiKeyId, format: isDownload ? "jsonl.zst" : "json" }, error });
              throw error;
            }
          }
        }
        if (!requestLog) {
          await auditDeniedForBackend({
            actor,
            source: "web",
            requestId: auditRequestId,
            action: isDownload ? "request_capture.download" : "request_capture.read",
            resource: { resourceType: "request_capture", resourceId: requestLogId || "unknown" },
            metadata: { routePattern: isDownload ? "/api/user/request-logs/:requestId/capture/download" : "/api/user/request-logs/:requestId/capture", requestId: requestLogId, format: isDownload ? "jsonl.zst" : "json" }
          });
          throw new RelayError("request_log_not_found", "Request log not found", 404);
        }

        if (isDownload) {
          const metadata = { routePattern: "/api/user/request-logs/:requestId/capture/download", requestId: requestLog.id, apiKeyId: requestLog.apiKeyId, format: "jsonl.zst" };
          try {
            const prepared = await prepareRequestCaptureDownload(requestCaptureClient.repo.v3, [requestLog], { maxFiles: 1, maxCompressedBytes: config.requestCapture.download.maxCompressedBytes });
            const file = prepared.files[0]!;
            return new Response(requestCaptureFileStream(file, requestCaptureStreamAuditHooksAsync(application.audit, {
                actor,
                requestId: auditRequestId,
                resourceId: requestLog.id,
                routePattern: "/api/user/request-logs/:requestId/capture/download",
                metadata: { ...metadata, byteCount: file.size }
              })), { headers: { ...downloadHeaders("application/zstd", `${requestLog.id}.jsonl.zst`), "content-length": String(file.size) } });
          } catch (error) {
            await auditFailureForBackend({ actor, source: "web", requestId: auditRequestId, action: "request_capture.download", resource: { resourceType: "request_capture", resourceId: requestLog.id }, metadata, error });
            throw error;
          }
        }

        const requestedView = parseRequestCaptureView(new URL(request.url).searchParams.get("view"));
        const locatedExchange = await requestCaptureReader.getCapturedExchangeForRequestLogAsync(requestLog).catch(async (error: unknown) => {
          await auditFailureForBackend({
            actor,
            source: "web",
            requestId: auditRequestId,
            action: "request_capture.read",
            resource: { resourceType: "request_capture", resourceId: requestLog.id },
            metadata: { routePattern: "/api/user/request-logs/:requestId/capture", requestId: requestLog.id, apiKeyId: requestLog.apiKeyId, format: "json", requestCaptureView: requestedView ?? "original" },
            error
          });
          throw error;
        });
        const exchange = locatedExchange?.exchange ?? { request: null, response: null };
        if (!path[3]) {
          if (!locatedExchange) {
            await auditFailureForBackend({
              actor,
              source: "web",
              requestId: auditRequestId,
              action: "request_capture.read",
              resource: { resourceType: "request_capture", resourceId: requestLog.id },
              metadata: { routePattern: "/api/user/request-logs/:requestId/capture", requestId: requestLog.id, apiKeyId: requestLog.apiKeyId, format: "json", requestCaptureView: requestedView ?? "original", effectiveCaptureStatus: "unavailable", effectiveRepresentation: null }
            });
            throw new RelayError("request_capture_not_found", "Request capture not found", 404);
          }
          await auditSuccessForBackend({
            actor,
            source: "web",
            requestId: auditRequestId,
            action: "request_capture.read",
            resource: { resourceType: "request_capture", resourceId: requestLog.id },
            metadata: {
              routePattern: "/api/user/request-logs/:requestId/capture",
              requestId: requestLog.id,
              apiKeyId: requestLog.apiKeyId,
              format: "json",
              requestCaptureView: requestedView ?? "original",
              effectiveCaptureStatus: exchange.request?.effective.status ?? "unavailable",
              effectiveRepresentation: exchange.request?.effective.status === "verified" ? exchange.request.effective.representation : null
            }
          });
          if (requestedView) return requestCaptureJson(requestCaptureViewResponse(exchange, requestedView));
          return requestCaptureJson(requestCaptureDetailResponse(exchange.request, exchange.response));
        }
      }
      const limit = requestLogLimit(request);
      const logs = await (queryRequestLogsAcrossStorageAsync(application.queries, requestLogArchiveReader, { userId: claims.sub, ...requestLogListFilter(request) }, limit + 1)).catch((error: unknown) => { throw requestLogArchiveUnavailable(error); });
      return json(await userRequestLogsResponse(
        await application.queries.listApiKeySummariesByIds(claims.sub, logs.slice(0, limit).map((log) => log.apiKeyId)),
        logs,
        requestCaptureReader,
        requestCaptureClient.repo,
        limit,
      ));
    }
    if (resource === "available-models") {
      return json(await application.queries.pageUserAvailableModels(claims.sub, userAccessDirectoryApiState(request)));
    }
    if (resource === "access-order") {
      const exposedModel = new URL(request.url).searchParams.get("model")?.trim().slice(0, 200);
      return json(await application.queries.pageUserAccessOrder(claims.sub, {
        page: queryPage(request),
        pageSize: queryPageSize(request),
        ...(exposedModel ? { exposedModel } : {})
      }));
    }
    if (resource === "usage") return json(await application.queries.usageSummary({ userId: claims.sub }));
    if (resource === "budget") {
      const requestedTeamId = new URL(request.url).searchParams.get("teamId");
      const teamId = await asyncTenancy.resolveUserTeamId(claims, requestedTeamId, { allowPlatformOwner: false });
      const scopeRefs = [userScopeRef(claims.sub), teamScopeRef(teamId), "global:"] as ScopeRef[];
      const active = await application.queries.getActivePlanIdentity(scopeRefs);
      const pageSize = queryPageSize(request);
      if (!active) return json({ plan: null, template: null, items: [], page: 1, pageSize, total: 0, totalPages: 1 });
      const limits = await application.queries.pageBudgetLimits(active.planId, queryPage(request), pageSize);
      return json({
        ...limits,
        plan: {
          id: active.subscriptionId,
          planTemplateId: active.planId,
          scopeRef: active.scopeRef,
          source: active.source,
          priority: active.priority,
          status: active.subscriptionLifecycle,
          effectiveStart: active.effectiveStart,
          effectiveEnd: active.effectiveEnd,
        },
        template: {
          id: active.planId,
          name: active.planName,
          version: active.planVersion,
          billingMode: active.billingMode,
          purchaseAmount: active.purchaseAmount,
          durationSeconds: active.durationSeconds,
          planStatus: active.planStatus,
        },
      });
    }
    if (resource === "credit-account") {
      const scopeRef = userScopeRef(claims.sub);
      const account = await application.billingQueries.findCreditAccountForScope(scopeRef) ?? await application.billingCommands.createCreditAccount({ scopeRef });
      return json({ ...account, balance: await application.billingQueries.getCreditAccountBalance(account.id), transferOutEnabled: await application.billingQueries.isCreditTransferOutEnabled(scopeRef) });
    }
    if (resource === "providers") {
      if (path[1] && path[2] === "oauth" && path[3] === "status") {
        const slot = await requirePersonalProviderSlotForProvider(authorityEntitlement, path[1], claims.sub, true);
        const sessionId = new URL(request.url).searchParams.get("sessionId")?.trim() ?? "";
        if (!sessionId) throw new RelayError("invalid_provider_oauth", "sessionId is required", 400);
        const bindingRevision = positiveProviderBindingRevision(new URL(request.url).searchParams.get("bindingRevision"));
        const management = new AsyncProviderManagementService(application.queries, application.commands, application.modelAccess.providers, application.modelAccessQueries, application.audit);
        return json(publicPersonalOAuthStatus(await management.oauthStatus(path[1], sessionId, bindingRevision, { actor, source: "web", requestId: auditRequestId, fixedScopeRef: slot.scopeRef })));
      }
      const summaryRoutePattern = path[1] && path[2] === "models" && path.length === 3
        ? "/api/user/providers/:providerId/models"
        : "/api/user/providers";
      try {
        if (path[1] && path[2] === "models" && path.length === 3) {
          const slot = await requirePersonalProviderSlotForProvider(authorityEntitlement, path[1], claims.sub, false);
        const models = await application.modelAccessQueries.pageProviderModels(queryPage(request), queryPageSize(request), { providerIds: [path[1]] });
        await auditSuccessAsync(application.audit, {
          actor, source: "web", requestId: auditRequestId, action: "provider_summary.read",
          resource: { resourceType: "provider", resourceId: path[1] },
          metadata: { routePattern: "/api/user/providers/:providerId/models", slotId: slot.id, providerCount: 1, modelCount: models.items.length, page: models.page, pageSize: models.pageSize },
        });
          return json({ ...models, items: models.items.map(publicPersonalProviderModel) });
        }
        const slots = await authorityEntitlement.entitlement.pagePersonalProviderSlotsForUser(claims.sub, queryPage(request), queryPageSize(request));
      const providerIds = slots.items.flatMap((slot) => slot.lifecycle !== "retention_expired" && slot.providerId ? [slot.providerId] : []);
      const providers = await application.modelAccessQueries.listProvidersByIds(providerIds);
      const providersById = new Map(providers.map((provider) => [provider.id, provider]));
      if (providerIds.some((providerId) => !providersById.has(providerId))) throw new RelayError("personal_provider_projection_incomplete", "Personal Provider summary is incomplete", 503);
      await auditSuccessAsync(application.audit, {
        actor, source: "web", requestId: auditRequestId, action: "provider_summary.read",
        resource: { resourceType: "provider", resourceId: claims.sub },
        metadata: { routePattern: "/api/user/providers", slotCount: slots.items.length, providerCount: providers.length, modelCount: 0, page: slots.page, pageSize: slots.pageSize },
      });
        return json({
          ...slots,
          items: slots.items.map((slot) => ({
            ...publicPersonalProviderSlot(slot),
            provider: slot.lifecycle !== "retention_expired" && slot.providerId ? requiredPublicPersonalProvider(providersById, slot.providerId) : null,
          })),
        });
      } catch (error) {
        await auditFailureAsync(application.audit, {
          actor, source: "web", requestId: auditRequestId, action: "provider_summary.read",
          resource: { resourceType: "provider", resourceId: path[1] ?? claims.sub },
          metadata: { routePattern: summaryRoutePattern }, error,
        });
        throw error;
      }
    }
    if (resource === "access-points") {
      return json(await application.queries.pageUserAvailableModels(claims.sub, userAccessDirectoryApiState(request)));
    }
    throw new RelayError("not_found", "User resource not found", 404);
  });
}

function userApiKeyDirectoryApiState(request: Request) {
  const searchParams = new URL(request.url).searchParams;
  const state = parseUserApiKeyDirectoryApiState(searchParams);
  if (!state) {
    throw new RelayError("invalid_api_key_directory_query", "API Key directory accepts q (up to 100 characters), page (1-10000), and pageSize (1-200)", 400);
  }
  return state;
}

function userAccessDirectoryApiState(request: Request) {
  const state = parseUserAccessDirectoryApiState(new URL(request.url).searchParams);
  if (!state) {
    throw new RelayError("invalid_access_directory_query", "Access directory accepts q (up to 100 characters), page (1-10000), and pageSize (1-200)", 400);
  }
  return state;
}

function queryPage(request: Request) {
  return queryPageFrom(new URL(request.url), "page");
}

function queryPageSize(request: Request) {
  const raw = new URL(request.url).searchParams.get("pageSize");
  if (raw && (!/^\d+$/.test(raw) || normalizeDirectoryPageSize(Number(raw)) !== Number(raw))) {
    throw new RelayError("invalid_pagination", "pageSize must be an integer from 1 to 200", 400);
  }
  return normalizeDirectoryPageSize(raw ? Number(raw) : undefined);
}

function cardQueryPage(request: Request) {
  const searchParams = new URL(request.url).searchParams;
  const unsupported = Array.from(searchParams.keys()).find((key) => key !== "page" && key !== "pageSize");
  const raw = searchParams.get("page");
  if (unsupported) throw new RelayError("invalid_pagination", "Card pages accept only page as an integer from 1 to 10000", 400);
  if (!raw) return 1;
  if (!/^[1-9]\d*$/.test(raw) || Number(raw) > 10_000) {
    throw new RelayError("invalid_pagination", "Card pages accept only page as an integer from 1 to 10000", 400);
  }
  return Number(raw);
}

function cardQueryPageSize(request: Request) {
  return queryPageSize(request);
}

function cardInventoryApiState(request: Request) {
  const state = parseCardInventoryApiState(new URL(request.url).searchParams);
  if (!state) throw new RelayError("invalid_pagination", "Card inventory accepts available or all status with bounded page and pageSize", 400);
  return state;
}

function queryPageFrom(url: URL, key: string) {
  const raw = url.searchParams.get(key);
  if (!raw) return 1;
  if (!/^\d+$/.test(raw)) throw new RelayError("invalid_pagination", `${key} must be a positive integer`, 400);
  return Math.max(1, Math.min(10_000, Number(raw)));
}

function apiKeyPlanSourceRestrictionInput(body: Record<string, unknown>): {
  mode: "all" | "restricted";
  sourceKeys: Array<{ planId: string; subscriptionScopeRef: ScopeRef }>;
  teamScopeRefs: ScopeRef[];
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
    sourceKeys: sourceKeys as Array<{ planId: string; subscriptionScopeRef: ScopeRef }>,
    teamScopeRefs: teamScopeRefs as ScopeRef[],
  };
}

export async function PUT(request: Request, context: Context) {
  return handle(request, async () => {
    const { asyncTenancy, application} = await services();
    const queries = application?.queries;
    const commands = (application.commands)!;
    const auditCommands = application.audit;
    const claims = await asyncTenancy.requireUser(request.headers);
    const path = (await context.params).path ?? [];
    if (path[0] !== "access-order" || !path[1]) throw new RelayError("not_found", "User resource not found", 404);
    const exposedModel = path.slice(1).join("/");
    const body = await bodyJson<{ orderedPlanScopeIds?: unknown }>(request);
    if (!Array.isArray(body.orderedPlanScopeIds) || body.orderedPlanScopeIds.some((id) => typeof id !== "string")) {
      throw new RelayError("invalid_access_order", "orderedPlanScopeIds must be an array of source IDs", 400);
    }
    const items = await commands.replaceUserModelPlanSourceOrder(claims.sub, exposedModel, body.orderedPlanScopeIds as string[]);
    const auditInput = {
      actor: actorFromClaims(claims),
      source: "web",
      requestId: requestIdFromHeaders(request.headers),
      action: "access_order.replace",
      resource: { resourceType: "user_model_plan_scope_order", resourceId: `${claims.sub}:${exposedModel}` },
      metadata: { exposedModel, sourceIdSummary: items.map((item) => item.id).join(","), count: items.length, updatedAt: items[0]?.updatedAt ?? null }
    } as const;
    await auditSuccessAsync(auditCommands, auditInput);
    return json(await queries.pageUserAccessOrder(claims.sub, { exposedModel }));
  });
}

export async function PATCH(request: Request, context: Context) {
  const path = (await context.params).path ?? [];
  if (path[0] === "api-keys" && path[1] && path[2] === "plan-source-restriction" && path.length === 3) {
    return handle(request, async () => {
      const { asyncTenancy, authorityEntitlement, config } = await services();
      const claims = await asyncTenancy.requireUser(request.headers);
      const apiKey = await asyncTenancy.identity.getApiKey(path[1]!);
      if (!apiKey || apiKey.userId !== claims.sub) throw new RelayError("api_key_not_found", "API key not found", 404);
      const policy = apiKeyPlanSourceRestrictionInput(await bodyJson<Record<string, unknown>>(request, config.gateway.maxRequestBodyBytes));
      return json(await authorityEntitlement.replaceApiKeyPlanSourceRestriction({
        apiKeyId: path[1]!, actorUserId: claims.sub, ...policy, auditSource: "web", requestId: requestIdFromHeaders(request.headers),
      }));
    });
  }
  if (path[0] !== "access-order") return POST(request, context);
  return handle(request, async () => {
    const { asyncTenancy, application} = await services();
    const queries = application.queries;
    const commands = application.commands;
    const auditCommands = application.audit;
    const claims = await asyncTenancy.requireUser(request.headers);
    if (path[0] !== "access-order" || !path[1] || !path[2] || path.length !== 3) throw new RelayError("not_found", "User resource not found", 404);
    const exposedModel = decodeURIComponent(path[1]);
    const orderId = decodeURIComponent(path[2]);
    const body = await bodyJson<{ placement?: unknown; anchorId?: unknown }>(request);
    if (body.placement !== "before" && body.placement !== "after") {
      throw new RelayError("invalid_access_order_placement", "placement must be before or after", 400);
    }
    if (body.anchorId !== null && typeof body.anchorId !== "string") {
      throw new RelayError("invalid_access_order_anchor", "anchorId must be a source ID or null", 400);
    }
    const items = await commands.moveUserModelPlanSourceOrder(claims.sub, exposedModel, orderId, body.placement, body.anchorId);
    const auditInput = {
      actor: actorFromClaims(claims),
      source: "web",
      requestId: requestIdFromHeaders(request.headers),
      action: "access_order.move",
      resource: { resourceType: "user_model_plan_scope_order", resourceId: orderId },
      metadata: { exposedModel, placement: body.placement, anchorId: body.anchorId, count: items.length, updatedAt: items.find((item) => item.id === orderId)?.updatedAt ?? null }
    } as const;
    await auditSuccessAsync(auditCommands, auditInput);
    return json(await queries.pageUserAccessOrder(claims.sub, { exposedModel }));
  });
}

export async function POST(request: Request, context: Context) {
  return handle(request, async () => {
    const { asyncTenancy, authorityEntitlement, billingCommerce, application, config } = await services();
    ensureBillingCommerceRuntime(application);
    const queries = application?.queries;
    const commands = (application.commands)!;
    const auditCommands = application.audit;
    const billingQueries = application.billingQueries;
    const billingCommands = application.billingCommands;
    const billingApplication = billingCommerce ?? (process.env.NODE_ENV === "test" ? billingCommands : undefined);
    const claims = await asyncTenancy.requireUser(request.headers);
    const audit = { actor: actorFromClaims(claims), source: "web" as const, requestId: requestIdFromHeaders(request.headers) };
    const path = (await context.params).path ?? [];
    const resource = path[0] ?? "";
    const resourceId = path[1] ?? "";
    const action = path[2] ?? "";
    if (resource === "credit-topups" && resourceId && action === "attachments") {
      const topup = await billingQueries.getCreditTopup(resourceId);
      if (!topup || topup.userId !== claims.sub) throw new RelayError("credit_topup_not_found", "Credit topup not found", 404);
      const attachment = await storeCreditTopupAttachmentAsync(request, attachmentStorageRoot(config), topup.id, claims.sub, "payment_evidence", {
        listCreditTopupAttachments: (id) => billingQueries.listCreditTopupAttachments(id),
        createCreditTopupAttachment: (input) => billingCommands.createCreditTopupAttachment(input),
      });
      {
        await auditSuccessAsync(auditCommands, { actor: audit.actor, source: "web", requestId: audit.requestId, action: "credit_topup_attachment.create", resource: { resourceType: "credit_topup_attachment", resourceId: attachment.id }, metadata: { topupId: topup.id, attachmentCount: 1, attachmentContentType: attachment.contentType, attachmentByteSize: attachment.byteSize, attachmentSha256: attachment.sha256 } });
      }
      return json(attachment);
    }
    const body = await bodyJson<Record<string, unknown>>(request, config.gateway.maxRequestBodyBytes);
    if (resource === "authority-products" && resourceId && (action === "purchase" || action === "renew") && path.length === 3) {
      const product = await authorityEntitlement.commerce.getAuthorityProduct(resourceId);
      if (!product) throw new RelayError("authority_product_not_found", "Authority Product not found", 404);
      if (product.effectCode === "user_custom_provider_access") {
        const idempotencyKey = request.headers.get("idempotency-key") ?? "";
        const result = action === "renew"
          ? await authorityEntitlement.renewPersonalProviderSlot({ buyerUserId: claims.sub, slotId: requiredString(body.slotId, "slotId"), productId: resourceId, idempotencyKey, requestId: audit.requestId })
          : await authorityEntitlement.purchasePersonalProviderSlot({ buyerUserId: claims.sub, productId: resourceId, idempotencyKey, requestId: audit.requestId });
        return json(publicPersonalProviderPurchase(result), { status: result.replayed ? 200 : 201 });
      }
      if (action === "renew") throw new RelayError("authority_product_renewal_not_supported", "This Authority Product does not support Provider slot renewal", 409);
      if (body.teamId !== undefined) {
        const result = await authorityEntitlement.purchaseTeamProviderProduct({
          buyerUserId: claims.sub,
          productId: resourceId,
          teamId: requiredString(body.teamId, "teamId"),
          idempotencyKey: request.headers.get("idempotency-key") ?? "",
          requestId: requestIdFromHeaders(request.headers),
        });
        return json(publicTeamProviderAuthorityPurchase(result), { status: result.replayed ? 200 : 201 });
      }
      const result = await authorityEntitlement.purchaseTeamCreationProduct({ buyerUserId: claims.sub, productId: resourceId, idempotencyKey: request.headers.get("idempotency-key") ?? "", requestId: requestIdFromHeaders(request.headers) });
      return json(publicAuthorityPurchase(result), { status: result.replayed ? 200 : 201 });
    }
    if (resource === "teams" && path.length === 1) {
      const result = await authorityEntitlement.createTeamByConsumingAuthority({ beneficiaryUserId: claims.sub, name: requiredString(body.name, "name"), idempotencyKey: request.headers.get("idempotency-key") ?? "", requestId: requestIdFromHeaders(request.headers) });
      return json({ useId: result.use.id, teamId: result.use.targetIdSnapshot, targetStatus: result.targetStatus }, { status: result.replayed ? 200 : 201 });
    }
    if (resource === "cards" && path.length === 3 && resourceId && action === "send") {
      const referenceCode = optionalString(body.referenceCode, "referenceCode");
      const canSetReferenceCode = await queries.canUserSetCardReferenceCode(claims.sub);
      if (referenceCode?.trim() && !canSetReferenceCode) {
        throw new RelayError("card_reference_code_forbidden", "Reference code is only available to Team Owners", 403);
      }
      const cardInput = {
        cardId: resourceId,
        fromUserId: claims.sub,
        toUserId: requiredString(body.toUserId, "toUserId"),
        referenceCode,
        note: optionalString(body.note, "note")
      };
      return json(await billingCommands.sendCard(cardInput));
    }
    if (resource === "cards" && path.length === 3 && resourceId && action === "use") {
      if (!billingApplication) throw new RelayError("billing_commerce_application_unavailable", "Billing/Commerce application service is unavailable", 503);
      return json(await billingApplication.useCard({ cardId: resourceId, ownerUserId: claims.sub }));
    }
    if (resource === "plan-cards" && path.length === 1) {
      if (!billingApplication) throw new RelayError("billing_commerce_application_unavailable", "Billing/Commerce application service is unavailable", 503);
      const purchaseInput = {
        planId: requiredString(body.planId, "planId"),
        buyerUserId: claims.sub,
        useImmediately: requiredBoolean(body.useImmediately, "useImmediately")
      };
      return json(await billingApplication.purchasePlanCard(purchaseInput));
    }
    if (resource === "api-keys") {
      if (resourceId && action) {
        if (action === "copy") {
          const rawKey = await asyncTenancy.copyKeyValueForUser(resourceId, claims.sub, audit);
          return json({ rawKey }, {
            headers: {
              "cache-control": "private, no-store",
              pragma: "no-cache",
              "x-content-type-options": "nosniff"
            }
          });
        }
        const apiKey = await asyncTenancy.identity.getApiKey(resourceId);
        if (!apiKey || apiKey.userId !== claims.sub) throw new RelayError("api_key_not_found", "API key not found", 404);
        if (action === "disable" || action === "pause") return json(await asyncTenancy.disableKey(resourceId, audit));
        if (action === "enable" || action === "resume") return json(await asyncTenancy.enableKey(resourceId, audit));
        if (action === "revoke") return json(await asyncTenancy.revokeKey(resourceId, audit));
        throw new RelayError("not_found", "API key action not found", 404);
      }
      return json(await asyncTenancy.createKey({ userId: claims.sub, name: String(body.name ?? ""), expiresAt: body.expiresAt ? String(body.expiresAt) : null }, audit));
    }
    if (resource === "api-test") {
      const key = await asyncTenancy.identity.findFirstEnabledApiKeyForUser(claims.sub);
      const user = await asyncTenancy.identity.getUser(claims.sub);
      if (!key || !user) throw new RelayError("api_test_unavailable", "Create an API key first", 400);
      const payload = normalizeApiTestPayload(body.payload ?? body);
      const model = String(payload.model);
      const startedAt = Date.now();
      const response = await InternalGatewayClient.fromEnv().invoke({
        path: "/v1/chat/completions",
        apiKey: key.keyValue,
        payload,
        requestId: audit.requestId,
        canonicalClientIp: createAsyncAbuseGuard({
          queries,
          commands,
          config,
          source: "web",
        }).canonicalClientIp(request.headers),
        signal: request.signal
      });
      const result = {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        elapsedMs: Date.now() - startedAt,
        requestId: response.requestId ?? audit.requestId,
        body: response.body
      };
      await auditSuccessAsync(auditCommands, { actor: audit.actor, source: "web", requestId: audit.requestId, action: "api_test.run", resource: { resourceType: "api_test", resourceId: key.id }, metadata: { apiKeyId: key.id, userId: user.id, model, status: result.status, ok: result.ok, gatewayRequestId: result.requestId } });
      return json(result);
    }
    if (resource === "chat") {
      const payload = normalizeUserChatPayload(body);
      const modelDirectory = await queries.pageUserAvailableModels(claims.sub, { query: payload.model, page: 1, pageSize: 20 });
      if (!modelDirectory.items.some((item) => item.exposedModel === payload.model)) {
        throw new RelayError("chat_model_not_available", "The selected model is not currently available", 403);
      }

      const key = await asyncTenancy.identity.findFirstEnabledApiKeyForUser(claims.sub);
      const user = await asyncTenancy.identity.getUser(claims.sub);
      if (!key || !user) throw new RelayError("chat_unavailable", "Create an API key first", 400);

      const response = await InternalGatewayClient.fromEnv().invoke({
        path: "/v1/chat/completions",
        apiKey: key.keyValue,
        payload: { model: payload.model, messages: payload.messages, max_completion_tokens: 512, stream: false },
        requestId: audit.requestId,
        canonicalClientIp: createAsyncAbuseGuard({
          queries,
          commands,
          config,
          source: "web",
        }).canonicalClientIp(request.headers),
        signal: request.signal
      });
      const requestId = response.requestId ?? audit.requestId;
      const status = response.status;
      if (status < 200 || status >= 300) {
        const error = new RelayError("chat_gateway_rejected", "The Gateway rejected the chat request", status >= 400 && status < 600 ? status : 502);
        await auditFailureAsync(auditCommands, { actor: audit.actor, source: "web", requestId: audit.requestId, action: "chat.run", resource: { resourceType: "user_chat", resourceId: key.id }, metadata: { apiKeyId: key.id, userId: user.id, model: payload.model, status, ok: false, gatewayRequestId: requestId }, error });
        return json({ ok: false, status, requestId, errorMessage: "The chat request could not be completed." }, { status: error.status });
      }

      const message = extractUserChatAssistantText(response.body);
      await auditSuccessAsync(auditCommands, { actor: audit.actor, source: "web", requestId: audit.requestId, action: "chat.run", resource: { resourceType: "user_chat", resourceId: key.id }, metadata: { apiKeyId: key.id, userId: user.id, model: payload.model, status, ok: true, gatewayRequestId: requestId } });
      return json({ ok: true, status, requestId, message });
    }
    if (resource === "providers") {
      const management = new AsyncProviderManagementService(application.queries, application.commands, application.modelAccess.providers, application.modelAccessQueries, application.audit);
      if (!resourceId) {
        const result = await authorityEntitlement.createPersonalProvider({ slotId: requiredString(body.slotId, "slotId"), userId: claims.sub, name: requiredString(body.name, "name"), requestId: audit.requestId });
        return json({ provider: publicPersonalProvider(result.provider), slot: publicPersonalProviderSlot(result.slot), replayed: result.replayed }, { status: result.replayed ? 200 : 201 });
      }
      const safeShrink = (action === "credential" && (path[3] === "clear" || request.method === "DELETE"))
        || (request.method === "PATCH" && body.status === "disabled" && Object.keys(body).every((key) => ["status", "id"].includes(key)));
      const slot = await requirePersonalProviderSlotForProvider(authorityEntitlement, resourceId, claims.sub, !safeShrink);
      const context = { actor: audit.actor, source: audit.source, requestId: audit.requestId, fixedScopeRef: slot.scopeRef };
      if (action === "credential") {
        if (path[3] === "clear" || request.method === "DELETE") {
          await management.clearCredential(resourceId, context);
          return json({ status: "cleared" });
        }
        throw new RelayError("personal_provider_credential_method_forbidden", "Personal Providers use Codex OAuth only", 403);
      }
      if ((action === "sync-models" || (action === "models" && path[3] === "sync")) && request.method === "POST") {
        const result = await management.syncModels(resourceId, context);
        return json({ providerId: result.providerId, synced: result.synced, created: result.created, items: result.items.map(publicPersonalProviderModel) });
      }
      if (action === "models" && path[3] && path[3] !== "sync" && request.method === "PATCH") {
        return json(publicPersonalProviderModel(await authorityEntitlement.changePersonalProviderModel({
          slotId: slot.id, userId: claims.sub, providerId: resourceId, providerModelName: path[3],
          ...(body.displayName === undefined ? {} : { displayName: String(body.displayName) }),
          ...(body.status === undefined ? {} : { status: personalProviderModelStatus(body.status) }), requestId: audit.requestId,
        })));
      }
      if (action === "oauth" && path[3] === "start" && request.method === "POST") return json(publicPersonalOAuthStart(await management.startOAuth(resourceId, context)));
      if (action === "oauth" && path[3] === "callback" && request.method === "POST") {
        const result = await management.submitOAuthCallback(resourceId, body, context);
        return json({ status: result.status });
      }
      if (request.method === "PATCH" && body.status === "disabled" && Object.keys(body).every((key) => ["status", "id"].includes(key))) {
        return json(publicPersonalProvider(await management.mutate("PATCH", { id: resourceId, status: "disabled" }, context)));
      }
      if (request.method === "PATCH" && body.status === "enabled" && Object.keys(body).every((key) => ["status", "id"].includes(key))) {
        return json(publicPersonalProvider(await management.mutate("PATCH", { id: resourceId, status: "enabled" }, context)));
      }
      if (request.method === "PATCH" && typeof body.name === "string" && Object.keys(body).every((key) => ["name", "id"].includes(key))) {
        return json(publicPersonalProvider(await management.mutate("PATCH", { id: resourceId, name: requiredString(body.name, "name") }, context)));
      }
      throw new RelayError("personal_provider_mutation_forbidden", "Personal Provider fields are server-managed; use OAuth, model, status, or cleanup actions", 403);
    }
    if (resource === "access-points") {
      if (resourceId && (action === "enable" || action === "disable")) {
        const result = await authorityEntitlement.changePersonalAccessPointStatus({ slotId: requiredString(body.slotId, "slotId"), userId: claims.sub, accessPointId: resourceId, status: action === "enable" ? "enabled" : "disabled", requestId: audit.requestId });
        return json(publicPersonalAccessPointMutation(result));
      }
      if (resourceId && action === "remove") {
        const result = await authorityEntitlement.removePersonalAccessPoint({ slotId: requiredString(body.slotId, "slotId"), userId: claims.sub, accessPointId: resourceId, requestId: audit.requestId });
        return json(publicPersonalAccessPointMutation(result));
      }
      const slotId = requiredString(body.slotId, "slotId");
      const targetType = String(body.targetType ?? "provider-model");
      if (targetType === "access-point") throw new RelayError("personal_access_point_facade_not_supported", "Platform AccessPoint facade delegation is not available in this release", 409);
      const idempotencyKey = request.headers.get("idempotency-key")?.trim();
      if (!idempotencyKey) throw new RelayError("idempotency_key_required", "Idempotency-Key header is required", 400);
      const targetModel = requiredString(body.targetModel, "targetModel");
      try {
        const result = await authorityEntitlement.createPersonalAccessPoint({
          slotId, userId: claims.sub, requestId: audit.requestId,
          command: {
            idempotencyKey, name: String(body.name ?? "Access Point"), description: body.description == null ? null : String(body.description),
            apiFamily: String(body.apiFamily ?? "openai-compatible"), exposedModel: requiredString(body.exposedModel, "exposedModel"), targetModel,
            routing: { selector: { id: "direct", behaviorVersion: 1, config: {} }, requestOverrides: body.requestOverrides ?? {}, targets: [{
              type: "provider-model", targetAccessPointId: null, targetProviderId: requiredString(body.targetProviderId, "targetProviderId"),
              targetProviderModelName: String(body.targetProviderModelName ?? targetModel), position: 0, status: "enabled",
            }] }, priority: Number(body.priority ?? 100), weight: Number(body.weight ?? 1), fallbackOrder: Number(body.fallbackOrder ?? 100), status: "disabled",
          },
        });
        return json(publicPersonalAccessPointMutation(result), { status: result.replayed ? 200 : 201 });
      } catch (error) {
        if (error instanceof RelayError && error.code === "personal_access_point_limit_reached") {
          await auditFailureAsync(auditCommands, {
            actor: audit.actor, source: "web", requestId: audit.requestId, action: "access_point.create",
            resource: { resourceType: "access_point", resourceId: "pending" },
            metadata: { scopeRef: userScopeRef(claims.sub), errorCode: error.code }, error,
          });
        }
        throw error;
      }
    }
    if (resource === "credit-topups") {
      if (path[1] && path[2] === "payment-reference") {
        const topupInput = { topupId: path[1], userId: claims.sub, transactionReference: String(body.transactionReference ?? ""), claimedPaidAt: body.claimedPaidAt ? String(body.claimedPaidAt) : null };
        const topup = await billingCommands.submitCreditTopupPaymentReference(topupInput);
        await auditSuccessAsync(auditCommands, { actor: audit.actor, source: "web", requestId: audit.requestId, action: "credit_topup.payment_submit", resource: { resourceType: "credit_topup", resourceId: topup.id }, metadata: creditTopupAuditMetadata(topup) });
        return json(topup);
      }
      if (path[1] && path[2] === "cancel") {
        const current = await billingQueries.getCreditTopup(path[1]);
        if (!current || current.userId !== claims.sub) throw new RelayError("credit_topup_not_found", "Credit topup not found", 404);
        if (current.settlementMode === "stripe_checkout" && current.transactionReference) {
          const stripe = stripeClient();
          const session = await stripe.checkout.sessions.retrieve(current.transactionReference);
          if (session.status === "complete") throw new RelayError("stripe_checkout_already_complete", "Completed Stripe Checkout cannot be cancelled", 409);
          if (session.status === "open") await stripe.checkout.sessions.expire(session.id);
        }
        const topup = await billingCommands.cancelUserCreditTopup({ topupId: path[1], userId: claims.sub });
        await auditSuccessAsync(auditCommands, { actor: audit.actor, source: "web", requestId: audit.requestId, action: "credit_topup.cancel", resource: { resourceType: "credit_topup", resourceId: topup.id }, metadata: creditTopupAuditMetadata(topup) });
        return json(topup);
      }
      assertCreditTopupCreatePayload(body);
      const topupInput = {
        userId: claims.sub,
        productListingId: String(body.productListingId ?? ""),
        idempotencyKey: request.headers.get("idempotency-key") ?? "",
        useImmediately: requiredBoolean(body.useImmediately, "useImmediately")
      };
      const topup = await billingCommands.createUserCreditTopup(topupInput);
      await auditSuccessAsync(auditCommands, { actor: audit.actor, source: "web", requestId: audit.requestId, action: "credit_topup.create", resource: { resourceType: "credit_topup", resourceId: topup.id }, metadata: creditTopupAuditMetadata(topup) });
      return json(topup);
    }
    if (resource === "credit-transfers") {
      const fromAccount = (await billingQueries.findCreditAccountForScope(userScopeRef(claims.sub)) ?? await billingCommands.createCreditAccount({ scopeRef: userScopeRef(claims.sub) }));
      const toScopeRef = requiredRuntimeScopeRef(body.toScopeRef);
      const toAccount = (await billingQueries.findCreditAccountForScope(toScopeRef) ?? await billingCommands.createCreditAccount({ scopeRef: toScopeRef }));
      const amountUnits = requiredInteger(body.amountUnits, "amountUnits");
      const transferInput = { fromAccountId: fromAccount.id, toAccountId: toAccount.id, amountUnits, actorUserId: claims.sub, reason: body.reason ? String(body.reason) : null };
      const transfer = await billingCommands.transferCredit(transferInput);
      await auditSuccessAsync(auditCommands, { actor: audit.actor, source: "web", requestId: audit.requestId, action: "credit_transfer.create", resource: { resourceType: "credit_transfer", resourceId: transfer.outEvent.transferId ?? transfer.outEvent.id }, metadata: { fromScopeRef: fromAccount.scopeRef, toScopeRef: toAccount.scopeRef, amountUnits } });
      return json(transfer);
    }
    throw new RelayError("not_found", "User resource not found", 404);
  });
}

export const DELETE = POST;

function ensureBillingCommerceRuntime(application: Awaited<ReturnType<typeof services>>["application"]): void {
  if (application.billingQueries && application.billingCommands) return;
  if (process.env.NODE_ENV === "test") {
    Object.assign(application, { billingQueries: application.queries, billingCommands: application.commands });
    return;
  }
  throw new RelayError("billing_commerce_service_unavailable", "Billing/Commerce service is unavailable", 503);
}

function requiredRuntimeScopeRef(value: unknown): ScopeRef {
  const scopeRef = String(value ?? "").trim();
  if (!isRuntimeScopeRef(scopeRef)) throw new RelayError("invalid_scope_ref", "toScopeRef must be a runtime scope_ref", 400);
  return scopeRef;
}

function requiredString(value: unknown, field: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new RelayError("invalid_request", `${field} is required`, 400);
  return normalized;
}

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new RelayError("invalid_request", `${field} must be a string`, 400);
  return value;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new RelayError("invalid_request", `${field} must be boolean`, 400);
  return value;
}

const CREDIT_TOPUP_CREATE_FIELDS = new Set(["productListingId", "useImmediately"]);
const CREDIT_TOPUP_PAYMENT_OVERRIDE_FIELDS = new Set([
  "amountUnits", "confirmedReceivedAmountUnits", "creditedAmountUnits", "currency", "expectedPaymentAmountUnits",
  "fxRate", "paymentAsset", "paymentChannelId", "paymentNetwork", "settlementMode"
]);

function assertCreditTopupCreatePayload(body: Record<string, unknown>): void {
  const field = Object.keys(body).find((key) => CREDIT_TOPUP_PAYMENT_OVERRIDE_FIELDS.has(key));
  if (field) throw new RelayError("credit_topup_payment_override_not_allowed", "Credit payment amount, asset, currency, FX, and channel fields are derived from the selected listing", 400);
  const unexpected = Object.keys(body).find((key) => !CREDIT_TOPUP_CREATE_FIELDS.has(key));
  if (unexpected) throw new RelayError("invalid_credit_topup_payload", `Unsupported Credit topup field: ${unexpected}`, 400);
}

function normalizeApiTestPayload(value: unknown): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new RelayError("invalid_api_test_payload", "Request parameters must be a JSON object", 400);
  }
  const payload = { ...(value as Record<string, unknown>) };
  if (!payload.model) throw new RelayError("invalid_api_test_payload", "Request parameters must include model", 400);
  if (!payload.messages) throw new RelayError("invalid_api_test_payload", "Request parameters must include messages", 400);
  payload.stream = false;
  return payload;
}

type UserChatPayload = {
  model: string;
  messages: Array<{
    role: "user" | "assistant";
    content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
  }>;
};

function normalizeUserChatPayload(value: unknown): UserChatPayload {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new RelayError("invalid_chat_payload", "Chat request must be a JSON object", 400);
  }
  const body = value as Record<string, unknown>;
  const unexpected = Object.keys(body).find((key) => key !== "model" && key !== "messages");
  if (unexpected) throw new RelayError("invalid_chat_payload", "Chat request accepts only model and messages", 400);

  const model = typeof body.model === "string" ? body.model.trim() : "";
  if (!model || model.length > 200) throw new RelayError("invalid_chat_payload", "model must be a non-empty string up to 200 characters", 400);
  if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 100) {
    throw new RelayError("invalid_chat_payload", "messages must contain between 1 and 100 items", 400);
  }

  return { model, messages: body.messages.map(normalizeUserChatMessage) };
}

function normalizeUserChatMessage(value: unknown): UserChatPayload["messages"][number] {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new RelayError("invalid_chat_message", "Each chat message must be an object", 400);
  }
  const message = value as Record<string, unknown>;
  const role = message.role === "user" || message.role === "assistant" ? message.role : null;
  if (!role) throw new RelayError("invalid_chat_message", "Chat messages must use the user or assistant role", 400);
  if (typeof message.content === "string") {
    if (message.content.length > 100_000) throw new RelayError("invalid_chat_message", "Text messages are too long", 400);
    return { role, content: message.content };
  }
  if (!Array.isArray(message.content) || message.content.length === 0 || message.content.length > 2) {
    throw new RelayError("invalid_chat_message", "Message content must be text or one image", 400);
  }

  let imageCount = 0;
  const content = message.content.map((part) => {
    if (!part || Array.isArray(part) || typeof part !== "object") {
      throw new RelayError("invalid_chat_message", "Message content parts must be objects", 400);
    }
    const contentPart = part as Record<string, unknown>;
    if (contentPart.type === "text") {
      if (typeof contentPart.text !== "string" || contentPart.text.length > 100_000) {
        throw new RelayError("invalid_chat_message", "Text content must be a string up to 100,000 characters", 400);
      }
      return { type: "text" as const, text: contentPart.text };
    }
    if (contentPart.type === "image_url") {
      if (role !== "user" || imageCount > 0) throw new RelayError("invalid_chat_message", "Each user message accepts at most one image", 400);
      imageCount += 1;
      const imageUrl = contentPart.image_url;
      if (!imageUrl || Array.isArray(imageUrl) || typeof imageUrl !== "object") {
        throw new RelayError("invalid_chat_image", "image_url must be an object", 400);
      }
      const url = (imageUrl as Record<string, unknown>).url;
      return { type: "image_url" as const, image_url: { url: normalizeUserChatImageDataUrl(url) } };
    }
    throw new RelayError("invalid_chat_message", "Only text and image_url content are supported", 400);
  });
  if (role === "assistant" && imageCount > 0) throw new RelayError("invalid_chat_message", "Assistant messages cannot include images", 400);
  return { role, content };
}

function normalizeUserChatImageDataUrl(value: unknown): string {
  if (typeof value !== "string") throw new RelayError("invalid_chat_image", "Image URL must be a data URL", 400);
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/u.exec(value);
  if (!match) throw new RelayError("invalid_chat_image", "Only JPEG, PNG, and WebP data URLs are supported", 400);
  const encoded = match[2]!;
  if (encoded.length % 4 !== 0) throw new RelayError("invalid_chat_image", "Image data is not valid base64", 400);
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length <= 0 || bytes.length > 5 * 1024 * 1024 || bytes.toString("base64") !== encoded) {
    throw new RelayError("invalid_chat_image", "Image data must be between 1 byte and 5 MiB", 400);
  }
  if (!matchesImageContentType(bytes, match[1]!)) {
    throw new RelayError("invalid_chat_image", "Image data does not match its declared type", 400);
  }
  return value;
}

function extractUserChatAssistantText(value: unknown): string {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new RelayError("invalid_chat_response", "The Gateway returned an invalid chat response", 502);
  }
  const body = value as Record<string, unknown>;
  const choices = body.choices;
  const firstChoice = Array.isArray(choices) ? choices[0] : null;
  const message = firstChoice && typeof firstChoice === "object" && !Array.isArray(firstChoice) ? (firstChoice as Record<string, unknown>).message : null;
  const content = message && typeof message === "object" && !Array.isArray(message) ? (message as Record<string, unknown>).content : null;
  if (typeof content === "string" && content) return content;
  if (Array.isArray(content)) {
    const text = content.flatMap((part) => part && typeof part === "object" && !Array.isArray(part) && (part as Record<string, unknown>).type === "text" && typeof (part as Record<string, unknown>).text === "string" ? [(part as Record<string, unknown>).text as string] : []).join("");
    if (text) return text;
  }
  throw new RelayError("invalid_chat_response", "The Gateway returned an empty chat response", 502);
}

function requestLogLimit(request: Request): number {
  const url = new URL(request.url);
  if (url.searchParams.has("pageSize")) return queryPageSize(request);
  const value = Number(url.searchParams.get("limit") ?? 20);
  if (!Number.isFinite(value)) return 20;
  return Math.max(1, Math.min(200, Math.trunc(value)));
}

function requestLogListFilter(request: Request): Omit<RequestLogListFilter, "userId"> {
  const searchParams = new URL(request.url).searchParams;
  const filter: Omit<RequestLogListFilter, "userId"> = {};
  const status = searchParams.get("status")?.trim();
  if (status) filter.status = status;
  const apiKeyId = searchParams.get("apiKeyId")?.trim();
  if (apiKeyId) filter.apiKeyId = apiKeyId;
  applyRequestLogSearchFilters(filter, searchParams);
  const timeFilter = optionalTimeWindowFilter(searchParams);
  if (timeFilter.startedAtGte) filter.startedAtGte = timeFilter.startedAtGte;
  if (timeFilter.startedAtLte) filter.startedAtLte = timeFilter.startedAtLte;
  const cursor = searchParams.get("cursor")?.trim();
  if (cursor) {
    const separator = cursor.lastIndexOf(":");
    if (separator > 0 && separator < cursor.length - 1) {
      filter.cursorStartedAt = cursor.slice(0, separator);
      filter.cursorId = cursor.slice(separator + 1);
    }
  }
  return filter;
}

type RequestCaptureDownloadFilter = Omit<RequestLogListFilter, "userId" | "cursorStartedAt" | "cursorId"> & {
  startedAtGte: string;
  startedAtLte: string;
};

function requestCaptureDownloadFilter(request: Request): RequestCaptureDownloadFilter {
  const searchParams = new URL(request.url).searchParams;
  const status = searchParams.get("status")?.trim().toLowerCase() ?? "";
  if (status && !["started", "completed", "failed"].includes(status)) throw new RelayError("invalid_request_capture_range", "status is invalid", 400);
  const duration = searchParams.get("duration")?.trim() ?? "";
  if (duration && !["open", "lt1s", "1s-5s", "5s-30s", "30s+"].includes(duration)) throw new RelayError("invalid_request_capture_range", "duration is invalid", 400);
  const start = searchParams.get("start")?.trim() ?? "";
  const timeWindow = normalizeTimeWindow(searchParams.get("timeWindow") ?? "");
  if (!start || !timeWindow) throw new RelayError("invalid_request_capture_range", "start and timeWindow are required", 400);
  const { cursorStartedAt: _cursorStartedAt, cursorId: _cursorId, ...filter } = requestLogListFilter(request);
  return { ...filter, ...timeWindowFilter(start, timeWindow) };
}

function requestCaptureDownloadAuditMetadata(filter: RequestCaptureDownloadFilter) {
  return {
    start: filter.startedAtGte,
    end: filter.startedAtLte,
    status: filter.status ?? "",
    apiKeyId: filter.apiKeyId ?? "",
    reqModel: filter.model ?? "",
    format: "tar"
  };
}

type RequestCaptureStreamAuditInput = {
  actor: AuditActor;
  requestId: string;
  resourceId: string;
  routePattern: string;
  metadata: Readonly<Record<string, AuditMetadataValue>>;
};

function requestCaptureStreamAuditHooksAsync(repo: Pick<AuditCommands, "record">, input: RequestCaptureStreamAuditInput): RequestCaptureStreamHooks {
  const event = {
    actor: input.actor,
    source: "web" as const,
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

function applyRequestLogSearchFilters(filter: Omit<RequestLogListFilter, "userId">, searchParams: URLSearchParams): void {
  const model = searchParams.get("model")?.trim();
  if (model) filter.model = model.slice(0, 120);
  applyRequestLogDurationFilter(filter, searchParams.get("duration")?.trim() ?? "");
}

function applyRequestLogDurationFilter(filter: Omit<RequestLogListFilter, "userId">, duration: string): void {
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

function optionalTimeWindowFilter(searchParams: URLSearchParams): { startedAtGte?: string; startedAtLte?: string } {
  const start = searchParams.get("start")?.trim();
  const timeWindow = normalizeTimeWindow(searchParams.get("timeWindow") ?? "");
  if (!start || !timeWindow) return {};
  return timeWindowFilter(start, timeWindow);
}

function timeWindowFilter(start: string, timeWindow: string): { startedAtGte: string; startedAtLte: string } {
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

async function userRequestLogsResponse(apiKeys: Array<{ id: string; name: string; keyPrefix: string }>, logs: RequestLog[], requestCaptureReader: { getCapturePresenceForRequestLogsAsync: (logs: RequestLog[]) => Promise<Map<string, { requestPresent: boolean; responsePresent: boolean }>> }, requestCaptures: { listCapturedRequestSummariesForRequestLogsAsync: (logs: RequestLog[]) => Promise<Map<string, { requestId: string; kind: string; reqModel: string; createdAt: string }>> }, limit: number) {
  const visibleLogs = logs.slice(0, limit);
  const hasMore = logs.length > limit;
  const [presenceById, captureSummaryById] = await Promise.all([
    requestCaptureReader.getCapturePresenceForRequestLogsAsync(visibleLogs),
    requestCaptures.listCapturedRequestSummariesForRequestLogsAsync(visibleLogs),
  ]);
  const apiKeyById = new Map(apiKeys.map((apiKey) => [apiKey.id, apiKey]));
  const last = visibleLogs.at(-1);
  return {
    items: visibleLogs.map((log) => {
      const apiKey = apiKeyById.get(log.apiKeyId);
      const presence = presenceById.get(log.id) ?? { requestPresent: false, responsePresent: false };
      const captureSummary = captureSummaryById.get(log.id);
      return {
        id: log.id,
        startedAt: log.startedAt,
        endedAt: log.endedAt,
        status: log.status,
        errorCode: log.errorCode,
        requestPath: log.requestPath,
        kind: captureSummary?.kind ?? kindFromRequestPath(log.requestPath) ?? "unknown",
        model: log.reqModel,
        apiKey: apiKey ? { id: apiKey.id, name: apiKey.name, prefix: apiKey.keyPrefix } : { id: log.apiKeyId, name: "Unknown key", prefix: "" },
        capture: {
          requestPresent: presence.requestPresent,
          responsePresent: presence.responsePresent
        }
      };
    }),
    nextCursor: hasMore && last ? `${last.startedAt}:${last.id}` : null
  };
}

function requestCaptureDetailResponse(capturedRequest: { createdAt: string; payload: unknown; effective: { status: "verified"; representation: string; body: unknown } | { status: "unavailable"; reason: string } } | null, capturedResponse: { status: number; errorCode: string | null; createdAt: string; body: unknown } | null) {
  return {
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
  };
}

function requestLogArchiveUnavailable(error?: unknown): RelayError {
  if (error instanceof RelayError && error.code === "request_capture_archive_unavailable") return error;
  return new RelayError("request_capture_archive_unavailable", "Request Log archive is temporarily unavailable", 503);
}

function errorMessageFromBody(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const record = body as Record<string, unknown>;
  const error = record.error;
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const message = (error as Record<string, unknown>).message;
    return typeof message === "string" ? message : "";
  }
  const message = record.message;
  return typeof message === "string" ? message : "";
}

function kindFromRequestPath(requestPath: string | null): string | null {
  if (!requestPath) return null;
  if (requestPath.includes("/responses")) return "responses";
  if (requestPath.includes("/chat/completions")) return "chat.completions";
  return null;
}

function requiredInteger(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new RelayError("invalid_number", `${field} must be a safe integer`, 400);
  return number;
}

function requiredNumber(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new RelayError("invalid_number", `${field} must be a finite number`, 400);
  return number;
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

async function storeCreditTopupAttachmentAsync(
  request: Request,
  storageRoot: string,
  topupId: string,
  uploadedByUserId: string,
  attachmentPurpose: "payment_evidence" | "admin_supplement",
  repo: {
    listCreditTopupAttachments(topupId: string): Promise<CreditTopupAttachment[]>;
    createCreditTopupAttachment(input: Omit<CreditTopupAttachment, "id" | "createdAt"> & { id?: string; createdAt?: string }): Promise<CreditTopupAttachment>;
  },
) {
  const form = await readBoundedRequestFormData(request, 5 * 1024 * 1024 + 64 * 1024);
  const file = form.get("file");
  if (!(file instanceof File)) throw new RelayError("credit_topup_attachment_required", "file is required", 400);
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new RelayError("invalid_credit_topup_attachment_type", "Only jpeg, png, and webp images are supported", 400);
  if (file.size <= 0 || file.size > 5 * 1024 * 1024) throw new RelayError("invalid_credit_topup_attachment_size", "Attachment size must be between 1 byte and 5 MiB", 400);
  const bytes = Buffer.from(await file.arrayBuffer());
  if (!matchesImageContentType(bytes, file.type)) throw new RelayError("invalid_credit_topup_attachment_type", "Attachment content does not match its declared image type", 400);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const existing = (await repo.listCreditTopupAttachments(topupId)).find((item) => item.sha256 === sha256 && item.attachmentPurpose === attachmentPurpose);
  if (existing) return existing;
  const extension = attachmentExtension(file.type);
  const id = `credit_topup_attachment_${cryptoRandomSuffix(16)}`;
  const storageKey = `${topupId}/${new Date().toISOString().replace(/[^0-9TZ]/g, "")}-${sha256.slice(0, 12)}-${id.slice(-8)}${extension}`;
  const baseDir = creditTopupUploadDir(storageRoot);
  const path = privateStoragePath(baseDir, storageKey);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes, { flag: "wx" });
  try {
    return await repo.createCreditTopupAttachment({ id, topupId, storageKey, contentType: file.type, byteSize: file.size, sha256, uploadedByUserId, attachmentPurpose });
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
  if (!path.startsWith(`${resolve(baseDir)}${"/"}`)) throw new RelayError("invalid_storage_key", "Invalid storage key", 500);
  return path;
}

function attachmentExtension(contentType: string): string {
  if (contentType === "image/jpeg") return ".jpg";
  if (contentType === "image/png") return ".png";
  if (contentType === "image/webp") return ".webp";
  return extname(contentType);
}

function cryptoRandomSuffix(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function publicAuthorityPurchase(result: { purchase: AuthorityPurchaseSnapshot; grant: AuthorityGrantSnapshot; quota: AuthorityGrantQuotaSnapshot }) {
  return {
    purchase: {
      id: result.purchase.id, productId: result.purchase.productId, productCode: result.purchase.productCode,
      productVersion: result.purchase.productVersion, productDisplayName: result.purchase.productDisplayName,
      effectCode: result.purchase.effectCode, grantUnits: result.purchase.grantUnits,
      purchaseAmountUnits: Number(result.purchase.purchaseAmountUnits), grantDurationSeconds: result.purchase.grantDurationSeconds,
      refundMode: result.purchase.refundMode, refundDeadlineSeconds: result.purchase.refundDeadlineSeconds,
      createdAt: result.purchase.createdAt
    },
    grant: { id: result.grant.id, effectiveStart: result.grant.effectiveStart, effectiveEnd: result.grant.effectiveEnd, lifecycle: result.grant.lifecycle },
    quota: { capabilityCode: result.quota.capabilityCode, grantedUnits: result.quota.grantedUnits }
  };
}

function publicTeamProviderAuthorityPurchase(result: { purchase: AuthorityPurchaseSnapshot; entitlement: TeamProviderEntitlementSnapshot }) {
  return {
    purchase: {
      id: result.purchase.id, productId: result.purchase.productId, productCode: result.purchase.productCode,
      productVersion: result.purchase.productVersion, productDisplayName: result.purchase.productDisplayName,
      effectCode: result.purchase.effectCode, purchaseAmountUnits: Number(result.purchase.purchaseAmountUnits),
      grantDurationSeconds: result.purchase.grantDurationSeconds, createdAt: result.purchase.createdAt
    },
    entitlement: {
      id: result.entitlement.id, teamId: result.entitlement.teamId,
      effectiveStart: result.entitlement.effectiveStart, effectiveEnd: result.entitlement.effectiveEnd,
      lifecycle: result.entitlement.lifecycle
    }
  };
}

function publicPersonalProviderPurchase(result: {
  purchase: AuthorityPurchaseSnapshot;
  slot: PersonalProviderSlotSnapshot;
  period: PersonalProviderEntitlementPeriodSnapshot;
}) {
  return {
    purchase: {
      id: result.purchase.id, productId: result.purchase.productId, productCode: result.purchase.productCode,
      productVersion: result.purchase.productVersion, productDisplayName: result.purchase.productDisplayName,
      effectCode: result.purchase.effectCode, purchaseAmountUnits: Number(result.purchase.purchaseAmountUnits),
      grantDurationSeconds: result.purchase.grantDurationSeconds, createdAt: result.purchase.createdAt,
    },
    slot: publicPersonalProviderSlot(result.slot),
    period: {
      id: result.period.id, providerSlotId: result.period.providerSlotId, durationDays: result.period.durationDaysSnapshot,
      effectiveStart: result.period.effectiveStart, effectiveEnd: result.period.effectiveEnd,
      renewalAdmittedAt: result.period.renewalAdmittedAt, fulfillmentSucceededAt: result.period.fulfillmentSucceededAt,
    },
  };
}

function requiredPublicPersonalProvider(
  providersById: ReadonlyMap<string, Parameters<typeof publicPersonalProvider>[0]>,
  providerId: string,
) {
  const provider = providersById.get(providerId);
  if (!provider) throw new RelayError("personal_provider_projection_incomplete", "Personal Provider summary is incomplete", 503);
  return publicPersonalProvider(provider);
}

function publicPersonalAccessPointMutation(result: {
  id: string; routingRevision: number; routingChanged: boolean; removed: boolean; replayed: boolean;
  slotId: string; usedAccessPoints?: number;
}) {
  return {
    id: result.id,
    slotId: result.slotId,
    routingRevision: result.routingRevision,
    routingChanged: result.routingChanged,
    removed: result.removed,
    replayed: result.replayed,
    ...(result.usedAccessPoints === undefined ? {} : { usedAccessPoints: result.usedAccessPoints }),
  };
}

async function requirePersonalProviderSlotForProvider(
  authorityEntitlement: { entitlement: { getPersonalProviderSlotForProvider(providerId: string): Promise<PersonalProviderSlotSnapshot | undefined> } },
  providerId: string,
  userId: string,
  requireActive: boolean,
): Promise<PersonalProviderSlotSnapshot> {
  const slot = await authorityEntitlement.entitlement.getPersonalProviderSlotForProvider(providerId);
  if (!slot || slot.userId !== userId || slot.lifecycle === "retention_expired") throw new RelayError("provider_not_found", "Personal Provider not found", 404);
  if (requireActive && slot.lifecycle !== "active") throw new RelayError("provider_slot_inactive", "Renew this Provider slot before changing or using it", 403, { state: slot.lifecycle });
  return slot;
}

function positiveProviderBindingRevision(value: string | null): number {
  if (!value || !/^[1-9]\d*$/u.test(value)) throw new RelayError("invalid_provider_oauth", "bindingRevision must be a positive integer", 400);
  const revision = Number(value);
  if (!Number.isSafeInteger(revision)) throw new RelayError("invalid_provider_oauth", "bindingRevision must be a positive integer", 400);
  return revision;
}

function personalProviderModelStatus(value: unknown): "enabled" | "disabled" {
  if (value === "enabled" || value === "disabled") return value;
  throw new RelayError("invalid_provider_model_status", "ProviderModel status must be enabled or disabled", 400);
}

function publicAuthorityProduct(product: AuthorityProductSnapshot) {
  return {
    id: product.id, code: product.code, version: product.version, displayName: product.displayName,
    effectCode: product.effectCode, grantUnits: product.grantUnits, purchaseAmountUnits: Number(product.purchaseAmountUnits),
    grantDurationSeconds: product.grantDurationSeconds, maxLifetimePurchasesPerUser: product.maxLifetimePurchasesPerUser,
    maxUnconsumedUnitsPerUser: product.maxUnconsumedUnitsPerUser, maxCurrentOwnedTeams: product.maxCurrentOwnedTeams,
    maxLifetimeCreatedTeams: product.maxLifetimeCreatedTeams, refundMode: product.refundMode,
    refundDeadlineSeconds: product.refundDeadlineSeconds, settlementHoldSeconds: product.settlementHoldSeconds
  };
}

function sanitizeAttachmentFilename(filename: string): string {
  const sanitized = filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return sanitized || "receipt";
}
