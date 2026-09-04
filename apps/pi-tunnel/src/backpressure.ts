import WebSocket, { type RawData } from "ws";
import type { PiTunnelMetrics } from "./observability.js";

export interface OpaqueForwardQueueOptions {
  readonly highWaterBytes: number;
  readonly absoluteBytes: number;
  readonly maxQueuedFrames: number;
  readonly metrics: PiTunnelMetrics;
  readonly onOverflow: () => void;
  readonly drainIntervalMs?: number;
}

const FRAME_ACCOUNTING_BYTES = 64;

export class OpaqueForwardQueue {
  private readonly queue: Buffer[] = [];
  private queuedAccountedBytes = 0;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly target: WebSocket, private readonly options: OpaqueForwardQueueOptions) {}

  forward(data: RawData): boolean {
    if (this.target.readyState !== WebSocket.OPEN) return false;
    const frame = rawDataBuffer(data);
    const accountedFrameBytes = frame.byteLength + FRAME_ACCOUNTING_BYTES;
    const totalBuffered = this.target.bufferedAmount + this.queuedAccountedBytes + accountedFrameBytes;
    if (this.queue.length >= this.options.maxQueuedFrames || totalBuffered > this.options.absoluteBytes) {
      this.options.onOverflow();
      return false;
    }
    if (this.queue.length > 0 || this.target.bufferedAmount >= this.options.highWaterBytes) {
      this.queue.push(frame);
      this.queuedAccountedBytes += accountedFrameBytes;
      this.scheduleDrain();
      return true;
    }
    return this.send(frame);
  }

  clear(): void {
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.drainTimer = null;
    this.queue.length = 0;
    this.queuedAccountedBytes = 0;
  }

  private send(frame: Buffer): boolean {
    if (this.target.readyState !== WebSocket.OPEN) return false;
    try {
      this.target.send(frame, { binary: true }, (error) => {
        if (!error) this.options.metrics.addOpaqueBytes(frame.byteLength);
        this.scheduleDrain();
      });
      return true;
    } catch {
      return false;
    }
  }

  private scheduleDrain(): void {
    if (this.drainTimer || this.queue.length === 0) return;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      this.drain();
    }, this.options.drainIntervalMs ?? 5);
    this.drainTimer.unref?.();
  }

  private drain(): void {
    if (this.target.readyState !== WebSocket.OPEN) {
      this.clear();
      return;
    }
    while (
      this.queue.length > 0
      && this.target.bufferedAmount < this.options.highWaterBytes
    ) {
      const frame = this.queue.shift()!;
      this.queuedAccountedBytes -= frame.byteLength + FRAME_ACCOUNTING_BYTES;
      if (!this.send(frame)) break;
    }
    this.scheduleDrain();
  }
}

function rawDataBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.concat(data);
}
