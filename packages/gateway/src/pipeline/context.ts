import {
  PIPELINE_ARTIFACT_NAMES,
  type PipelineArtifactName,
  type PipelineArtifactReader,
  type PipelineArtifacts,
  type PipelineContextData,
  type PipelineContextKey,
} from "./contracts.js";

const SENSITIVE_KEY_SEGMENT = /(?:^|[-_:])(authorization|credential|oauth|password|secret|api-key)(?:$|[-_:])/i;
const ARTIFACT_NAMES = new Set<PipelineArtifactName>(PIPELINE_ARTIFACT_NAMES);
const REPLACEABLE_TRANSFORM_ARTIFACTS = new Set<PipelineArtifactName>([
  "effectiveSourceRequest",
  "canonicalRequest",
  "canonicalResponse",
  "clientResponse",
]);

export function assertSafeContextKey(key: PipelineContextKey<unknown>): void {
  if (SENSITIVE_KEY_SEGMENT.test(key.id)) {
    throw new Error(`Pipeline context key may not name sensitive material: ${key.id}`);
  }
}

function freezePublishedValue<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) Object.freeze(value);
  return value;
}

export class PipelineRequestContext {
  readonly #values = new Map<string, unknown>();
  readonly #artifacts = new Map<PipelineArtifactName, unknown>();
  #disposed = false;

  constructor(initialArtifacts: PipelineArtifacts) {
    for (const [key, value] of Object.entries(initialArtifacts) as [PipelineArtifactName, unknown][]) {
      if (!ARTIFACT_NAMES.has(key)) throw new Error(`Unknown initial pipeline artifact: ${key}`);
      if (value !== undefined) this.#artifacts.set(key, freezePublishedValue(value));
    }
    if (!this.#artifacts.has("originalRequest")) throw new Error("Pipeline originalRequest artifact is required");
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  get size(): number {
    return this.#values.size;
  }

  artifactReader(): PipelineArtifactReader {
    return Object.freeze({
      get: <TKey extends PipelineArtifactName>(key: TKey): PipelineArtifacts[TKey] | undefined => {
        this.#assertActive();
        return this.#artifacts.get(key) as PipelineArtifacts[TKey] | undefined;
      },
      has: (key: PipelineArtifactName): boolean => {
        this.#assertActive();
        return this.#artifacts.has(key);
      },
    });
  }

  createArtifactReader(pluginId: string, readableArtifactNames: ReadonlySet<PipelineArtifactName>): PipelineArtifactReader {
    return Object.freeze({
      get: <TKey extends PipelineArtifactName>(key: TKey): PipelineArtifacts[TKey] | undefined => {
        this.#assertActive();
        if (!readableArtifactNames.has(key)) throw new Error(`Plugin ${pluginId} cannot read pipeline artifact ${key}`);
        return this.#artifacts.get(key) as PipelineArtifacts[TKey] | undefined;
      },
      has: (key: PipelineArtifactName): boolean => {
        this.#assertActive();
        if (!readableArtifactNames.has(key)) throw new Error(`Plugin ${pluginId} cannot read pipeline artifact ${key}`);
        return this.#artifacts.has(key);
      },
    });
  }

  publishHookArtifacts(
    pluginId: string,
    patch: Readonly<Partial<PipelineArtifacts>>,
    writableArtifactNames: ReadonlySet<PipelineArtifactName>,
  ): void {
    this.#assertActive();
    const entries = Object.entries(patch) as [PipelineArtifactName, unknown][];
    for (const [key, value] of entries) {
      if (!ARTIFACT_NAMES.has(key)) throw new Error(`Unknown pipeline artifact: ${key}`);
      if (!writableArtifactNames.has(key)) throw new Error(`Plugin ${pluginId} cannot write pipeline artifact ${key}`);
      if (value === undefined) continue;
      if (key === "originalRequest" || (this.#artifacts.has(key) && !REPLACEABLE_TRANSFORM_ARTIFACTS.has(key))) {
        throw new Error(`Pipeline artifact is write-once: ${key}`);
      }
    }
    for (const [key, value] of entries) {
      if (value === undefined) continue;
      this.#artifacts.set(key, freezePublishedValue(value));
    }
  }

  publishTrustedArtifacts(patch: Readonly<Partial<PipelineArtifacts>>): void {
    this.#assertActive();
    const entries = Object.entries(patch) as [PipelineArtifactName, unknown][];
    for (const [key, value] of entries) {
      if (!ARTIFACT_NAMES.has(key)) throw new Error(`Unknown pipeline artifact: ${key}`);
      if (value === undefined) continue;
      if (key === "originalRequest" || this.#artifacts.has(key)) {
        throw new Error(`Trusted pipeline artifact is write-once: ${key}`);
      }
    }
    for (const [key, value] of entries) {
      if (value === undefined) continue;
      this.#artifacts.set(key, freezePublishedValue(value));
    }
  }

  createView(
    pluginId: string,
    readableKeyIds: ReadonlySet<string>,
    writableKeyIds: ReadonlySet<string>,
    registeredKeys: ReadonlyMap<string, PipelineContextKey<unknown>>,
  ): Readonly<{ data: PipelineContextData; revoke(): void }> {
    let revoked = false;
    const assertUsable = (): void => {
      this.#assertActive();
      if (revoked) throw new Error(`Pipeline context view for ${pluginId} has been revoked`);
    };
    const assertRegisteredKey = <T>(key: PipelineContextKey<T>): void => {
      if (registeredKeys.get(key.id) !== key) throw new Error(`Unregistered pipeline context key object: ${key.id}`);
    };
    const get = <T>(key: PipelineContextKey<T>): Readonly<T> | undefined => {
      assertUsable();
      assertRegisteredKey(key);
      if (!readableKeyIds.has(key.id)) throw new Error(`Plugin ${pluginId} cannot read context key ${key.id}`);
      return this.#values.get(key.id) as Readonly<T> | undefined;
    };
    const data: PipelineContextData = Object.freeze({
      get,
      has: <T>(key: PipelineContextKey<T>): boolean => get(key) !== undefined,
      set: <T>(key: PipelineContextKey<T>, value: T): void => {
        assertUsable();
        assertRegisteredKey(key);
        if (key.ownerPluginId !== pluginId || !writableKeyIds.has(key.id)) {
          throw new Error(`Plugin ${pluginId} cannot write context key ${key.id}`);
        }
        if (key.mode === "artifact" && this.#values.has(key.id)) {
          throw new Error(`Pipeline context artifact is write-once: ${key.id}`);
        }
        this.#values.set(key.id, freezePublishedValue(value));
      },
    });
    return Object.freeze({ data, revoke: () => { revoked = true; } });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#values.clear();
    this.#artifacts.clear();
    this.#disposed = true;
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("Pipeline request context has been disposed");
  }
}
