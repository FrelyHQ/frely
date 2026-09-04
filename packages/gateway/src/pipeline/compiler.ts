import { createHash } from "node:crypto";
import {
  PIPELINE_PHASES,
  PIPELINE_ARTIFACT_NAMES,
  PIPELINE_REQUEST_PHASES,
  PIPELINE_RESPONSE_PHASES,
  type CapabilityToken,
  type CompiledPipelineHook,
  type ExecutionPlan,
  type PipelineApplicabilitySnapshot,
  type PipelineArtifactName,
  type PipelineContextKey,
  type PipelineHook,
  type PipelinePhase,
  type PipelinePlugin,
  type PipelinePluginSetting,
  type PipelineSettingsSnapshot,
  type PluginPermission,
} from "./contracts.js";
import { assertSafeContextKey } from "./context.js";

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TOKEN_PATTERN = /^[a-z][a-z0-9.-]*:[a-z0-9][a-z0-9._-]*$/;
const REVISION_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const ALLOWED_SETTING_KEYS = new Set(["pluginId", "enabled", "config", "instanceRevision"]);
const PHASE_INDEX = new Map<PipelinePhase, number>(PIPELINE_PHASES.map((phase, index) => [phase, index]));
const ARTIFACT_NAMES = new Set<string>(PIPELINE_ARTIFACT_NAMES);

type CompilerInput = Readonly<{
  kernelApiVersion: number;
  plugins: readonly PipelinePlugin<unknown>[];
  settings: PipelineSettingsSnapshot;
  applicability: PipelineApplicabilitySnapshot;
  availableCapabilities?: readonly CapabilityToken[];
  singletonCapabilities?: readonly CapabilityToken[];
  availablePorts?: ReadonlyMap<PluginPermission, unknown>;
}>;

type HookNode = {
  ref: string;
  plugin: PipelinePlugin<unknown>;
  hook: PipelineHook<unknown>;
  setting: PipelinePluginSetting | undefined;
  config: unknown;
  edges: Set<string>;
};

export type PipelineRegistry = Readonly<{
  plugins: readonly PipelinePlugin<unknown>[];
  get(id: string): PipelinePlugin<unknown> | undefined;
}>;

function assertIntegerVersion(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
}

function assertTokenList(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (!TOKEN_PATTERN.test(value)) throw new Error(`Invalid ${label}: ${value}`);
    if (seen.has(value)) throw new Error(`Duplicate ${label}: ${value}`);
    seen.add(value);
  }
}

function assertArtifactList(values: unknown, label: string, allowOriginalRequest: boolean): asserts values is readonly PipelineArtifactName[] {
  if (!Array.isArray(values)) throw new Error(`${label} must be an explicit artifact allowlist`);
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || !ARTIFACT_NAMES.has(value)) throw new Error(`Invalid ${label}: ${String(value)}`);
    if (!allowOriginalRequest && value === "originalRequest") throw new Error(`${label} cannot include originalRequest`);
    if (seen.has(value)) throw new Error(`Duplicate ${label}: ${value}`);
    seen.add(value);
  }
}

function deepFreezeJson(value: unknown, path = "config", seen = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} must contain finite JSON numbers`);
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error(`${path} must not contain cycles`);
    seen.add(value);
    for (let index = 0; index < value.length; index += 1) deepFreezeJson(value[index], `${path}[${index}]`, seen);
    return Object.freeze(value);
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) throw new Error(`${path} must be plain JSON data`);
    if (seen.has(object)) throw new Error(`${path} must not contain cycles`);
    seen.add(object);
    for (const [key, entry] of Object.entries(object)) deepFreezeJson(entry, `${path}.${key}`, seen);
    return Object.freeze(object);
  }
  throw new Error(`${path} must contain JSON data only`);
}

function validatePlugin(plugin: PipelinePlugin<unknown>, kernelApiVersion: number): void {
  const manifest = plugin.manifest;
  if (!ID_PATTERN.test(manifest.id)) throw new Error(`Invalid pipeline plugin ID: ${manifest.id}`);
  if (manifest.desc.trim().length === 0) throw new Error(`Pipeline plugin ${manifest.id} must have a description`);
  assertIntegerVersion(manifest.apiVersion, `${manifest.id} apiVersion`);
  assertIntegerVersion(manifest.behaviorVersion, `${manifest.id} behaviorVersion`);
  assertIntegerVersion(manifest.configVersion, `${manifest.id} configVersion`);
  if (manifest.apiVersion !== kernelApiVersion) {
    throw new Error(`Pipeline plugin ${manifest.id} requires API ${manifest.apiVersion}, kernel is ${kernelApiVersion}`);
  }
  if (manifest.availability === "required" && manifest.userToggleable) {
    throw new Error(`Required pipeline plugin ${manifest.id} cannot be user-toggleable`);
  }
  if (!manifest.userConfigurable && plugin.configUi.length > 0) {
    throw new Error(`Non-configurable pipeline plugin ${manifest.id} cannot declare config UI`);
  }
  assertTokenList(manifest.permissions, `${manifest.id} permission`);
  assertTokenList(manifest.requires, `${manifest.id} required capability`);
  assertTokenList(manifest.provides, `${manifest.id} provided capability`);
  if (plugin.hooks.length === 0) throw new Error(`Pipeline plugin ${manifest.id} must declare at least one hook`);

  const contextKeyIds = new Set<string>();
  for (const key of plugin.contextKeys ?? []) {
    if (key.ownerPluginId !== manifest.id || !key.id.startsWith(`${manifest.id}:`) || !TOKEN_PATTERN.test(key.id)) {
      throw new Error(`Invalid context key ownership: ${key.id}`);
    }
    assertSafeContextKey(key);
    if (contextKeyIds.has(key.id)) throw new Error(`Duplicate context key in ${manifest.id}: ${key.id}`);
    contextKeyIds.add(key.id);
  }

  const hookIds = new Set<string>();
  for (const hook of plugin.hooks) {
    if (!ID_PATTERN.test(hook.id)) throw new Error(`Invalid hook ID: ${manifest.id}/${hook.id}`);
    if (hookIds.has(hook.id)) throw new Error(`Duplicate hook ID: ${manifest.id}/${hook.id}`);
    hookIds.add(hook.id);
    if (!PHASE_INDEX.has(hook.phase)) throw new Error(`Unknown pipeline phase: ${String(hook.phase)}`);
    if (hook.bestEffort && hook.kind !== "observe") throw new Error(`Only observe hooks may be best-effort: ${manifest.id}/${hook.id}`);
    if (hook.timeoutMs !== undefined && (!Number.isSafeInteger(hook.timeoutMs) || hook.timeoutMs < 1 || hook.timeoutMs > 120_000)) {
      throw new Error(`Invalid hook timeout: ${manifest.id}/${hook.id}`);
    }
    assertTokenList(hook.requires, `${manifest.id}/${hook.id} required capability`);
    assertTokenList(hook.provides, `${manifest.id}/${hook.id} provided capability`);
    assertArtifactList(hook.readsArtifacts, `${manifest.id}/${hook.id} artifact read`, true);
    assertArtifactList(hook.writesArtifacts, `${manifest.id}/${hook.id} artifact write`, false);
    for (const token of hook.requires) {
      if (!manifest.requires.includes(token)) throw new Error(`Hook requires undeclared manifest capability: ${token}`);
    }
    for (const token of hook.provides) {
      if (!manifest.provides.includes(token)) throw new Error(`Hook provides undeclared manifest capability: ${token}`);
    }
    for (const key of hook.providesContext ?? []) {
      if (!contextKeyIds.has(key.id) || key.ownerPluginId !== manifest.id) {
        throw new Error(`Hook provides undeclared context key: ${key.id}`);
      }
    }
  }
  deepFreezeJson(plugin.configSchema.parse(plugin.defaultConfig), `${manifest.id}.defaultConfig`);
}

export function createPipelineRegistry(
  plugins: readonly PipelinePlugin<unknown>[],
  kernelApiVersion: number,
): PipelineRegistry {
  const byId = new Map<string, PipelinePlugin<unknown>>();
  const contextKeyIds = new Set<string>();
  for (const plugin of plugins) {
    validatePlugin(plugin, kernelApiVersion);
    if (byId.has(plugin.manifest.id)) throw new Error(`Duplicate pipeline plugin ID: ${plugin.manifest.id}`);
    byId.set(plugin.manifest.id, plugin);
    for (const key of plugin.contextKeys ?? []) {
      if (contextKeyIds.has(key.id)) throw new Error(`Duplicate pipeline context key: ${key.id}`);
      contextKeyIds.add(key.id);
    }
  }
  return Object.freeze({
    plugins: Object.freeze([...byId.values()]),
    get: (id: string) => byId.get(id),
  });
}

function validateSetting(setting: PipelinePluginSetting): void {
  const object = setting as unknown as Record<string, unknown>;
  for (const key of Object.keys(object)) {
    if (!ALLOWED_SETTING_KEYS.has(key)) throw new Error(`Unknown pipeline setting field: ${key}`);
  }
  if (!ID_PATTERN.test(setting.pluginId)) throw new Error(`Invalid setting plugin ID: ${setting.pluginId}`);
  if (typeof setting.enabled !== "boolean") throw new Error(`Setting enabled must be boolean: ${setting.pluginId}`);
  if (!REVISION_PATTERN.test(setting.instanceRevision)) throw new Error(`Invalid instance revision: ${setting.pluginId}`);
}

function freezeSet<T>(values: Iterable<T>): ReadonlySet<T> {
  const set = new Set(values);
  return Object.freeze({
    get size() { return set.size; },
    has: (value: T) => set.has(value),
    forEach: set.forEach.bind(set),
    entries: set.entries.bind(set),
    keys: set.keys.bind(set),
    values: set.values.bind(set),
    [Symbol.iterator]: set[Symbol.iterator].bind(set),
  }) as ReadonlySet<T>;
}

function freezeMap<TKey, TValue>(values: Iterable<readonly [TKey, TValue]>): ReadonlyMap<TKey, TValue> {
  const map = new Map(values);
  return Object.freeze({
    get size() { return map.size; },
    get: (key: TKey) => map.get(key),
    has: (key: TKey) => map.has(key),
    forEach: map.forEach.bind(map),
    entries: map.entries.bind(map),
    keys: map.keys.bind(map),
    values: map.values.bind(map),
    [Symbol.iterator]: map[Symbol.iterator].bind(map),
  }) as ReadonlyMap<TKey, TValue>;
}

function resolveReference(reference: string, node: HookNode, nodes: ReadonlyMap<string, HookNode>): string {
  if (reference.includes("/")) {
    if (!nodes.has(reference)) throw new Error(`Missing hook order dependency ${reference} required by ${node.ref}`);
    return reference;
  }
  const matches = [...nodes.values()].filter((candidate) => candidate.plugin.manifest.id === reference && candidate.hook.phase === node.hook.phase);
  if (matches.length !== 1) throw new Error(`Hook order dependency ${reference} is missing or ambiguous for ${node.ref}`);
  return matches[0]!.ref;
}

function topologicalSort(phase: PipelinePhase, phaseNodes: readonly HookNode[]): readonly HookNode[] {
  const byRef = new Map(phaseNodes.map((node) => [node.ref, node]));
  const indegree = new Map(phaseNodes.map((node) => [node.ref, 0]));
  for (const node of phaseNodes) {
    for (const target of node.edges) {
      if (!byRef.has(target)) continue;
      indegree.set(target, (indegree.get(target) ?? 0) + 1);
    }
  }
  const ready = phaseNodes.filter((node) => indegree.get(node.ref) === 0).sort((left, right) => left.ref.localeCompare(right.ref));
  const result: HookNode[] = [];
  while (ready.length > 0) {
    const node = ready.shift()!;
    result.push(node);
    for (const target of [...node.edges].sort()) {
      if (!byRef.has(target)) continue;
      const next = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, next);
      if (next === 0) {
        ready.push(byRef.get(target)!);
        ready.sort((left, right) => left.ref.localeCompare(right.ref));
      }
    }
  }
  if (result.length !== phaseNodes.length) {
    const cyclic = phaseNodes.filter((node) => !result.includes(node)).map((node) => node.ref).sort();
    throw new Error(`Pipeline hook dependency cycle in ${phase}: ${cyclic.join(", ")}`);
  }
  return Object.freeze(result);
}

export function compileExecutionPlan(input: CompilerInput): ExecutionPlan {
  assertIntegerVersion(input.kernelApiVersion, "kernelApiVersion");
  if (!REVISION_PATTERN.test(input.settings.revision)) throw new Error("Invalid pipeline settings revision");
  if (!REVISION_PATTERN.test(input.applicability.cacheKey)) throw new Error("Invalid pipeline applicability cache key");

  const registry = createPipelineRegistry(input.plugins, input.kernelApiVersion);
  const pluginsById = new Map<string, PipelinePlugin<unknown>>();
  const contextKeys = new Map<string, PipelineContextKey<unknown>>();
  for (const plugin of registry.plugins) {
    pluginsById.set(plugin.manifest.id, plugin);
    for (const key of plugin.contextKeys ?? []) {
      contextKeys.set(key.id, key);
    }
  }

  const settingsById = new Map<string, PipelinePluginSetting>();
  for (const setting of input.settings.settings) {
    validateSetting(setting);
    if (!pluginsById.has(setting.pluginId)) throw new Error(`Unknown pipeline plugin setting: ${setting.pluginId}`);
    if (settingsById.has(setting.pluginId)) throw new Error(`Duplicate pipeline plugin setting: ${setting.pluginId}`);
    settingsById.set(setting.pluginId, setting);
  }

  const active: { plugin: PipelinePlugin<unknown>; setting: PipelinePluginSetting | undefined; config: unknown }[] = [];
  for (const plugin of pluginsById.values()) {
    const setting = settingsById.get(plugin.manifest.id);
    const alwaysEnabled = plugin.manifest.availability === "required" || !plugin.manifest.userToggleable;
    if (alwaysEnabled && setting?.enabled === false) throw new Error(`Pipeline plugin ${plugin.manifest.id} cannot be disabled`);
    const enabled = alwaysEnabled || setting?.enabled === true;
    if (!enabled) continue;
    if (plugin.isApplicable && !plugin.isApplicable(input.applicability.facts)) continue;
    if (!plugin.manifest.userConfigurable && setting?.config !== undefined) {
      throw new Error(`Pipeline plugin ${plugin.manifest.id} is not user-configurable`);
    }
    const parsed = plugin.configSchema.parse(setting?.config ?? plugin.defaultConfig);
    const config = deepFreezeJson(parsed, `${plugin.manifest.id}.config`);
    active.push({ plugin, setting, config });
  }

  const externallyAvailable = new Set(input.availableCapabilities ?? []);
  const singletonCapabilities = new Set(input.singletonCapabilities ?? []);
  const capabilityProviders = new Map<string, HookNode[]>();
  const nodes = new Map<string, HookNode>();
  for (const entry of active) {
    for (const hook of entry.plugin.hooks) {
      const ref = `${entry.plugin.manifest.id}/${hook.id}`;
      const node: HookNode = { ref, plugin: entry.plugin, hook, setting: entry.setting, config: entry.config, edges: new Set() };
      nodes.set(ref, node);
      for (const token of hook.provides) {
        const providers = capabilityProviders.get(token) ?? [];
        if (singletonCapabilities.has(token) && providers.length > 0) {
          throw new Error(`Duplicate singleton capability provider ${token}: ${providers[0]!.ref}, ${ref}`);
        }
        providers.push(node);
        capabilityProviders.set(token, providers);
      }
    }
  }

  for (const node of nodes.values()) {
    for (const token of node.hook.requires) {
      const producers = capabilityProviders.get(token) ?? [];
      if (producers.length === 0) {
        if (!externallyAvailable.has(token)) throw new Error(`Missing capability ${token} required by ${node.ref}`);
        continue;
      }
      for (const producer of producers) {
        const producerPhase = PHASE_INDEX.get(producer.hook.phase)!;
        const consumerPhase = PHASE_INDEX.get(node.hook.phase)!;
        if (producerPhase > consumerPhase) throw new Error(`Capability ${token} is produced after consumer ${node.ref}`);
        if (producerPhase === consumerPhase && producer.ref !== node.ref) producer.edges.add(node.ref);
      }
    }
    for (const reference of node.hook.before ?? []) {
      const target = resolveReference(reference, node, nodes);
      const targetNode = nodes.get(target)!;
      if (targetNode.hook.phase !== node.hook.phase) throw new Error(`before/after dependencies must stay within phase: ${node.ref}`);
      node.edges.add(target);
    }
    for (const reference of node.hook.after ?? []) {
      const target = resolveReference(reference, node, nodes);
      const targetNode = nodes.get(target)!;
      if (targetNode.hook.phase !== node.hook.phase) throw new Error(`before/after dependencies must stay within phase: ${node.ref}`);
      targetNode.edges.add(node.ref);
    }
  }

  const contextProducers = new Map<string, HookNode[]>();
  for (const node of nodes.values()) {
    for (const key of node.hook.providesContext ?? []) {
      const registered = contextKeys.get(key.id);
      if (registered !== key || registered.ownerPluginId !== node.plugin.manifest.id) throw new Error(`Unregistered provided context key: ${key.id}`);
      const producers = contextProducers.get(key.id) ?? [];
      if (registered.mode === "artifact" && producers.length > 0) throw new Error(`Duplicate context key producer: ${key.id}`);
      producers.push(node);
      contextProducers.set(key.id, producers);
    }
  }
  for (const node of nodes.values()) {
    for (const key of node.hook.requiresContext ?? []) {
      const registered = contextKeys.get(key.id);
      if (registered !== key) throw new Error(`Unknown required context key: ${key.id}`);
      if (registered.visibility === "private" && registered.ownerPluginId !== node.plugin.manifest.id) {
        throw new Error(`Plugin ${node.plugin.manifest.id} cannot require private context key ${key.id}`);
      }
      const producers = contextProducers.get(key.id) ?? [];
      const consumerPhase = PHASE_INDEX.get(node.hook.phase)!;
      const availableProducers = producers.filter((producer) =>
        producer.ref !== node.ref && PHASE_INDEX.get(producer.hook.phase)! <= consumerPhase,
      );
      if (availableProducers.length === 0) throw new Error(`Context ${key.id} is unavailable to ${node.ref}`);
      for (const producer of availableProducers) {
        if (producer.hook.phase === node.hook.phase) producer.edges.add(node.ref);
      }
    }
  }

  const hooksByPhase = {} as Record<PipelinePhase, readonly CompiledPipelineHook[]>;
  for (const phase of PIPELINE_PHASES) {
    const sorted = topologicalSort(phase, [...nodes.values()].filter((node) => node.hook.phase === phase));
    hooksByPhase[phase] = Object.freeze(sorted.map((node): CompiledPipelineHook => {
      const readable = new Set<string>();
      const required = new Set<string>();
      const writable = new Set<string>();
      for (const key of node.hook.requiresContext ?? []) {
        readable.add(key.id);
        required.add(key.id);
      }
      for (const key of node.hook.providesContext ?? []) {
        readable.add(key.id);
        writable.add(key.id);
      }
      for (const key of node.plugin.contextKeys ?? []) {
        if (key.ownerPluginId === node.plugin.manifest.id && key.visibility === "private") readable.add(key.id);
      }
      const ports: Record<string, unknown> = {};
      for (const permission of node.plugin.manifest.permissions) {
        if (!input.availablePorts?.has(permission)) throw new Error(`Missing permission port ${permission} for ${node.ref}`);
        ports[permission] = input.availablePorts.get(permission);
      }
      const timeout = node.hook.timeoutMs;
      const hookApplicability = node.hook.isApplicable;
      return Object.freeze({
        ref: node.ref,
        pluginId: node.plugin.manifest.id,
        behaviorVersion: node.plugin.manifest.behaviorVersion,
        phase,
        kind: node.hook.kind,
        bestEffort: node.hook.bestEffort === true,
        ...(timeout === undefined ? {} : { timeoutMs: timeout }),
        instanceRevision: node.setting?.instanceRevision ?? `builtin-${node.plugin.manifest.configVersion}`,
        config: node.config,
        ports: Object.freeze(ports),
        readableArtifactNames: freezeSet(node.hook.readsArtifacts),
        writableArtifactNames: freezeSet(node.hook.writesArtifacts),
        readableContextKeyIds: freezeSet(readable),
        requiredContextKeyIds: freezeSet(required),
        writableContextKeyIds: freezeSet(writable),
        ...(hookApplicability === undefined ? {} : { isApplicable: hookApplicability }),
        run: node.hook.run,
      });
    }));
  }

  const flatten = (phases: readonly PipelinePhase[]): readonly CompiledPipelineHook[] =>
    Object.freeze(phases.flatMap((phase) => hooksByPhase[phase]));
  const registryFingerprint = [...pluginsById.values()]
    .map((plugin) => `${plugin.manifest.id}:${plugin.manifest.apiVersion}:${plugin.manifest.behaviorVersion}:${plugin.manifest.configVersion}`)
    .sort()
    .join("|");
  const revisionInput = `${input.kernelApiVersion}\0${registryFingerprint}\0${input.settings.revision}\0${input.applicability.cacheKey}`;
  const planRevision = `ppr_${createHash("sha256").update(revisionInput).digest("hex").slice(0, 24)}`;
  return Object.freeze({
    kernelApiVersion: input.kernelApiVersion,
    planRevision,
    settingsRevision: input.settings.revision,
    applicabilityCacheKey: input.applicability.cacheKey,
    hooksByPhase: Object.freeze(hooksByPhase),
    requestHooks: flatten(PIPELINE_REQUEST_PHASES),
    responseHooks: flatten(PIPELINE_RESPONSE_PHASES),
    streamHooks: hooksByPhase["stream.transform"],
    contextKeys: freezeMap(contextKeys),
  });
}

export type { CompilerInput as ExecutionPlanCompilerInput };
