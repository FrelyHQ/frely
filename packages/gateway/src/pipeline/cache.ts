import { compileExecutionPlan, type ExecutionPlanCompilerInput } from "./compiler.js";
import type { ExecutionPlan } from "./contracts.js";

export class ExecutionPlanCache {
  readonly #plans = new Map<string, ExecutionPlan>();
  readonly #maxEntries: number;

  constructor(maxEntries = 128) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 10_000) {
      throw new Error("Execution plan cache size must be between 1 and 10000");
    }
    this.#maxEntries = maxEntries;
  }

  get size(): number {
    return this.#plans.size;
  }

  getOrCompile(input: ExecutionPlanCompilerInput): ExecutionPlan {
    const registryFingerprint = input.plugins
      .map((plugin) => `${plugin.manifest.id}:${plugin.manifest.apiVersion}:${plugin.manifest.behaviorVersion}:${plugin.manifest.configVersion}`)
      .sort()
      .join("|");
    const key = `${input.kernelApiVersion}\0${registryFingerprint}\0${input.settings.revision}\0${input.applicability.cacheKey}`;
    const cached = this.#plans.get(key);
    if (cached) {
      this.#plans.delete(key);
      this.#plans.set(key, cached);
      return cached;
    }
    // Compilation is intentionally completed before cache mutation. An invalid
    // new revision therefore fails closed and cannot silently reuse an old plan.
    const compiled = compileExecutionPlan(input);
    this.#plans.set(key, compiled);
    while (this.#plans.size > this.#maxEntries) {
      const oldest = this.#plans.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#plans.delete(oldest);
    }
    return compiled;
  }

  invalidate(): void {
    this.#plans.clear();
  }
}
