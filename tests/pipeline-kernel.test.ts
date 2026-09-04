import { describe, expect, it, vi } from "vitest";
import {
  ExecutionPlanCache,
  PIPELINE_PHASES,
  PipelineHookExecutionError,
  PipelineGuardDeniedError,
  PipelineRequestSession,
  adaptIngressPlugin,
  capabilityToken,
  compileExecutionPlan,
  createPipelineRegistry,
  definePipelineContextKey,
  pluginPermission,
  withPipelineRequest,
  type ExecutionPlanCompilerInput,
  type PipelineContextKey,
  type PipelineHook,
  type PipelinePlugin,
  type PipelinePluginSetting,
} from "../packages/gateway/src/pipeline/index.js";

const BASE_CONFIG_SCHEMA = Object.freeze({
  parse(input: unknown): { label: string } {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid config");
    const object = input as Record<string, unknown>;
    if (Object.keys(object).some((key) => key !== "label") || typeof object.label !== "string") throw new Error("invalid config");
    return { label: object.label };
  },
});

function hook(
  overrides: Partial<PipelineHook<{ label: string }>> = {},
): PipelineHook<{ label: string }> {
  return {
    id: "run",
    phase: "request.normalize",
    kind: "transform",
    requires: [],
    provides: [],
    readsArtifacts: [],
    writesArtifacts: [],
    run: () => ({ outcome: "noop" }),
    ...overrides,
  };
}

function plugin(
  id: string,
  options: Readonly<{
    availability?: "required" | "optional";
    toggleable?: boolean;
    configurable?: boolean;
    hooks?: readonly PipelineHook<{ label: string }>[];
    contextKeys?: readonly PipelineContextKey<unknown>[];
    requires?: readonly ReturnType<typeof capabilityToken>[];
    provides?: readonly ReturnType<typeof capabilityToken>[];
    permissions?: readonly ReturnType<typeof pluginPermission>[];
    applicable?: boolean;
    apiVersion?: number;
  }> = {},
): PipelinePlugin<{ label: string }> {
  const availability = options.availability ?? "required";
  return {
    manifest: {
      id,
      desc: `Test plugin ${id}`,
      apiVersion: options.apiVersion ?? 1,
      behaviorVersion: 2,
      configVersion: 1,
      availability,
      userConfigurable: options.configurable ?? true,
      userToggleable: options.toggleable ?? availability === "optional",
      permissions: options.permissions ?? [],
      requires: options.requires ?? [],
      provides: options.provides ?? [],
    },
    defaultConfig: { label: id },
    configSchema: BASE_CONFIG_SCHEMA,
    configUi: options.configurable === false ? [] : [{
      type: "text",
      key: "label",
      label: "Label",
      description: "Test label",
      required: true,
    }],
    ...(options.contextKeys ? { contextKeys: options.contextKeys } : {}),
    hooks: options.hooks ?? [hook()],
    ...(options.applicable === undefined ? {} : { isApplicable: () => options.applicable! }),
  };
}

function setting(pluginId: string, enabled = true, config: unknown = { label: pluginId }): PipelinePluginSetting {
  return { pluginId, enabled, config, instanceRevision: `pir-${pluginId}` };
}

function compilerInput(
  plugins: readonly PipelinePlugin<unknown>[],
  settings: readonly PipelinePluginSetting[] = [],
  overrides: Partial<ExecutionPlanCompilerInput> = {},
): ExecutionPlanCompilerInput {
  return {
    kernelApiVersion: 1,
    plugins,
    settings: { revision: "settings-1", settings },
    applicability: { cacheKey: "chat-global", facts: Object.freeze({ endpoint: "chat" }) },
    ...overrides,
  };
}

describe("pipeline contracts and compiler", () => {
  it("exposes the fixed, low-cardinality phase order", () => {
    expect(PIPELINE_PHASES).toEqual([
      "request.ingress", "request.decode", "request.normalize", "request.estimate",
      "policy.pre-resolution", "access.candidates", "access.select", "policy.post-resolution",
      "pricing.quote", "provider.request", "provider.invoke", "response.decode",
      "response.transform", "stream.transform", "usage.measure", "billing.calculate",
      "response.egress", "observability",
    ]);
    expect(Object.isFrozen(PIPELINE_PHASES)).toBe(true);
  });

  it("filters disabled optional plugins and rejects disabling required or non-toggleable plugins", () => {
    const optional = plugin("optional-one", { availability: "optional" });
    const required = plugin("required-one");
    const defaultPlan = compileExecutionPlan(compilerInput([optional, required]));
    expect(defaultPlan.requestHooks.map((entry) => entry.pluginId)).toEqual(["required-one"]);

    const enabledPlan = compileExecutionPlan(compilerInput([optional, required], [setting("optional-one")]));
    expect(enabledPlan.requestHooks.map((entry) => entry.pluginId)).toEqual(["optional-one", "required-one"]);
    expect(() => compileExecutionPlan(compilerInput([required], [setting("required-one", false)])))
      .toThrow("cannot be disabled");

    const staticOptional = plugin("static-optional", { availability: "optional", toggleable: false });
    expect(() => compileExecutionPlan(compilerInput([staticOptional], [setting("static-optional", false)])))
      .toThrow("cannot be disabled");
  });

  it("strictly validates API, manifest, setting and configuration input", () => {
    expect(() => compileExecutionPlan(compilerInput([plugin("wrong-api", { apiVersion: 2 })])))
      .toThrow("requires API 2");
    expect(() => compileExecutionPlan(compilerInput([plugin("required-toggle", { toggleable: true })])))
      .toThrow("cannot be user-toggleable");
    expect(() => compileExecutionPlan(compilerInput([plugin("plain", { configurable: false })], [setting("plain")])))
      .toThrow("not user-configurable");
    expect(() => compileExecutionPlan(compilerInput([plugin("known")], [setting("unknown")])))
      .toThrow("Unknown pipeline plugin setting");
    expect(() => compileExecutionPlan(compilerInput([plugin("known")], [{
      ...setting("known"),
      priority: 10,
    } as PipelinePluginSetting])))
      .toThrow("Unknown pipeline setting field: priority");
    expect(() => compileExecutionPlan(compilerInput(
      [plugin("known")],
      [setting("known", true, { label: "ok", executable: "require('x')" })],
    ))).toThrow("invalid config");

    expect(() => compileExecutionPlan(compilerInput([plugin("invalid-artifact", {
      hooks: [hook({ readsArtifacts: ["unknown-artifact" as never] })],
    })]))).toThrow("Invalid invalid-artifact/run artifact read");
    expect(() => compileExecutionPlan(compilerInput([plugin("writes-original", {
      hooks: [hook({ writesArtifacts: ["originalRequest"] })],
    })]))).toThrow("artifact write cannot include originalRequest");
    expect(() => compileExecutionPlan(compilerInput([plugin("missing-artifacts", {
      hooks: [{ ...hook(), readsArtifacts: undefined } as unknown as PipelineHook<{ label: string }>],
    })]))).toThrow("must be an explicit artifact allowlist");
  });

  it("uses deterministic ID ordering instead of registry array order", () => {
    const first = compileExecutionPlan(compilerInput([plugin("zeta"), plugin("alpha")]));
    const second = compileExecutionPlan(compilerInput([plugin("alpha"), plugin("zeta")]));
    expect(first.hooksByPhase["request.normalize"].map((entry) => entry.pluginId)).toEqual(["alpha", "zeta"]);
    expect(second.hooksByPhase["request.normalize"].map((entry) => entry.pluginId)).toEqual(["alpha", "zeta"]);
  });

  it("builds a static registry and rejects duplicate IDs before planning", () => {
    const registry = createPipelineRegistry([plugin("alpha"), plugin("beta")], 1);
    expect(registry.plugins.map((entry) => entry.manifest.id)).toEqual(["alpha", "beta"]);
    expect(registry.get("beta")?.manifest.id).toBe("beta");
    expect(Object.isFrozen(registry.plugins)).toBe(true);
    expect(() => createPipelineRegistry([plugin("same"), plugin("same")], 1)).toThrow("Duplicate pipeline plugin ID");
  });

  it("orders capability and before/after dependencies and rejects missing, duplicate and late providers", () => {
    const normalized = capabilityToken("request:normalized");
    const producer = plugin("producer", {
      provides: [normalized],
      hooks: [hook({ id: "produce", provides: [normalized] })],
    });
    const consumer = plugin("consumer", {
      requires: [normalized],
      hooks: [hook({ id: "consume", requires: [normalized] })],
    });
    const plan = compileExecutionPlan(compilerInput([consumer, producer]));
    expect(plan.hooksByPhase["request.normalize"].map((entry) => entry.ref))
      .toEqual(["producer/produce", "consumer/consume"]);

    const ordered = plugin("ordered", {
      hooks: [
        hook({ id: "last", after: ["ordered/first"] }),
        hook({ id: "first" }),
      ],
    });
    expect(compileExecutionPlan(compilerInput([ordered])).hooksByPhase["request.normalize"].map((entry) => entry.ref))
      .toEqual(["ordered/first", "ordered/last"]);

    expect(() => compileExecutionPlan(compilerInput([consumer]))).toThrow("Missing capability");
    expect(() => compileExecutionPlan(compilerInput([producer, plugin("producer-two", {
      provides: [normalized], hooks: [hook({ provides: [normalized] })],
    })], [], { singletonCapabilities: [normalized] }))).toThrow("Duplicate singleton capability provider");

    const lateProducer = plugin("late", {
      provides: [normalized], hooks: [hook({ phase: "provider.request", provides: [normalized] })],
    });
    expect(() => compileExecutionPlan(compilerInput([consumer, lateProducer]))).toThrow("produced after consumer");
  });

  it("rejects dependency cycles", () => {
    const cyclic = plugin("cyclic", {
      hooks: [
        hook({ id: "one", after: ["cyclic/two"] }),
        hook({ id: "two", after: ["cyclic/one"] }),
      ],
    });
    expect(() => compileExecutionPlan(compilerInput([cyclic]))).toThrow("dependency cycle");
  });

  it("validates context ownership, visibility, producer ordering and uniqueness", () => {
    const shared = definePipelineContextKey<unknown>({
      id: "producer:parsed",
      ownerPluginId: "producer",
      visibility: "shared",
      mode: "artifact",
    });
    const producer = plugin("producer", {
      contextKeys: [shared], hooks: [hook({ id: "produce", providesContext: [shared] })],
    });
    const consumer = plugin("consumer", {
      hooks: [hook({ id: "consume", requiresContext: [shared] })],
    });
    expect(compileExecutionPlan(compilerInput([consumer, producer])).hooksByPhase["request.normalize"].map((entry) => entry.ref))
      .toEqual(["producer/produce", "consumer/consume"]);

    const missing = plugin("missing", { hooks: [hook({ requiresContext: [shared] })] });
    expect(() => compileExecutionPlan(compilerInput([missing]))).toThrow("Unknown required context key");

    const privateKey = definePipelineContextKey<unknown>({
      id: "owner:private-cache", ownerPluginId: "owner", visibility: "private", mode: "owner-cache",
    });
    const owner = plugin("owner", { contextKeys: [privateKey], hooks: [hook({ providesContext: [privateKey] })] });
    const intruder = plugin("intruder", { hooks: [hook({ requiresContext: [privateKey] })] });
    expect(() => compileExecutionPlan(compilerInput([owner, intruder]))).toThrow("cannot require private context key");

    const duplicateOwner = plugin("producer", { contextKeys: [shared] });
    expect(() => compileExecutionPlan(compilerInput([producer, duplicateOwner]))).toThrow("Duplicate pipeline plugin ID");

    const sensitive = definePipelineContextKey<unknown>({
      id: "safe:authorization-token", ownerPluginId: "safe", visibility: "private", mode: "artifact",
    });
    expect(() => compileExecutionPlan(compilerInput([plugin("safe", { contextKeys: [sensitive] })])))
      .toThrow("may not name sensitive material");
  });

  it("injects only declared ports and rejects absent permission ports", async () => {
    const read = pluginPermission("pricing:read");
    const invoke = vi.fn((invocation: { ports: Readonly<Record<string, unknown>> }) => {
      expect(invocation.ports).toEqual({ [read]: "pricing-port" });
      return { outcome: "noop" as const };
    });
    const priced = plugin("priced", { permissions: [read], hooks: [hook({ run: invoke as never })] });
    expect(() => compileExecutionPlan(compilerInput([priced]))).toThrow("Missing permission port");
    const plan = compileExecutionPlan(compilerInput([priced], [], {
      availablePorts: new Map([[read, "pricing-port"]]),
    }));
    await withPipelineRequest(plan, { originalRequest: {} }, (session) => session.executeAll());
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("compiles out statically inapplicable plugins", () => {
    const plan = compileExecutionPlan(compilerInput([plugin("excluded", { applicable: false }), plugin("included", { applicable: true })]));
    expect(plan.requestHooks.map((entry) => entry.pluginId)).toEqual(["included"]);
  });

  it("returns an immutable plan without retaining mutable Map/Set methods", () => {
    const plan = compileExecutionPlan(compilerInput([plugin("frozen")]));
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.requestHooks)).toBe(true);
    expect(Object.isFrozen(plan.hooksByPhase["request.normalize"])).toBe(true);
    expect((plan.contextKeys as Map<string, unknown>).set).toBeUndefined();
    expect((plan.requestHooks[0]!.readableContextKeyIds as Set<string>).add).toBeUndefined();
    expect(Object.isFrozen(plan.requestHooks[0]!.config)).toBe(true);
  });
});

describe("execution plan cache", () => {
  it("caches by controlled revisions and keeps started requests on their original plan", () => {
    const cache = new ExecutionPlanCache(2);
    const oldInput = compilerInput([plugin("cached")]);
    const oldPlan = cache.getOrCompile(oldInput);
    expect(cache.getOrCompile(oldInput)).toBe(oldPlan);

    const newInput = compilerInput([plugin("cached")], [], {
      settings: { revision: "settings-2", settings: [] },
    });
    const newPlan = cache.getOrCompile(newInput);
    expect(newPlan).not.toBe(oldPlan);
    expect(oldPlan.settingsRevision).toBe("settings-1");
    expect(newPlan.settingsRevision).toBe("settings-2");
  });

  it("does not reuse an old plan when a new revision fails compilation", () => {
    const cache = new ExecutionPlanCache();
    const valid = cache.getOrCompile(compilerInput([plugin("valid")]));
    expect(() => cache.getOrCompile(compilerInput([plugin("invalid", { apiVersion: 2 })], [], {
      settings: { revision: "settings-2", settings: [] },
    }))).toThrow("requires API 2");
    expect(cache.size).toBe(1);
    expect(cache.getOrCompile(compilerInput([plugin("valid")]))).toBe(valid);
  });

  it("bounds cache cardinality", () => {
    const cache = new ExecutionPlanCache(2);
    for (const revision of ["one", "two", "three"]) {
      cache.getOrCompile(compilerInput([plugin("bounded")], [], {
        settings: { revision, settings: [] },
      }));
    }
    expect(cache.size).toBe(2);
    cache.invalidate();
    expect(cache.size).toBe(0);
  });
});

describe("pipeline request context and executor", () => {
  it("enforces context owner write, shared read, artifact write-once and owner-cache updates", async () => {
    const shared = definePipelineContextKey<{ parsed: boolean }>({
      id: "producer:parsed", ownerPluginId: "producer", visibility: "shared", mode: "artifact",
    });
    const cache = definePipelineContextKey<{ count: number }>({
      id: "producer:memo", ownerPluginId: "producer", visibility: "private", mode: "owner-cache",
    });
    const observed: unknown[] = [];
    const producer = plugin("producer", {
      contextKeys: [shared, cache],
      hooks: [hook({
        id: "produce",
        providesContext: [shared, cache],
        run(invocation) {
          invocation.context.set(shared, { parsed: true });
          invocation.context.set(cache, { count: 1 });
          invocation.context.set(cache, { count: 2 });
          expect(() => invocation.context.set(shared, { parsed: false })).toThrow("write-once");
          return { outcome: "applied" };
        },
      })],
    });
    const consumer = plugin("consumer", {
      hooks: [hook({
        id: "consume",
        requiresContext: [shared],
        run(invocation) {
          const value = invocation.context.get(shared);
          observed.push(value);
          expect(Object.isFrozen(value)).toBe(true);
          expect(() => invocation.context.set(shared, { parsed: false })).toThrow("cannot write");
          return { outcome: "noop" };
        },
      })],
    });
    const plan = compileExecutionPlan(compilerInput([consumer, producer]));
    await withPipelineRequest(plan, { originalRequest: {} }, (session) => session.executeAll());
    expect(observed).toEqual([{ parsed: true }]);
  });

  it("publishes artifacts once with structural sharing", async () => {
    const payload = { messages: ["hello"] };
    const publish = plugin("publish", {
      hooks: [hook({ writesArtifacts: ["accessResolution"], run: () => ({ outcome: "applied", artifacts: { accessResolution: payload } }) })],
    });
    const duplicate = plugin("second", {
      hooks: [hook({ writesArtifacts: ["accessResolution"], after: ["publish"], run: () => ({ outcome: "applied", artifacts: { accessResolution: {} } }) })],
    });
    const plan = compileExecutionPlan(compilerInput([publish, duplicate]));
    await expect(withPipelineRequest(plan, { originalRequest: {} }, (session) => session.executeAll()))
      .rejects.toMatchObject({ code: "pipeline_hook_failed" });
    expect(Object.isFrozen(payload)).toBe(true);
  });

  it("rejects hook artifact reads and writes outside the compiled allowlist", async () => {
    const unauthorizedRead = plugin("unauthorized-read", {
      hooks: [hook({
        readsArtifacts: [],
        run(invocation) {
          invocation.artifacts.get("originalRequest");
          return { outcome: "noop" };
        },
      })],
    });
    await expect(withPipelineRequest(
      compileExecutionPlan(compilerInput([unauthorizedRead])),
      { originalRequest: { prompt: "hidden" } },
      (session) => session.executeAll(),
    )).rejects.toMatchObject({
      code: "pipeline_hook_failed",
      cause: expect.objectContaining({ message: "Plugin unauthorized-read cannot read pipeline artifact originalRequest" }),
    });

    const unauthorizedWrite = plugin("unauthorized-write", {
      hooks: [hook({
        writesArtifacts: ["canonicalRequest"],
        run: () => ({ outcome: "applied", artifacts: { accessResolution: {} } }),
      })],
    });
    await expect(withPipelineRequest(
      compileExecutionPlan(compilerInput([unauthorizedWrite])),
      { originalRequest: {} },
      (session) => session.executeAll(),
    )).rejects.toMatchObject({
      code: "pipeline_hook_failed",
      cause: expect.objectContaining({ message: "Plugin unauthorized-write cannot write pipeline artifact accessResolution" }),
    });
  });

  it("lets only the trusted composition root publish write-once authoritative artifacts", () => {
    const session = new PipelineRequestSession(
      compileExecutionPlan(compilerInput([plugin("trusted-publish")])),
      { originalRequest: {} },
    );
    const selection = { subscriptionId: "sub_1" };
    session.publishTrustedArtifacts({ subscriptionSelection: selection, budgetDecision: { outcome: "allow" } });
    expect(session.context.artifactReader().get("subscriptionSelection")).toBe(selection);
    expect(Object.isFrozen(selection)).toBe(true);
    expect(() => session.publishTrustedArtifacts({ subscriptionSelection: { subscriptionId: "sub_2" } }))
      .toThrow("Trusted pipeline artifact is write-once: subscriptionSelection");
    expect(() => session.publishTrustedArtifacts({
      priceQuote: { amount: 1 },
      subscriptionSelection: { subscriptionId: "sub_3" },
    })).toThrow("Trusted pipeline artifact is write-once: subscriptionSelection");
    expect(session.context.artifactReader().has("priceQuote")).toBe(false);
    expect(() => session.publishTrustedArtifacts({ originalRequest: {} }))
      .toThrow("Trusted pipeline artifact is write-once: originalRequest");
    session.finish();
  });

  it("skips runtime-inapplicable hooks without calling or recording them", async () => {
    const run = vi.fn(() => ({ outcome: "noop" as const }));
    const skipped = plugin("skipped", { hooks: [hook({ isApplicable: () => false, run })] });
    const plan = compileExecutionPlan(compilerInput([skipped]));
    await withPipelineRequest(plan, { originalRequest: {} }, async (session) => {
      await session.executeAll();
      expect(session.invocationSnapshot().invocations).toEqual([]);
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("records bounded, allowlisted invocation facts only", async () => {
    const plan = compileExecutionPlan(compilerInput([plugin("facts", {
      hooks: [hook({ run: () => ({ outcome: "applied" }) })],
    })], [setting("facts", true, { label: "prompt must stay out" })]));
    await withPipelineRequest(plan, { originalRequest: { prompt: "secret prompt" } }, async (session) => {
      await session.executeAll();
      const snapshot = session.invocationSnapshot();
      expect(snapshot).toEqual({
        schemaVersion: 1,
        planRevision: plan.planRevision,
        invocations: [{
          pluginId: "facts",
          behaviorVersion: 2,
          hook: "request.normalize",
          instanceRevision: "pir-facts",
          outcome: "applied",
        }],
      });
      expect(JSON.stringify(snapshot)).not.toContain("prompt must stay out");
      expect(JSON.stringify(snapshot)).not.toContain("secret prompt");
    });

    const twoHooks = plugin("overflow", { hooks: [hook({ id: "one" }), hook({ id: "two" })] });
    const session = new PipelineRequestSession(compileExecutionPlan(compilerInput([twoHooks])), { originalRequest: {} }, { maxInvocationFacts: 1 });
    await expect(session.executeAll()).rejects.toThrow("fact limit exceeded");
    session.finish();
  });

  it("fails closed for ordinary hooks and continues failed best-effort observe hooks", async () => {
    const failure = new Error("boom");
    const strict = plugin("strict", { hooks: [hook({ run: () => { throw failure; } })] });
    await expect(withPipelineRequest(
      compileExecutionPlan(compilerInput([strict])),
      { originalRequest: {} },
      (session) => session.executeAll(),
    )).rejects.toMatchObject({
      name: "PipelineHookExecutionError",
      code: "pipeline_hook_failed",
      pluginId: "strict",
    });

    const observe = plugin("observer", { hooks: [hook({
      phase: "observability", kind: "observe", bestEffort: true, run: () => { throw failure; },
    })] });
    await withPipelineRequest(compileExecutionPlan(compilerInput([observe])), { originalRequest: {} }, async (session) => {
      await session.executeAll();
      expect(session.invocationSnapshot().invocations[0]?.outcome).toBe("failed");
    });
  });

  it("stops the pipeline on a denied guard and prevents duplicate hook execution", async () => {
    const after = vi.fn(() => ({ outcome: "noop" as const }));
    const guarded = plugin("guarded", { hooks: [hook({ kind: "guard", run: () => ({ outcome: "denied" }) })] });
    const later = plugin("later", { hooks: [hook({ after: ["guarded"], run: after })] });
    const plan = compileExecutionPlan(compilerInput([later, guarded]));
    await expect(withPipelineRequest(plan, { originalRequest: {} }, (session) => session.executeAll()))
      .rejects.toBeInstanceOf(PipelineGuardDeniedError);
    expect(after).not.toHaveBeenCalled();

    const session = new PipelineRequestSession(compileExecutionPlan(compilerInput([plugin("once")])), { originalRequest: {} });
    await session.executePhase("request.normalize");
    await expect(session.executePhase("request.normalize")).rejects.toThrow("already executed");
    session.finish();
  });

  it("propagates abort and timeout as stable failures", async () => {
    const controller = new AbortController();
    controller.abort("client gone");
    const plan = compileExecutionPlan(compilerInput([plugin("aborted")]));
    await expect(withPipelineRequest(plan, { originalRequest: {} }, (session) => session.executeAll(), {
      signal: controller.signal,
    })).rejects.toMatchObject({ code: "pipeline_hook_aborted" });

    const timed = plugin("timed", { hooks: [hook({
      timeoutMs: 5,
      run: () => new Promise(() => undefined),
    })] });
    await expect(withPipelineRequest(
      compileExecutionPlan(compilerInput([timed])),
      { originalRequest: {} },
      (session) => session.executeAll(),
    )).rejects.toMatchObject({ code: "pipeline_hook_timeout" });
  });

  it("releases context after normal return and failure", async () => {
    const plan = compileExecutionPlan(compilerInput([plugin("lifecycle")]));
    let normal: PipelineRequestSession | undefined;
    await withPipelineRequest(plan, { originalRequest: {} }, async (session) => {
      normal = session;
      await session.executeAll();
    });
    expect(normal?.finished).toBe(true);
    expect(normal?.context.disposed).toBe(true);
    expect(() => normal?.context.artifactReader().has("originalRequest")).toThrow("disposed");

    let failed: PipelineRequestSession | undefined;
    await expect(withPipelineRequest(plan, { originalRequest: {} }, (session) => {
      failed = session;
      throw new Error("caller failed");
    })).rejects.toThrow("caller failed");
    expect(failed?.context.disposed).toBe(true);
  });

  it("keeps stream context until close and releases it on cancel with backpressure", async () => {
    let pulls = 0;
    let canceled: unknown;
    const source = new ReadableStream<number>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(pulls);
      },
      cancel(reason) { canceled = reason; },
    }, { highWaterMark: 0 });
    const session = new PipelineRequestSession(compileExecutionPlan(compilerInput([plugin("stream-life")])), { originalRequest: {} });
    const stream = session.wrapStream(source);
    expect(pulls).toBe(0);
    const reader = stream.getReader();
    expect((await reader.read()).value).toBe(1);
    expect(session.finished).toBe(false);
    await reader.cancel("stop");
    expect(canceled).toBe("stop");
    expect(session.finished).toBe(true);
    expect(session.context.disposed).toBe(true);
  });

  it("wraps AsyncIterable pull-first and calls upstream return once on cancellation", async () => {
    const next = vi.fn()
      .mockResolvedValueOnce({ done: false, value: 1 })
      .mockResolvedValue({ done: true, value: undefined });
    const upstreamReturn = vi.fn().mockResolvedValue({ done: true, value: undefined });
    const source: AsyncIterable<number> = {
      [Symbol.asyncIterator]: () => ({ next, return: upstreamReturn }),
    };
    const session = new PipelineRequestSession(compileExecutionPlan(compilerInput([plugin("iterable-life")])), { originalRequest: {} });
    const wrapped = session.wrapAsyncIterable(source);
    expect(next).not.toHaveBeenCalled();
    const iterator = wrapped[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ done: false, value: 1 });
    expect(session.finished).toBe(false);
    await iterator.return?.("stop");
    await iterator.return?.("stop again");
    expect(upstreamReturn).toHaveBeenCalledOnce();
    expect(session.finished).toBe(true);
  });

  it("releases AsyncIterable context on done and source error", async () => {
    const doneSession = new PipelineRequestSession(compileExecutionPlan(compilerInput([plugin("iterable-done")])), { originalRequest: {} });
    const done = doneSession.wrapAsyncIterable((async function* () { yield 1; })());
    const doneIterator = done[Symbol.asyncIterator]();
    await doneIterator.next();
    expect((await doneIterator.next()).done).toBe(true);
    expect(doneSession.finished).toBe(true);

    const errorSession = new PipelineRequestSession(compileExecutionPlan(compilerInput([plugin("iterable-error")])), { originalRequest: {} });
    const failed: AsyncIterable<number> = {
      [Symbol.asyncIterator]: () => ({ next: async () => { throw new Error("stream failed"); } }),
    };
    await expect(errorSession.wrapAsyncIterable(failed)[Symbol.asyncIterator]().next()).rejects.toThrow("stream failed");
    expect(errorSession.finished).toBe(true);
  });
});

describe("IngressPlugin compatibility adapter", () => {
  it("preserves applicability, matched/noop, output and error semantics", async () => {
    const transform = vi.fn((_context, payload: Readonly<Record<string, unknown>>) => ({
      payload: { ...payload, transformed: true }, matched: true,
    }));
    const legacy = {
      id: "legacy-ingress",
      desc: "Legacy ingress",
      version: 3,
      defaultConfig: { label: "legacy" },
      configSchema: BASE_CONFIG_SCHEMA,
      configUi: [{ type: "text", key: "label", label: "Label", description: "Label", required: true }],
      isApplicable: (_context: unknown, payload: Readonly<Record<string, unknown>>) => payload.enabled === true,
      transformIngressRequest: transform,
    };
    const adapted = adaptIngressPlugin(legacy);
    const plan = compileExecutionPlan(compilerInput([adapted], [setting("legacy-ingress", true, { label: "configured" })]));
    await withPipelineRequest(plan, {
      originalRequest: { kind: "chat.completions", payload: { enabled: true } },
    }, async (session) => {
      await session.executeAll();
      expect(session.context.artifactReader().get("effectiveSourceRequest")).toEqual({
        kind: "chat.completions", payload: { enabled: true, transformed: true },
      });
      expect(session.invocationSnapshot().invocations).toEqual([{
        pluginId: "legacy-ingress",
        behaviorVersion: 3,
        hook: "request.ingress",
        instanceRevision: "pir-legacy-ingress",
        outcome: "applied",
      }]);
    });

    await withPipelineRequest(plan, {
      originalRequest: { kind: "chat.completions", payload: { enabled: false } },
    }, async (session) => {
      await session.executeAll();
      expect(session.invocationSnapshot().invocations).toEqual([]);
    });
    expect(transform).toHaveBeenCalledOnce();

    const unmatched = adaptIngressPlugin({
      ...legacy,
      id: "legacy-unmatched",
      isApplicable: () => true,
      transformIngressRequest: (_context, payload) => ({ payload: { ...payload }, matched: false }),
    });
    const unmatchedPlan = compileExecutionPlan(compilerInput([unmatched], [setting("legacy-unmatched")]));
    await withPipelineRequest(unmatchedPlan, {
      originalRequest: { kind: "responses", payload: {} },
    }, async (session) => {
      await session.executeAll();
      expect(session.invocationSnapshot().invocations[0]?.outcome).toBe("noop");
    });

    const broken = adaptIngressPlugin({
      ...legacy,
      id: "legacy-broken",
      isApplicable: () => true,
      transformIngressRequest: () => { throw new Error("legacy error"); },
    });
    await expect(withPipelineRequest(
      compileExecutionPlan(compilerInput([broken], [setting("legacy-broken")])),
      { originalRequest: { kind: "responses", payload: {} } },
      (session) => session.executeAll(),
    )).rejects.toBeInstanceOf(PipelineHookExecutionError);
  });

  it("chains two ingress adapters in code-defined order", async () => {
    const first = adaptIngressPlugin({
      id: "first-ingress",
      desc: "First",
      version: 1,
      defaultConfig: { label: "first" },
      configSchema: BASE_CONFIG_SCHEMA,
      configUi: [],
      isApplicable: () => true,
      transformIngressRequest: (_context, payload) => ({
        matched: true,
        payload: { ...payload, order: [...((payload.order as string[] | undefined) ?? []), "first"] },
      }),
    }, { before: ["second-ingress"] });
    const second = adaptIngressPlugin({
      id: "second-ingress",
      desc: "Second",
      version: 1,
      defaultConfig: { label: "second" },
      configSchema: BASE_CONFIG_SCHEMA,
      configUi: [],
      isApplicable: () => true,
      transformIngressRequest: (_context, payload) => ({
        matched: true,
        payload: { ...payload, order: [...((payload.order as string[] | undefined) ?? []), "second"] },
      }),
    }, { after: ["first-ingress"] });
    const plan = compileExecutionPlan(compilerInput(
      [second, first],
      [setting("first-ingress"), setting("second-ingress")],
    ));
    expect(plan.hooksByPhase["request.ingress"].map((entry) => entry.pluginId)).toEqual(["first-ingress", "second-ingress"]);
    await withPipelineRequest(plan, {
      originalRequest: { kind: "responses", payload: {} },
    }, async (session) => {
      await session.executeAll();
      expect(session.context.artifactReader().get("effectiveSourceRequest")).toEqual({
        kind: "responses", payload: { order: ["first", "second"] },
      });
      expect(session.invocationSnapshot().invocations.map((fact) => fact.pluginId)).toEqual(["first-ingress", "second-ingress"]);
    });
  });
});
