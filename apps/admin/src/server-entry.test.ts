import { describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handledRequestIds: [] as string[],
  tracedRequestIds: [] as string[],
  payloads: [] as string[],
  sequence: [] as string[],
}));

vi.mock("@frely/observability/server", () => ({
  traceHttpRequest: async (request: Request, work: () => Promise<Response>) => {
    mocks.tracedRequestIds.push(request.headers.get("x-request-id") ?? "");
    return work();
  },
}));

vi.mock("@tanstack/react-start/server", () => ({
  defaultStreamHandler: Symbol("stream-handler"),
  createStartHandler: () => {
    mocks.sequence.push("handler-created");
    return async (request: Request) => {
    mocks.handledRequestIds.push(request.headers.get("x-request-id") ?? "");
    mocks.payloads.push(await request.text());
    return new Response("ok", { headers: { "x-request-id": "req_inner_override" } });
    };
  },
}));

vi.mock("@tanstack/react-start/server-entry", () => ({
  createServerEntry: (entry: unknown) => entry,
}));

vi.mock("./server/observability-bootstrap", () => ({
  registerAdminObservability: vi.fn(async () => {
    mocks.sequence.push("registration-started");
    await Promise.resolve();
    mocks.sequence.push("registration-complete");
  }),
}));

import serverEntry from "./server";

describe("Admin Start outer request contract", () => {
  test("awaits observability registration before creating the first request handler", () => {
    expect(mocks.sequence).toEqual(["registration-started", "registration-complete", "handler-created"]);
  });

  test("uses one sanitized request id for tracing, handling, and response headers", async () => {
    const payload = "--raw\r\nbinary-ish\u0000payload\r\n--raw--";
    const response = await serverEntry.fetch(new Request("http://admin.test/api/upload", {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=raw",
        "x-request-id": "invalid external id",
      },
      body: payload,
    }));

    expect(mocks.tracedRequestIds).toHaveLength(1);
    expect(mocks.tracedRequestIds[0]).toMatch(/^req_[0-9a-f]{24}$/u);
    expect(mocks.handledRequestIds).toEqual(mocks.tracedRequestIds);
    expect(response.headers.get("x-request-id")).toBe(mocks.tracedRequestIds[0]);
    expect(response.headers.get("x-request-id")).not.toBe("req_inner_override");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.payloads).toEqual([payload]);
  });
});
