import {
  PIPELINE_PHASES,
  type CompiledPipelineHook,
  type ExecutionPlan,
  type PipelineArtifacts,
  type PipelineHookInvocation,
  type PipelineHookResult,
  type PipelineInvocationFact,
  type PipelineInvocationSnapshot,
  type PipelineOutcome,
  type PipelinePhase,
} from "./contracts.js";
import { PipelineRequestContext } from "./context.js";

const OUTCOMES = new Set<PipelineOutcome>(["applied", "noop", "denied", "failed", "fallback"]);
const RESULT_KEYS = new Set(["outcome", "artifacts"]);

export class PipelineHookExecutionError extends Error {
  readonly pluginId: string;
  readonly phase: PipelinePhase;
  readonly code: "pipeline_hook_aborted" | "pipeline_hook_failed" | "pipeline_hook_timeout";

  constructor(
    code: PipelineHookExecutionError["code"],
    hook: CompiledPipelineHook,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PipelineHookExecutionError";
    this.pluginId = hook.pluginId;
    this.phase = hook.phase;
    this.code = code;
  }
}

export class PipelineGuardDeniedError extends Error {
  readonly pluginId: string;
  readonly phase: PipelinePhase;
  readonly code = "pipeline_guard_denied" as const;

  constructor(hook: CompiledPipelineHook) {
    super(`Pipeline guard denied the request: ${hook.ref}`);
    this.name = "PipelineGuardDeniedError";
    this.pluginId = hook.pluginId;
    this.phase = hook.phase;
  }
}

function validateResult(result: PipelineHookResult): PipelineHookResult {
  if (!result || typeof result !== "object") throw new Error("Pipeline hook must return a result object");
  for (const key of Object.keys(result)) {
    if (!RESULT_KEYS.has(key)) throw new Error(`Unknown pipeline hook result field: ${key}`);
  }
  if (!OUTCOMES.has(result.outcome)) {
    throw new Error(`Invalid pipeline hook outcome: ${String(result.outcome)}`);
  }
  if (result.artifacts !== undefined && (result.artifacts === null || typeof result.artifacts !== "object" || Array.isArray(result.artifacts))) {
    throw new Error("Pipeline hook artifacts must be an object");
  }
  return result;
}

function abortError(hook: CompiledPipelineHook, signal: AbortSignal): PipelineHookExecutionError {
  return new PipelineHookExecutionError(
    "pipeline_hook_aborted",
    hook,
    `Pipeline hook aborted: ${hook.ref}`,
    { cause: signal.reason },
  );
}

async function invokeWithDeadline(
  hook: CompiledPipelineHook,
  invocation: PipelineHookInvocation<unknown>,
  hookController: AbortController,
): Promise<PipelineHookResult> {
  if (invocation.signal.aborted) throw abortError(hook, invocation.signal);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;
  try {
    const operation = Promise.resolve().then(() => hook.run(invocation));
    const races: Promise<PipelineHookResult>[] = [operation];
    races.push(new Promise<never>((_resolve, reject) => {
      const onAbort = (): void => reject(abortError(hook, invocation.signal));
      invocation.signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => invocation.signal.removeEventListener("abort", onAbort);
    }));
    if (hook.timeoutMs !== undefined) {
      races.push(new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          const error = new PipelineHookExecutionError(
            "pipeline_hook_timeout",
            hook,
            `Pipeline hook timed out: ${hook.ref}`,
          );
          reject(error);
          hookController.abort(error);
        }, hook.timeoutMs);
        timeout.unref?.();
      }));
    }
    return validateResult(await Promise.race(races));
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    removeAbortListener?.();
  }
}

export class PipelineRequestSession {
  readonly plan: ExecutionPlan;
  readonly context: PipelineRequestContext;
  readonly #signal: AbortSignal;
  readonly #maxInvocationFacts: number;
  readonly #facts: PipelineInvocationFact[] = [];
  readonly #executedHooks = new Set<string>();
  #finished = false;

  constructor(
    plan: ExecutionPlan,
    artifacts: PipelineArtifacts,
    options: Readonly<{ signal?: AbortSignal; maxInvocationFacts?: number }> = {},
  ) {
    this.plan = plan;
    this.context = new PipelineRequestContext(artifacts);
    this.#signal = options.signal ?? new AbortController().signal;
    this.#maxInvocationFacts = options.maxInvocationFacts ?? 128;
    if (!Number.isSafeInteger(this.#maxInvocationFacts) || this.#maxInvocationFacts < 1 || this.#maxInvocationFacts > 1024) {
      throw new Error("maxInvocationFacts must be between 1 and 1024");
    }
  }

  get finished(): boolean {
    return this.#finished;
  }

  async executeHook(hook: CompiledPipelineHook): Promise<PipelineHookResult | undefined> {
    this.#assertActive();
    if (this.#executedHooks.has(hook.ref)) throw new Error(`Pipeline hook already executed: ${hook.ref}`);
    if (this.#facts.length >= this.#maxInvocationFacts) throw new Error("Pipeline invocation fact limit exceeded");
    this.#executedHooks.add(hook.ref);
    const hookController = new AbortController();
    const forwardAbort = (): void => hookController.abort(this.#signal.reason);
    if (this.#signal.aborted) forwardAbort();
    else this.#signal.addEventListener("abort", forwardAbort, { once: true });
    const contextView = this.context.createView(
      hook.pluginId,
      hook.readableContextKeyIds,
      hook.writableContextKeyIds,
      this.plan.contextKeys,
    );
    const invocation: PipelineHookInvocation<unknown> = Object.freeze({
      pluginId: hook.pluginId,
      phase: hook.phase,
      config: hook.config,
      artifacts: this.context.createArtifactReader(hook.pluginId, hook.readableArtifactNames),
      context: contextView.data,
      ports: hook.ports,
      signal: hookController.signal,
    });
    try {
      if (hookController.signal.aborted) throw abortError(hook, hookController.signal);
      if (hook.isApplicable && !hook.isApplicable(invocation)) return undefined;
      for (const keyId of hook.requiredContextKeyIds) {
        const key = this.plan.contextKeys.get(keyId)!;
        if (!invocation.context.has(key)) throw new Error(`Required pipeline context is unavailable: ${keyId}`);
      }
      const result = await invokeWithDeadline(hook, invocation, hookController);
      if (result.artifacts) this.context.publishHookArtifacts(hook.pluginId, result.artifacts, hook.writableArtifactNames);
      this.#record(hook, result.outcome);
      return result;
    } catch (error) {
      this.#record(hook, "failed");
      if (hook.bestEffort) return undefined;
      if (error instanceof PipelineHookExecutionError) throw error;
      throw new PipelineHookExecutionError(
        "pipeline_hook_failed",
        hook,
        `Pipeline hook failed: ${hook.ref}`,
        { cause: error },
      );
    } finally {
      this.#signal.removeEventListener("abort", forwardAbort);
      contextView.revoke();
      if (!hookController.signal.aborted) hookController.abort("hook invocation finished");
    }
  }

  async executePhase(phase: PipelinePhase): Promise<readonly PipelineHookResult[]> {
    const results: PipelineHookResult[] = [];
    for (const hook of this.plan.hooksByPhase[phase]) {
      const result = await this.executeHook(hook);
      if (result) {
        results.push(result);
        if (result.outcome === "denied") throw new PipelineGuardDeniedError(hook);
      }
    }
    return Object.freeze(results);
  }

  async executePhases(phases: readonly PipelinePhase[]): Promise<void> {
    for (const phase of phases) await this.executePhase(phase);
  }

  async executeAll(): Promise<void> {
    await this.executePhases(PIPELINE_PHASES);
  }

  invocationSnapshot(): PipelineInvocationSnapshot {
    return Object.freeze({
      schemaVersion: 1,
      planRevision: this.plan.planRevision,
      invocations: Object.freeze([...this.#facts]),
    });
  }

  publishTrustedArtifacts(patch: Readonly<Partial<PipelineArtifacts>>): void {
    this.#assertActive();
    this.context.publishTrustedArtifacts(patch);
  }

  wrapStream<T>(source: ReadableStream<T>): ReadableStream<T> {
    this.#assertActive();
    const reader = source.getReader();
    const finish = (): void => this.finish();
    return new ReadableStream<T>({
      pull: async (controller) => {
        try {
          const next = await reader.read();
          if (next.done) {
            controller.close();
            finish();
          } else {
            controller.enqueue(next.value);
          }
        } catch (error) {
          controller.error(error);
          finish();
        }
      },
      cancel: async (reason) => {
        try {
          await reader.cancel(reason);
        } finally {
          finish();
        }
      },
    }, { highWaterMark: 0 });
  }

  wrapAsyncIterable<T>(source: AsyncIterable<T>): AsyncIterable<T> {
    this.#assertActive();
    const session = this;
    let iteratorCreated = false;
    return Object.freeze({
      [Symbol.asyncIterator](): AsyncIterator<T> {
        if (iteratorCreated) throw new Error("Pipeline stream iterable can only be consumed once");
        iteratorCreated = true;
        const iterator = source[Symbol.asyncIterator]();
        let returned = false;
        const returnUpstream = async (value?: unknown): Promise<IteratorResult<T>> => {
          if (returned) return { done: true, value: value as T };
          returned = true;
          try {
            return iterator.return ? await iterator.return(value) : { done: true, value: value as T };
          } finally {
            session.finish();
          }
        };
        return Object.freeze({
          async next(): Promise<IteratorResult<T>> {
            if (returned) return { done: true, value: undefined as T };
            try {
              const result = await iterator.next();
              if (result.done) {
                returned = true;
                session.finish();
              }
              return result;
            } catch (error) {
              session.finish();
              throw error;
            }
          },
          return: returnUpstream,
          async throw(error?: unknown): Promise<IteratorResult<T>> {
            if (returned) throw error;
            returned = true;
            try {
              if (iterator.throw) return await iterator.throw(error);
              if (iterator.return) await iterator.return();
              throw error;
            } finally {
              session.finish();
            }
          },
        });
      },
    });
  }

  finish(): void {
    if (this.#finished) return;
    this.#finished = true;
    this.context.dispose();
  }

  #record(hook: CompiledPipelineHook, outcome: PipelineOutcome): void {
    this.#facts.push(Object.freeze({
      pluginId: hook.pluginId,
      behaviorVersion: hook.behaviorVersion,
      hook: hook.phase,
      instanceRevision: hook.instanceRevision,
      outcome,
    }));
  }

  #assertActive(): void {
    if (this.#finished) throw new Error("Pipeline request session has finished");
  }
}

export async function withPipelineRequest<TResult>(
  plan: ExecutionPlan,
  artifacts: PipelineArtifacts,
  callback: (session: PipelineRequestSession) => TResult | Promise<TResult>,
  options?: Readonly<{ signal?: AbortSignal; maxInvocationFacts?: number }>,
): Promise<TResult> {
  const session = new PipelineRequestSession(plan, artifacts, options);
  try {
    return await callback(session);
  } finally {
    session.finish();
  }
}
