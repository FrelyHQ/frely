import { createId, requestIdFromHeaders } from "@frely/core";
import { getRequest, getRequestHeaders } from "@tanstack/react-start/server";

const ADMIN_REQUEST_ID_PATTERN = /^req_[A-Za-z0-9][A-Za-z0-9_.-]{0,187}$/u;

export function currentAdminRequest(): Request {
  return getRequest();
}

export function adminRequestHeaders(): Headers {
  return new Headers(getRequestHeaders());
}

export function currentAdminRequestId(): string {
  return requestIdFromHeaders(adminRequestHeaders());
}

export function createAdminRequestScope(request: Request): { request: Request; requestId: string } {
  const externalRequestId = request.headers.get("x-request-id");
  const requestId = externalRequestId !== null && ADMIN_REQUEST_ID_PATTERN.test(externalRequestId)
    ? externalRequestId
    : createId("req");
  const headers = new Headers(request.headers);
  headers.set("x-request-id", requestId);
  return {
    request: new Request(request, { headers }),
    requestId,
  };
}
