import { readConsoleApiResponse } from "@frely/console-ui/api-error";
import {
  parseRequestCaptureViewResponse,
  type LoadRequestCaptureInput,
  type RequestCaptureViewResponse,
} from "@frely/console-ui/request-capture-dialog";

export async function loadWebRequestCapture(
  input: LoadRequestCaptureInput,
): Promise<RequestCaptureViewResponse> {
  const response = await fetch(
    `/api/user/request-logs/${encodeURIComponent(input.requestId)}/capture?view=${input.view}`,
    input.signal ? { signal: input.signal } : undefined,
  );
  return readConsoleApiResponse<RequestCaptureViewResponse>(
    response,
    "Request capture failed",
    parseRequestCaptureViewResponse,
  );
}
