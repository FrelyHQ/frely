import { AsyncLocalStorage } from "node:async_hooks";
import {
  ROOT_CONTEXT,
  context,
  createContextKey,
  propagation,
  trace,
  type Context,
  type ContextManager,
  type Span,
  type TextMapPropagator,
  type Tracer,
} from "../../../packages/observability/node_modules/@opentelemetry/api";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

interface RecordedSpan {
  attributes: Record<string, unknown>;
  ended: boolean;
  id: string;
  name: string;
  parentId: string | null;
  parentName: string | null;
  status: unknown;
  traceId: string;
}

const mocks = vi.hoisted(() => ({
  queries: null as Record<string, unknown> | null,
  spans: [] as RecordedSpan[],
}));

const activeSpanKey = createContextKey("friday-test-active-span");
const remoteParentIdKey = createContextKey("friday-test-remote-parent-id");
const traceIdKey = createContextKey("friday-test-trace-id");
const activeContexts = new AsyncLocalStorage<Context>();
let nextSpanId = 0;

const contextManager = {
  active: () => activeContexts.getStore() ?? ROOT_CONTEXT,
  with: (active: Context, work: (...args: unknown[]) => unknown, thisArg?: unknown, ...args: unknown[]) => (
    activeContexts.run(active, () => work.call(thisArg, ...args))
  ),
  bind: (_active: Context, target: unknown) => target,
  enable() {
    return this;
  },
  disable() {
    activeContexts.disable();
    return this;
  },
} as ContextManager;

const propagator = {
  inject: () => undefined,
  extract: (active: Context, carrier: unknown, getter: { get(carrier: unknown, key: string): string | string[] | undefined }) => {
    const value = getter.get(carrier, "traceparent");
    const traceparent = Array.isArray(value) ? value[0] ?? "" : value ?? "";
    const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/u.exec(traceparent);
    return match
      ? active.setValue(traceIdKey, match[1]).setValue(remoteParentIdKey, match[2])
      : active;
  },
  fields: () => ["traceparent"],
} as TextMapPropagator;

const tracer = {
  startActiveSpan(name: string, options: Record<string, unknown>, work: (span: Span) => unknown) {
    const active = context.active();
    const parent = active.getValue(activeSpanKey) as RecordedSpan | undefined;
    const remoteParentId = active.getValue(remoteParentIdKey) as string | undefined;
    const span: RecordedSpan = {
      attributes: { ...((options.attributes as Record<string, unknown> | undefined) ?? {}) },
      ended: false,
      id: `span-${++nextSpanId}`,
      name,
      parentId: parent?.id ?? remoteParentId ?? null,
      parentName: parent?.name ?? (remoteParentId ? "remote" : null),
      status: null,
      traceId: (active.getValue(traceIdKey) as string | undefined) ?? "local-trace",
    };
    mocks.spans.push(span);
    const apiSpan = {
      end() {
        span.ended = true;
      },
      setAttribute(key: string, value: unknown) {
        span.attributes[key] = value;
        return this;
      },
      setStatus(status: unknown) {
        span.status = status;
        return this;
      },
    } as Span;
    const child = active.setValue(activeSpanKey, span).setValue(traceIdKey, span.traceId);
    return context.with(child, work, undefined, apiSpan);
  },
} as Tracer;

beforeAll(() => {
  expect(context.setGlobalContextManager(contextManager)).toBe(true);
  expect(propagation.setGlobalPropagator(propagator)).toBe(true);
  expect(trace.setGlobalTracerProvider({ getTracer: () => tracer })).toBe(true);
});

afterAll(() => {
  trace.disable();
  propagation.disable();
  context.disable();
});

vi.mock("@frely/observability/server", async () => (
  import("../../../packages/observability/src/server")
));

vi.mock("@tanstack/react-start/server", () => ({
  defaultStreamHandler: Symbol("stream-handler"),
  createStartHandler: () => async () => {
    const { loadPage } = await import("../pages/owner/teams/page.server");
    const page = await loadPage({ params: {}, search: {} });
    return Response.json(page);
  },
}));

vi.mock("@tanstack/react-start/server-entry", () => ({
  createServerEntry: (entry: unknown) => entry,
}));

vi.mock("./server/observability-bootstrap", () => ({
  registerAdminObservability: vi.fn(async () => undefined),
}));

vi.mock("../lib/server", () => ({
  adminPageServices: async () => ({ application: { queries: mocks.queries } }),
}));

import { recordRepositoryOperation, type RepositoryCollectionAttributes } from "@frely/observability/server";
import serverEntry from "./server";

beforeEach(() => {
  mocks.queries = null;
  mocks.spans.length = 0;
});

describe("Admin production trace closure", () => {
  test("connects an incoming traceparent through the production HTTP, RSC, and Teams query-port path", async () => {
    const queryInputs: unknown[] = [];
    mocks.queries = {
      pageAdminTeamDirectory: async (input: { pageSize?: number }) => {
        queryInputs.push(input);
        const collection: RepositoryCollectionAttributes = { pageSize: input.pageSize ?? 20 };
        return recordRepositoryOperation("queries.teams.pageDirectory", async () => {
          collection.itemsReturned = 0;
          collection.returnedRows = 0;
          return { items: [], rows: [], page: 1, pageSize: 20, total: 0, totalPages: 1 };
        }, collection);
      },
      getAdminTeamDirectoryMetrics: async () => ({
        totalTeams: 0,
        activeTeams: 0,
        activeUsers: 0,
        apiKeyCount: 0,
        totalTokens: 0,
        totalCost: 0,
        totalBudget: 0,
      }),
      listTeamDeleteBlockersForTeams: async () => new Map(),
      getActiveTeamDeletion: async () => undefined,
    };

    const traceId = "0123456789abcdef0123456789abcdef";
    const remoteParentId = "0123456789abcdef";
    const response = await serverEntry.fetch(new Request("http://admin.test/owner/teams", {
      headers: { traceparent: `00-${traceId}-${remoteParentId}-01` },
    }));

    const http = mocks.spans.find((span) => span.name === "friday.http.request");
    const rsc = mocks.spans.find((span) => span.name === "friday.rsc.prepare");
    const repositorySpan = mocks.spans.find((span) => span.name === "friday.repository.operation");
    expect(http).toMatchObject({ traceId, parentId: remoteParentId, parentName: "remote", ended: false });
    expect(rsc).toMatchObject({ traceId, parentId: http?.id, parentName: "friday.http.request", ended: true });
    expect(repositorySpan).toMatchObject({
      traceId,
      parentId: rsc?.id,
      parentName: "friday.rsc.prepare",
      ended: true,
      attributes: {
        operation: "queries.teams.pageDirectory",
        "friday.collection.page_size": 20,
        "friday.collection.items_returned": 0,
        "db.response.returned_rows": 0,
        terminal: "success",
      },
    });
    expect(queryInputs).toEqual([{
      query: "",
      page: 1,
      pageSize: 20,
      sort: "createdAt",
      direction: "asc",
    }]);

    await expect(response.json()).resolves.toMatchObject({ teams: { rows: [], pageSize: 20 } });
    expect(http).toMatchObject({ ended: true, attributes: { terminal: "success" } });
  });
});
