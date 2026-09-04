import {
  normalizeRelease,
  type BrowserMeasurement,
  type RouteRegistry,
  type UiSurfaceMeasurement,
  type UiSurfaceResult,
  type UiSurfaceType,
  type WebVitalName,
} from "./contracts.js";

const SESSION_KEY = "friday.ui-surface.page-candidate.v1";
const CANDIDATE_TTL_MS = 30_000;
const SURFACE_TIMEOUT_MS = 30_000;
const BUTTON_CANDIDATE_TTL_MS = 5_000;

interface Candidate {
  kind: "anchor" | "button" | "dialog";
  startedAtEpochMs: number;
  expiresAtEpochMs: number;
  traceparent: string;
}

interface ActiveSurface {
  id: number;
  name: string;
  pathname: string | null;
  startedAtEpochMs: number;
  timeout: ReturnType<typeof setTimeout>;
  type: UiSurfaceType;
  traceparent: string;
}

interface StoredCandidate {
  kind: "page";
  release: string;
  startedAtEpochMs: number;
  expiresAtEpochMs: number;
}

export interface SurfaceRuntimeOptions {
  endpoint?: string;
  release: string;
  routes: RouteRegistry;
  traceSampleRatio?: number;
}

let runtime: SurfaceRuntime | null = null;
let runtimeDispose: (() => void) | null = null;

export class SurfaceRuntime {
  private active: ActiveSurface | null = null;
  private candidate: Candidate | null = null;
  private id = 0;
  private pageExiting = false;
  private readonly endpoint: string;
  private readonly release: string;
  private readonly routes: RouteRegistry;
  private readonly traceSampleRatio: number;

  constructor(options: SurfaceRuntimeOptions) {
    this.endpoint = options.endpoint ?? "/api/telemetry/browser";
    this.release = normalizeRelease(options.release);
    this.routes = options.routes;
    this.traceSampleRatio = Number.isFinite(options.traceSampleRatio)
      ? Math.max(0, Math.min(1, options.traceSampleRatio ?? 0.05))
      : 0.05;
  }

  install(): () => void {
    const restoreFetch = this.installFetchPropagation();
    document.addEventListener("click", this.captureActivation, true);
    window.addEventListener("error", this.captureFailure);
    window.addEventListener("pagehide", this.capturePageExit);
    window.addEventListener("pageshow", this.capturePageRestore);
    window.addEventListener("unhandledrejection", this.captureFailure);
    return () => {
      document.removeEventListener("click", this.captureActivation, true);
      window.removeEventListener("error", this.captureFailure);
      window.removeEventListener("pagehide", this.capturePageExit);
      window.removeEventListener("pageshow", this.capturePageRestore);
      window.removeEventListener("unhandledrejection", this.captureFailure);
      restoreFetch();
      if (!this.pageExiting) this.finish("cancelled");
    };
  }

  restorePageCandidate(): void {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (!raw) return;
      sessionStorage.removeItem(SESSION_KEY);
      const value = JSON.parse(raw) as Partial<StoredCandidate>;
      if (
        value.kind !== "page"
        || value.release !== this.release
        || typeof value.startedAtEpochMs !== "number"
        || typeof value.expiresAtEpochMs !== "number"
        || value.expiresAtEpochMs < Date.now()
        || value.startedAtEpochMs > Date.now()
      ) return;
      this.candidate = {
        kind: "anchor",
        startedAtEpochMs: value.startedAtEpochMs,
        expiresAtEpochMs: value.expiresAtEpochMs,
        traceparent: createTraceparent(this.traceSampleRatio),
      };
    } catch {
      try {
        sessionStorage.removeItem(SESSION_KEY);
      } catch {
        // Observability storage is best-effort.
      }
    }
  }

  onPathname(pathname: string): void {
    const name = this.routes.match(pathname);
    if (!name) {
      this.finish("cancelled");
      this.clearCandidate();
      return;
    }
    if (this.active?.type === "page") {
      this.active.name = name;
      this.active.pathname = pathname;
      this.clearCandidate();
      this.waitForPageReady();
      return;
    }
    const candidate = this.takeCandidate("page");
    if (!candidate) return;
    this.start("page", name, candidate.startedAtEpochMs, candidate.traceparent, pathname);
    this.waitForPageReady();
  }

  openDialog(name: string): void {
    if (this.active?.type === "dialog" && this.active.name === name) return;
    const candidate = this.takeCandidate("dialog");
    if (!candidate) return;
    this.start("dialog", name, candidate.startedAtEpochMs, candidate.traceparent, null);
  }

  closeDialog(name: string): void {
    if (this.active?.type === "dialog" && this.active.name === name) this.finish("cancelled");
  }

  dialogReady(name: string): void {
    if (this.active?.type === "dialog" && this.active.name === name) this.finish("success");
  }

  failActiveSurface(): void {
    this.finish("failed");
  }

  reportWebVital(name: WebVitalName, value: number, pathname: string): void {
    const routeName = this.routes.match(pathname);
    if (!routeName) return;
    this.send({ kind: "web_vital", name, routeName, value }, null);
  }

  private readonly captureActivation = (event: MouseEvent): void => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const element = event.target instanceof Element ? event.target.closest("a[href],button,[role='button']") : null;
    if (!element || element.getAttribute("aria-disabled") === "true" || (element instanceof HTMLButtonElement && element.disabled)) return;
    const startedAtEpochMs = performance.timeOrigin + performance.now();
    if (element.closest("[data-ui-dialog-trigger='true']")) {
      this.setCandidate("dialog", startedAtEpochMs, BUTTON_CANDIDATE_TTL_MS);
      return;
    }
    if (element instanceof HTMLAnchorElement) {
      const target = element.getAttribute("target");
      if (element.hasAttribute("download") || (target !== null && target.toLowerCase() !== "_self")) return;
      let url: URL;
      try {
        url = new URL(element.href, window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return;
      const routeName = this.routes.match(url.pathname);
      if (!routeName) return;
      this.setCandidate("anchor", startedAtEpochMs, CANDIDATE_TTL_MS);
      this.persistPageCandidate(startedAtEpochMs);
      const candidate = this.candidate;
      if (candidate) {
        this.start("page", routeName, candidate.startedAtEpochMs, candidate.traceparent, url.pathname);
      }
      return;
    }
    this.setCandidate("button", startedAtEpochMs, BUTTON_CANDIDATE_TTL_MS);
  };

  private readonly captureFailure = (): void => {
    if (this.active) this.finish("failed");
  };

  private readonly capturePageExit = (): void => {
    this.pageExiting = true;
    if (this.candidate?.kind === "button" && this.candidate.expiresAtEpochMs >= Date.now()) {
      this.persistPageCandidate(this.candidate.startedAtEpochMs);
    }
  };

  private readonly capturePageRestore = (): void => {
    this.pageExiting = false;
  };

  private setCandidate(kind: Candidate["kind"], startedAtEpochMs: number, ttlMs: number): void {
    if (this.active) this.finish("cancelled");
    this.candidate = {
      kind,
      startedAtEpochMs,
      expiresAtEpochMs: startedAtEpochMs + ttlMs,
      traceparent: createTraceparent(this.traceSampleRatio),
    };
  }

  private takeCandidate(target: UiSurfaceType): Candidate | null {
    const candidate = this.candidate;
    this.clearCandidate();
    if (!candidate || candidate.expiresAtEpochMs < Date.now()) return null;
    if (target === "dialog" && candidate.kind === "anchor") return null;
    return candidate;
  }

  private clearCandidate(): void {
    this.candidate = null;
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch {
      // Observability storage is best-effort.
    }
  }

  private persistPageCandidate(startedAtEpochMs: number): void {
    try {
      const stored: StoredCandidate = {
        kind: "page",
        release: this.release,
        startedAtEpochMs,
        expiresAtEpochMs: startedAtEpochMs + CANDIDATE_TTL_MS,
      };
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(stored));
    } catch {
      // Observability storage is best-effort.
    }
  }

  private start(
    type: UiSurfaceType,
    name: string,
    startedAtEpochMs: number,
    traceparent: string,
    pathname: string | null,
  ): void {
    if (this.active) this.finish("cancelled");
    const id = ++this.id;
    this.active = {
      id,
      name,
      pathname,
      startedAtEpochMs,
      traceparent,
      type,
      timeout: setTimeout(() => {
        if (this.active?.id === id) this.finish("timeout");
      }, SURFACE_TIMEOUT_MS),
    };
  }

  private finish(result: UiSurfaceResult): void {
    const active = this.active;
    if (!active) return;
    this.active = null;
    clearTimeout(active.timeout);
    if (active.type === "page") this.clearCandidate();
    this.send({
      kind: "ui_surface",
      durationMs: Math.max(0, Math.min(120_000, Date.now() - active.startedAtEpochMs)),
      result,
      surfaceName: active.name,
      surfaceType: active.type,
    }, active.traceparent);
  }

  private waitForPageReady(): void {
    let stopped = false;
    let frame = 0;
    const check = () => {
      if (stopped || this.active?.type !== "page") return;
      const ready = [...document.querySelectorAll<HTMLElement>("[data-ui-page-surface-ready='true']")]
        .find((element) => element.dataset.uiPageSurfacePathname === this.active?.pathname);
      if (ready && isReadyElement(ready)) {
        frame = requestAnimationFrame(() => {
          frame = requestAnimationFrame(() => this.finish("success"));
        });
      }
    };
    const observer = new MutationObserver(check);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["aria-busy", "data-ui-page-surface-ready", "data-ui-surface-pending", "disabled"],
      childList: true,
      subtree: true,
    });
    const activeId = this.active?.id;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
    const poll = window.setInterval(() => {
      if (this.active?.id !== activeId) {
        window.clearInterval(poll);
        stop();
      }
    }, 100);
    check();
  }

  private send(measurement: BrowserMeasurement, traceparent: string | null): void {
    try {
      const body = JSON.stringify(measurement);
      if (body.length > 2_048) return;
      if (!traceparent && navigator.sendBeacon) {
        const sent = navigator.sendBeacon(this.endpoint, new Blob([body], { type: "application/json" }));
        if (sent) return;
      }
      void fetch(this.endpoint, {
        method: "POST",
        body,
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          ...(traceparent ? { traceparent } : {}),
        },
        keepalive: true,
      }).catch(() => undefined);
    } catch {
      // Telemetry failure must never affect the UI operation.
    }
  }

  private installFetchPropagation(): () => void {
    const original = window.fetch.bind(window);
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const traceparent = this.active?.traceparent ?? this.candidate?.traceparent;
      if (!traceparent) return original(input, init);
      try {
        const inputUrl = input instanceof Request ? input.url : String(input);
        const url = new URL(inputUrl, window.location.href);
        if (url.origin !== window.location.origin) return original(input, init);
        const headers = new Headers(input instanceof Request ? input.headers : undefined);
        new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
        if (!headers.has("traceparent")) headers.set("traceparent", traceparent);
        if (input instanceof Request) {
          return original(new Request(input, { ...init, headers }));
        }
        return original(input, { ...init, headers });
      } catch {
        return original(input, init);
      }
    }) as typeof window.fetch;
    return () => {
      window.fetch = original;
    };
  }
}

function isReadyElement(element: HTMLElement): boolean {
  if (!element.isConnected || element.hidden || element.getAttribute("aria-busy") === "true") return false;
  if (element.querySelector("[aria-busy='true'],[data-ui-surface-pending='true']")) return false;
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const controls = [...element.querySelectorAll<HTMLElement>(
    "button,a[href],input,select,textarea,[role='button'],[tabindex]",
  )].filter((control) => {
    const controlStyle = window.getComputedStyle(control);
    return controlStyle.display !== "none" && controlStyle.visibility !== "hidden";
  });
  return controls.length === 0 || controls.some((control) =>
    control.getAttribute("aria-disabled") !== "true"
    && !("disabled" in control && Boolean(control.disabled)));
}

export function installSurfaceRuntime(options: SurfaceRuntimeOptions): { dispose: () => void; runtime: SurfaceRuntime } {
  runtimeDispose?.();
  const next = new SurfaceRuntime(options);
  runtime = next;
  next.restorePageCandidate();
  const uninstall = next.install();
  const dispose = () => {
    uninstall();
    if (runtime === next) runtime = null;
    if (runtimeDispose === dispose) runtimeDispose = null;
  };
  runtimeDispose = dispose;
  return {
    runtime: next,
    dispose,
  };
}

export function getSurfaceRuntime(): SurfaceRuntime | null {
  return runtime;
}

export function isDialogContentReady(element: HTMLElement): boolean {
  return isReadyElement(element);
}

function createTraceparent(sampleRatio: number): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const traceId = [...bytes.slice(0, 16)].map(hexByte).join("");
  const spanId = [...bytes.slice(16)].map(hexByte).join("");
  const sampled = bytes[0] !== undefined && bytes[0] / 256 < sampleRatio ? "01" : "00";
  return `00-${traceId}-${spanId}-${sampled}`;
}

function hexByte(value: number): string {
  return value.toString(16).padStart(2, "0");
}
