import type { AppConfig } from "@frely/config";
import type { RequestCaptureEncoding, RequestCaptureUnavailableReason } from "./request-capture-codec.js";
import {
  RequestCaptureV3Storage,
  type BeginRequestCaptureV3StreamInput,
  type RequestCaptureV3StreamWriter,
  type WriteRequestCaptureV3ExchangeInput
} from "./request-capture-v3.js";
import type { RequestCaptureSettingPort, RequestCaptureSetting, RequestLog } from "./contracts.js";
import { assertSharedCaptureStorageForConfig } from "./shared-capture-storage.js";

export interface CapturedRequest {
  id: string;
  requestId: string;
  apiKeyId: string;
  userId: string;
  teamId: string | null;
  kind: string;
  reqModel: string;
  effectiveRepresentation: RequestCaptureEncoding["effectiveRepresentation"];
  effectivePatchFormat: string | null;
  originalHashAlgorithm: string | null;
  originalSha256: string | null;
  effectiveHashAlgorithm: string | null;
  effectiveSha256: string | null;
  effectiveUnavailableReason: RequestCaptureUnavailableReason | null;
  createdAt: string;
  payload: unknown;
  effective:
    | { status: "verified"; representation: "identity" | "rfc6902" | "full"; body: unknown }
    | { status: "unavailable"; reason: RequestCaptureUnavailableReason };
}

export interface CapturedResponse {
  id: string;
  requestId: string;
  status: number;
  errorCode: string | null;
  createdAt: string;
  body: unknown;
}

export interface RequestCapturePresence {
  requestPresent: boolean;
  responsePresent: boolean;
}

export interface CapturedExchange {
  request: CapturedRequest | null;
  response: CapturedResponse | null;
}

export interface CapturedRequestSummary {
  requestId: string;
  kind: string;
  reqModel: string;
  createdAt: string;
}

export interface RequestCaptureStoreClient {
  repo: RequestCaptureStore;
  close(): void;
}

/**
 * REQ-GA-008 / REQ-MEMBER-009: this repository is a file-store facade. The
 * setting and Request Log references remain in the control database; Capture
 * content remains in the private file store.
 */
export class RequestCaptureStore {
  constructor(
    readonly mainRepo: RequestCaptureSettingPort | null,
    readonly v3: RequestCaptureV3Storage
  ) {}

  getRequestCaptureSetting(): RequestCaptureSetting {
    return this.requireMainRepo().getRequestCaptureSetting();
  }

  isRequestCaptureEnabled(): boolean {
    return this.requireMainRepo().isRequestCaptureEnabled();
  }

  setRequestCaptureEnabled(enabled: boolean, updatedBy?: string | null): RequestCaptureSetting {
    return this.requireMainRepo().setRequestCaptureEnabled(enabled, updatedBy);
  }

  writeCapturedExchange(input: WriteRequestCaptureV3ExchangeInput): CapturedExchange {
    return this.v3.writeExchange(input);
  }

  beginCapturedStream(input: BeginRequestCaptureV3StreamInput): Promise<RequestCaptureV3StreamWriter> {
    return this.v3.beginStreamExchange(input);
  }

  cleanupAbandonedCapturedStreams(options?: { olderThanMs?: number; nowMs?: number }): number {
    return this.v3.cleanupAbandonedStreamCaptures(options);
  }

  getCapturedExchangeForRequestLogAsync(requestLog: Pick<RequestLog, "id" | "startedAt">): Promise<CapturedExchange | null> {
    return this.v3.readExchangeAsync(requestLog.startedAt, requestLog.id);
  }

  async hasRequestCaptureForRequestLogsAsync(
    requestLogs: ReadonlyArray<Pick<RequestLog, "id" | "startedAt">>,
  ): Promise<Map<string, RequestCapturePresence>> {
    const result = new Map<string, RequestCapturePresence>();
    for (const requestLog of uniqueRequestLogs(requestLogs)) {
      const exchange = await this.getCapturedExchangeForRequestLogAsync(requestLog);
      result.set(requestLog.id, {
        requestPresent: Boolean(exchange?.request),
        responsePresent: Boolean(exchange?.response),
      });
    }
    return result;
  }

  async listCapturedRequestSummariesForRequestLogsAsync(
    requestLogs: ReadonlyArray<Pick<RequestLog, "id" | "startedAt">>,
  ): Promise<Map<string, CapturedRequestSummary>> {
    const result = new Map<string, CapturedRequestSummary>();
    for (const requestLog of uniqueRequestLogs(requestLogs)) {
      const request = (await this.getCapturedExchangeForRequestLogAsync(requestLog))?.request;
      if (request) result.set(request.requestId, {
        requestId: request.requestId,
        kind: request.kind,
        reqModel: request.reqModel,
        createdAt: request.createdAt,
      });
    }
    return result;
  }

  private requireMainRepo(): RequestCaptureSettingPort {
    if (!this.mainRepo) throw new Error("request_capture_sync_main_repository_unavailable");
    return this.mainRepo;
  }
}

export function openRequestCaptureStoreForConfig(config: AppConfig, mainRepo: RequestCaptureSettingPort | null = null): RequestCaptureStoreClient {
  assertSharedCaptureStorageForConfig(config);
  return {
    repo: new RequestCaptureStore(mainRepo, new RequestCaptureV3Storage({
      archiveDirectory: config.archive.directory,
      ...(config.requestCapture.archive.enabled && config.archive.coldDirectory ? { coldDirectory: config.archive.coldDirectory } : {}),
      ...(config.requestCapture.archive.enabled ? { requireColdMount: config.archive.requireColdMount } : {}),
      hotDays: config.requestCapture.hotDays
    })),
    close: () => undefined
  };
}

function uniqueRequestLogs<T extends Pick<RequestLog, "id" | "startedAt">>(requestLogs: readonly T[]): T[] {
  const result = new Map<string, T>();
  for (const requestLog of requestLogs) if (requestLog.id) result.set(requestLog.id, requestLog);
  return [...result.values()];
}
