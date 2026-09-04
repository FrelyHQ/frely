import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { freemem, totalmem } from "node:os";
import { RelayError } from "@frely/core";

const MIB = 1024 * 1024;
const MEMORY_SAMPLE_INTERVAL_MS = 5_000;
const REQUEST_BODY_TOO_LARGE_MESSAGE = "Gateway request body is too large";
const GATEWAY_CAPACITY_EXCEEDED_MESSAGE = "Gateway request capacity is temporarily exhausted";
const INVALID_CONTENT_LENGTH_MESSAGE = "Gateway request Content-Length is invalid";
const INCOMPLETE_REQUEST_BODY_MESSAGE = "Gateway request body is incomplete";
const REQUEST_ABORTED_MESSAGE = "Gateway request was aborted";

export const BODY_BYTES_PER_UNIT = MIB;
export const MEMORY_AMPLIFICATION = 9;
export const MEMORY_BYTES_PER_UNIT = BODY_BYTES_PER_UNIT * MEMORY_AMPLIFICATION;
export const MINIMUM_MEMORY_SAFETY_RESERVE_BYTES = 512 * MIB;

export type GatewayBodyRequestKind = "messages" | "responses" | "embeddings" | "chat.completions";
export type BodyAdmissionErrorCode =
  | "gateway_capacity_exceeded"
  | "request_aborted"
  | "incomplete_request_body"
  | "invalid_content_length"
  | "request_body_too_large";

export interface RequestBodyFraming {
  contentLengthPresent: boolean;
  contentLength?: number;
}

export interface CgroupMemoryEvents {
  high: number;
  max: number;
  oom: number;
  oomKill: number;
}

export interface CgroupMemorySample {
  currentBytes: number;
  inactiveFileBytes: number;
  activeFileBytes: number;
  workingSetBytes: number;
  workingsetRefaultFile: number;
}

export interface EffectiveMemorySample {
  effectiveLimitBytes: number;
  effectiveAvailableBytes: number;
  cgroupMemory?: CgroupMemorySample;
  cgroupEvents?: CgroupMemoryEvents;
}

export interface BodyMemorySampler {
  sample(): Promise<EffectiveMemorySample | undefined>;
}

export interface BodyCapacityRuntimeSnapshot {
  sampleValid: boolean;
  effectiveMemoryLimitBytes: number;
  effectiveMemoryAvailableBytes: number;
  safetyReserveBytes: number;
  bodyBytesPerUnit: number;
  memoryBytesPerUnit: number;
  totalUnits: number;
  usedUnits: number;
  cgroupMemory: {
    currentBytes: number;
    inactiveFileBytes: number;
    activeFileBytes: number;
    workingSetBytes: number;
    workingsetRefaultFileDelta: number;
  } | null;
  contentLength: { present: number; absent: number };
  outcomes: {
    capacityExceeded: number;
    requestAborted: number;
    incompleteRequestBody: number;
    invalidContentLength: number;
    requestBodyTooLarge: number;
  };
  cgroupMemoryEventsDelta: CgroupMemoryEvents;
}

export function gatewayBodyRequestKind(pathname: string): GatewayBodyRequestKind | undefined {
  if (pathname === "/v1/messages") return "messages";
  if (pathname === "/v1/responses") return "responses";
  if (pathname === "/v1/embeddings") return "embeddings";
  if (pathname === "/v1/chat/completions") return "chat.completions";
  return undefined;
}

export function inspectRequestBodyFraming(rawHeaders: readonly string[]): RequestBodyFraming {
  const contentLengths: string[] = [];
  let transferEncodingPresent = false;
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]?.toLowerCase();
    if (name === "content-length") contentLengths.push(rawHeaders[index + 1] ?? "");
    if (name === "transfer-encoding") transferEncodingPresent = true;
  }

  if (contentLengths.length === 0) return { contentLengthPresent: false };
  if (contentLengths.length !== 1 || transferEncodingPresent) throw invalidContentLength();
  return { contentLengthPresent: true, contentLength: parseCanonicalContentLength(contentLengths[0]!) };
}

export function requestBodyFramingFromHeaders(headers: Headers): RequestBodyFraming {
  const contentLength = headers.get("content-length");
  if (contentLength === null) return { contentLengthPresent: false };
  if (headers.has("transfer-encoding")) throw invalidContentLength();
  return { contentLengthPresent: true, contentLength: parseCanonicalContentLength(contentLength) };
}

export function admissionBodyBytes(framing: RequestBodyFraming, maxRequestBodyBytes: number): number {
  assertPositiveSafeInteger(maxRequestBodyBytes, "maxRequestBodyBytes");
  const declaredBytes = framing.contentLength;
  if (declaredBytes !== undefined && declaredBytes > maxRequestBodyBytes) throw requestBodyTooLarge();
  return declaredBytes ?? maxRequestBodyBytes;
}

export function requiredBodyUnits(bodyBytes: number): number {
  if (!Number.isSafeInteger(bodyBytes) || bodyBytes < 0) throw new TypeError("bodyBytes must be a non-negative safe integer");
  return Math.max(1, Math.ceil(bodyBytes / BODY_BYTES_PER_UNIT));
}

export class BodyRequestLease {
  private released = false;

  constructor(
    readonly units: number,
    private readonly releaseCapacity: (units: number) => void
  ) {}

  release(): void {
    if (this.released) return;
    this.released = true;
    this.releaseCapacity(this.units);
  }
}

export class WeightedBodyRequestCapacity {
  private totalUnitsValue = 0;
  private usedUnitsValue = 0;
  private memorySample: EffectiveMemorySample | undefined;
  private previousCgroupRefault: number | undefined;
  private cgroupRefaultDelta = 0;
  private previousCgroupEvents: CgroupMemoryEvents | undefined;
  private readonly cgroupEventsDelta = emptyCgroupEvents();
  private readonly contentLengthCounts = { present: 0, absent: 0 };
  private readonly outcomeCounts = {
    capacityExceeded: 0,
    requestAborted: 0,
    incompleteRequestBody: 0,
    invalidContentLength: 0,
    requestBodyTooLarge: 0
  };

  get totalUnits(): number {
    return this.totalUnitsValue;
  }

  get usedUnits(): number {
    return this.usedUnitsValue;
  }

  updateMemory(sample: EffectiveMemorySample): void {
    assertMemorySample(sample);
    const safetyReserveBytes = memorySafetyReserveBytes(sample.effectiveLimitBytes);
    const usableMemoryBytes = Math.max(0, sample.effectiveAvailableBytes - safetyReserveBytes);
    this.totalUnitsValue = Math.floor(usableMemoryBytes / MEMORY_BYTES_PER_UNIT);
    this.memorySample = sample;
    this.updateCgroupRefault(sample.cgroupMemory);
    this.updateCgroupEvents(sample.cgroupEvents);
  }

  tryAcquire(bodyBytes: number): BodyRequestLease | undefined {
    const units = requiredBodyUnits(bodyBytes);
    if (units > this.totalUnitsValue - this.usedUnitsValue) {
      this.outcomeCounts.capacityExceeded += 1;
      return undefined;
    }
    this.usedUnitsValue += units;
    return new BodyRequestLease(units, (releasedUnits) => {
      this.usedUnitsValue -= releasedUnits;
    });
  }

  recordContentLength(present: boolean): void {
    this.contentLengthCounts[present ? "present" : "absent"] += 1;
  }

  recordOutcome(code: BodyAdmissionErrorCode): void {
    if (code === "gateway_capacity_exceeded") return;
    if (code === "request_aborted") this.outcomeCounts.requestAborted += 1;
    if (code === "incomplete_request_body") this.outcomeCounts.incompleteRequestBody += 1;
    if (code === "invalid_content_length") this.outcomeCounts.invalidContentLength += 1;
    if (code === "request_body_too_large") this.outcomeCounts.requestBodyTooLarge += 1;
  }

  takeRuntimeSnapshot(): BodyCapacityRuntimeSnapshot {
    const sample = this.memorySample;
    const result: BodyCapacityRuntimeSnapshot = {
      sampleValid: sample !== undefined,
      effectiveMemoryLimitBytes: sample?.effectiveLimitBytes ?? 0,
      effectiveMemoryAvailableBytes: sample?.effectiveAvailableBytes ?? 0,
      safetyReserveBytes: sample ? memorySafetyReserveBytes(sample.effectiveLimitBytes) : 0,
      bodyBytesPerUnit: BODY_BYTES_PER_UNIT,
      memoryBytesPerUnit: MEMORY_BYTES_PER_UNIT,
      totalUnits: this.totalUnitsValue,
      usedUnits: this.usedUnitsValue,
      cgroupMemory: sample?.cgroupMemory
        ? {
            currentBytes: sample.cgroupMemory.currentBytes,
            inactiveFileBytes: sample.cgroupMemory.inactiveFileBytes,
            activeFileBytes: sample.cgroupMemory.activeFileBytes,
            workingSetBytes: sample.cgroupMemory.workingSetBytes,
            workingsetRefaultFileDelta: this.cgroupRefaultDelta
          }
        : null,
      contentLength: { ...this.contentLengthCounts },
      outcomes: { ...this.outcomeCounts },
      cgroupMemoryEventsDelta: { ...this.cgroupEventsDelta }
    };
    this.contentLengthCounts.present = 0;
    this.contentLengthCounts.absent = 0;
    for (const key of Object.keys(this.outcomeCounts) as Array<keyof typeof this.outcomeCounts>) this.outcomeCounts[key] = 0;
    for (const key of Object.keys(this.cgroupEventsDelta) as Array<keyof CgroupMemoryEvents>) this.cgroupEventsDelta[key] = 0;
    this.cgroupRefaultDelta = 0;
    return result;
  }

  private updateCgroupRefault(memory: CgroupMemorySample | undefined): void {
    if (!memory) {
      this.previousCgroupRefault = undefined;
      this.cgroupRefaultDelta = 0;
      return;
    }
    if (this.previousCgroupRefault !== undefined) {
      this.cgroupRefaultDelta += Math.max(0, memory.workingsetRefaultFile - this.previousCgroupRefault);
    }
    this.previousCgroupRefault = memory.workingsetRefaultFile;
  }

  private updateCgroupEvents(events: CgroupMemoryEvents | undefined): void {
    if (!events) return;
    if (this.previousCgroupEvents) {
      for (const key of Object.keys(events) as Array<keyof CgroupMemoryEvents>) {
        this.cgroupEventsDelta[key] += Math.max(0, events[key] - this.previousCgroupEvents[key]);
      }
    }
    this.previousCgroupEvents = { ...events };
  }
}

export function acquireBodyRequestLease(capacity: WeightedBodyRequestCapacity, bodyBytes: number): BodyRequestLease {
  const lease = capacity.tryAcquire(bodyBytes);
  if (!lease) throw new RelayError("gateway_capacity_exceeded", GATEWAY_CAPACITY_EXCEEDED_MESSAGE, 503);
  return lease;
}

export class BodyMemoryController {
  private timer: NodeJS.Timeout | undefined;
  private refreshPromise: Promise<boolean> | undefined;

  constructor(
    private readonly capacity: WeightedBodyRequestCapacity,
    private readonly sampler: BodyMemorySampler = new SystemBodyMemorySampler()
  ) {}

  refresh(): Promise<boolean> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.refreshOnce().finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.refresh(), MEMORY_SAMPLE_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async refreshOnce(): Promise<boolean> {
    try {
      const sample = await this.sampler.sample();
      if (!sample) return false;
      this.capacity.updateMemory(sample);
      return true;
    } catch {
      return false;
    }
  }
}

interface SystemBodyMemorySamplerOptions {
  platform?: NodeJS.Platform;
  readText?: (path: string) => Promise<string>;
  hostTotalMemory?: () => number;
  hostFreeMemory?: () => number;
}

export class SystemBodyMemorySampler implements BodyMemorySampler {
  private readonly platform: NodeJS.Platform;
  private readonly readText: (path: string) => Promise<string>;
  private readonly hostTotalMemory: () => number;
  private readonly hostFreeMemory: () => number;

  constructor(options: SystemBodyMemorySamplerOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.readText = options.readText ?? ((path) => readFile(path, "utf8"));
    this.hostTotalMemory = options.hostTotalMemory ?? totalmem;
    this.hostFreeMemory = options.hostFreeMemory ?? freemem;
  }

  async sample(): Promise<EffectiveMemorySample | undefined> {
    const hostTotalBytes = validMemoryBytes(this.hostTotalMemory());
    if (hostTotalBytes === undefined) return undefined;
    const hostAvailableBytes = await this.readHostAvailableMemory();
    if (hostAvailableBytes === undefined) return undefined;

    if (this.platform !== "linux") {
      return { effectiveLimitBytes: hostTotalBytes, effectiveAvailableBytes: Math.min(hostTotalBytes, hostAvailableBytes) };
    }

    const v2 = await this.readCgroupV2(hostTotalBytes);
    if (v2) {
      const sample: EffectiveMemorySample = {
        effectiveLimitBytes: Math.min(hostTotalBytes, v2.limitBytes),
        effectiveAvailableBytes: Math.min(hostAvailableBytes, v2.availableBytes),
        ...(v2.memory ? { cgroupMemory: v2.memory } : {})
      };
      return v2.events ? { ...sample, cgroupEvents: v2.events } : sample;
    }

    const events = parseCgroupMemoryEvents(await this.tryRead("/sys/fs/cgroup/memory.events"));
    return {
      effectiveLimitBytes: hostTotalBytes,
      effectiveAvailableBytes: Math.min(hostTotalBytes, hostAvailableBytes),
      ...(events ? { cgroupEvents: events } : {})
    };
  }

  private async readHostAvailableMemory(): Promise<number | undefined> {
    if (this.platform === "linux") {
      const memInfo = await this.tryRead("/proc/meminfo");
      const available = memInfo ? parseMemAvailable(memInfo) : undefined;
      if (available !== undefined) return available;
    }
    return validMemoryBytes(this.hostFreeMemory());
  }

  private async readCgroupV2(hostTotalBytes: number): Promise<CgroupMemoryBoundary | undefined> {
    const [limitText, currentText, statText, eventsText] = await Promise.all([
      this.tryRead("/sys/fs/cgroup/memory.max"),
      this.tryRead("/sys/fs/cgroup/memory.current"),
      this.tryRead("/sys/fs/cgroup/memory.stat"),
      this.tryRead("/sys/fs/cgroup/memory.events")
    ]);
    if (!limitText || limitText.trim() === "max" || !currentText) return undefined;
    const limitBytes = parseMemoryInteger(limitText);
    const currentBytes = parseMemoryInteger(currentText);
    if (limitBytes === undefined || currentBytes === undefined || limitBytes > hostTotalBytes) return undefined;
    const memory = parseCgroupV2MemoryStat(statText, currentBytes);
    const result: CgroupMemoryBoundary = {
      limitBytes,
      availableBytes: Math.max(0, limitBytes - (memory?.workingSetBytes ?? currentBytes)),
      ...(memory ? { memory } : {})
    };
    const events = parseCgroupMemoryEvents(eventsText);
    return events ? { ...result, events } : result;
  }

  private async tryRead(path: string): Promise<string | undefined> {
    try {
      return await this.readText(path);
    } catch {
      return undefined;
    }
  }
}

interface CgroupMemoryBoundary {
  limitBytes: number;
  availableBytes: number;
  memory?: CgroupMemorySample;
  events?: CgroupMemoryEvents;
}

export async function readBoundedJsonBody(
  request: Request,
  maxBytes: number,
  framing: RequestBodyFraming = requestBodyFramingFromHeaders(request.headers)
): Promise<Record<string, unknown>> {
  assertPositiveSafeInteger(maxBytes, "maxRequestBodyBytes");
  if (framing.contentLength !== undefined && framing.contentLength > maxBytes) {
    await cancelRequestBody(request.body);
    throw requestBodyTooLarge();
  }

  const declaredBytes = framing.contentLength;
  if (!request.body) {
    if (declaredBytes !== undefined && declaredBytes > 0) throw incompleteRequestBody();
    return {};
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = result.value;
      if (declaredBytes !== undefined && chunk.byteLength > declaredBytes - totalBytes) {
        await cancelReader(reader);
        throw invalidContentLength();
      }
      if (chunk.byteLength > maxBytes - totalBytes) {
        await cancelReader(reader);
        throw requestBodyTooLarge();
      }
      chunks.push(chunk);
      totalBytes += chunk.byteLength;
    }
  } catch (error) {
    if (error instanceof RelayError) throw error;
    if (request.signal.aborted) throw requestAborted();
    throw error;
  } finally {
    reader.releaseLock();
  }

  if (declaredBytes !== undefined && totalBytes < declaredBytes) {
    if (request.signal.aborted) throw requestAborted();
    throw incompleteRequestBody();
  }

  try {
    return JSON.parse(Buffer.concat(chunks, totalBytes).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function rawHeadersContain(rawHeaders: readonly string[], headerName: string): boolean {
  const normalized = headerName.toLowerCase();
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === normalized) return true;
  }
  return false;
}

function parseCanonicalContentLength(value: string): number {
  const normalized = value.trim();
  if (!/^(0|[1-9]\d*)$/.test(normalized)) throw invalidContentLength();
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) throw invalidContentLength();
  return parsed;
}

function memorySafetyReserveBytes(effectiveLimitBytes: number): number {
  return Math.max(MINIMUM_MEMORY_SAFETY_RESERVE_BYTES, Math.floor(effectiveLimitBytes * 0.2));
}

function assertMemorySample(sample: EffectiveMemorySample): void {
  assertPositiveSafeInteger(sample.effectiveLimitBytes, "effectiveLimitBytes");
  if (!Number.isSafeInteger(sample.effectiveAvailableBytes) || sample.effectiveAvailableBytes < 0) {
    throw new TypeError("effectiveAvailableBytes must be a non-negative safe integer");
  }
  if (sample.cgroupMemory) {
    const memory = sample.cgroupMemory;
    for (const [name, value] of Object.entries(memory)) {
      if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
    }
    if (memory.inactiveFileBytes > memory.currentBytes || memory.workingSetBytes !== memory.currentBytes - memory.inactiveFileBytes) {
      throw new TypeError("cgroupMemory working set is inconsistent");
    }
  }
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`);
}

function validMemoryBytes(value: number): number | undefined {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function parseMemoryInteger(value: string): number | undefined {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) return undefined;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseMemAvailable(memInfo: string): number | undefined {
  const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(memInfo);
  if (!match) return undefined;
  const kibibytes = Number(match[1]);
  const bytes = kibibytes * 1024;
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : undefined;
}

function parseCgroupV2MemoryStat(value: string | undefined, currentBytes: number): CgroupMemorySample | undefined {
  const stat = parseCgroupMemoryStat(value);
  if (!stat) return undefined;
  const inactiveFileBytes = stat.get("inactive_file");
  const activeFileBytes = stat.get("active_file");
  const workingsetRefaultFile = stat.get("workingset_refault_file");
  if (inactiveFileBytes === undefined || activeFileBytes === undefined || workingsetRefaultFile === undefined) return undefined;
  return cgroupMemorySample(currentBytes, inactiveFileBytes, activeFileBytes, workingsetRefaultFile);
}

function cgroupMemorySample(
  currentBytes: number,
  inactiveFileBytes: number,
  activeFileBytes: number,
  workingsetRefaultFile: number
): CgroupMemorySample {
  const clampedInactiveFileBytes = Math.min(currentBytes, inactiveFileBytes);
  return {
    currentBytes,
    inactiveFileBytes: clampedInactiveFileBytes,
    activeFileBytes,
    workingSetBytes: currentBytes - clampedInactiveFileBytes,
    workingsetRefaultFile
  };
}

function parseCgroupMemoryStat(value: string | undefined): Map<string, number | undefined> | undefined {
  if (!value) return undefined;
  const parsed = new Map<string, number | undefined>();
  for (const line of value.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 2 || !fields[0] || !fields[1]) continue;
    const number = parseMemoryInteger(fields[1]);
    parsed.set(fields[0], parsed.has(fields[0]) ? undefined : number);
  }
  return parsed;
}

function parseCgroupMemoryEvents(value: string | undefined): CgroupMemoryEvents | undefined {
  if (!value) return undefined;
  const parsed = new Map<string, number>();
  for (const line of value.split("\n")) {
    const match = /^(high|max|oom|oom_kill)\s+(\d+)$/.exec(line.trim());
    if (!match) continue;
    const count = Number(match[2]);
    if (Number.isSafeInteger(count) && count >= 0) parsed.set(match[1]!, count);
  }
  if (parsed.size === 0) return undefined;
  return {
    high: parsed.get("high") ?? 0,
    max: parsed.get("max") ?? 0,
    oom: parsed.get("oom") ?? 0,
    oomKill: parsed.get("oom_kill") ?? 0
  };
}

function emptyCgroupEvents(): CgroupMemoryEvents {
  return { high: 0, max: 0, oom: 0, oomKill: 0 };
}

export async function cancelRequestBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!body) return;
  try {
    await body.cancel();
  } catch {
    // The stable Gateway response must not be replaced by a transport cancellation error.
  }
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // The stable Gateway response must not be replaced by a transport cancellation error.
  }
}

function requestBodyTooLarge(): RelayError {
  return new RelayError("request_body_too_large", REQUEST_BODY_TOO_LARGE_MESSAGE, 413);
}

function invalidContentLength(): RelayError {
  return new RelayError("invalid_content_length", INVALID_CONTENT_LENGTH_MESSAGE, 400);
}

function incompleteRequestBody(): RelayError {
  return new RelayError("incomplete_request_body", INCOMPLETE_REQUEST_BODY_MESSAGE, 400);
}

function requestAborted(): RelayError {
  return new RelayError("request_aborted", REQUEST_ABORTED_MESSAGE, 499);
}
