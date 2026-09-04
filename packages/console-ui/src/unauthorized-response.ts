export type UnauthorizedHandler = () => void;

export interface UnauthorizedRecoveryController {
  onUnauthorized: UnauthorizedHandler;
  reset(): void;
}

export type UnauthorizedRecoveryOutcome = "same-user" | "different-user";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function createUnauthorizedRecoveryController(activate: () => void): UnauthorizedRecoveryController {
  let recoveryActive = false;
  return {
    onUnauthorized: () => {
      if (recoveryActive) return;
      recoveryActive = true;
      activate();
    },
    reset: () => {
      recoveryActive = false;
    }
  };
}

export function installSessionExpiryRecovery(
  expiresAtEpochSeconds: number | null,
  onUnauthorized: UnauthorizedHandler,
  now: () => number = Date.now
): () => void {
  if (expiresAtEpochSeconds === null) return () => undefined;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;
  const activateAtExpiry = () => {
    if (cancelled) return;
    const remainingMs = (expiresAtEpochSeconds * 1_000) - now();
    if (remainingMs <= 0) {
      onUnauthorized();
      return;
    }
    timer = setTimeout(activateAtExpiry, Math.min(remainingMs, MAX_TIMER_DELAY_MS));
  };
  activateAtExpiry();

  return () => {
    cancelled = true;
    if (timer !== null) clearTimeout(timer);
  };
}

export function completeUnauthorizedRecovery(
  controller: UnauthorizedRecoveryController,
  options: {
    originalUserId: string | null;
    authenticatedUserId: string;
    deactivate: () => void;
    refresh: () => void;
    hardNavigate: (url: string) => void;
    differentUserHome: string;
  }
): UnauthorizedRecoveryOutcome {
  if (options.originalUserId !== options.authenticatedUserId) {
    options.hardNavigate(options.differentUserHome);
    return "different-user";
  }
  controller.reset();
  options.deactivate();
  options.refresh();
  return "same-user";
}

export function wrapFetchWithUnauthorizedHandler(
  fetchImplementation: typeof fetch,
  options: {
    currentUrl: () => string;
    onUnauthorized: UnauthorizedHandler;
  }
): typeof fetch {
  return async (input, init) => {
    const response = await fetchImplementation(input, init);
    if (response.status === 401 && isFrontendApiRequest(input, options.currentUrl())) {
      options.onUnauthorized();
    }
    return response;
  };
}

export function installUnauthorizedResponseInterceptor(onUnauthorized: UnauthorizedHandler): () => void {
  const originalFetch = window.fetch;
  const wrappedFetch = wrapFetchWithUnauthorizedHandler(originalFetch.bind(window), {
    currentUrl: () => window.location.href,
    onUnauthorized
  });
  window.fetch = wrappedFetch;

  return () => {
    if (window.fetch === wrappedFetch) window.fetch = originalFetch;
  };
}

function isFrontendApiRequest(input: RequestInfo | URL, currentUrl: string): boolean {
  const requestUrl = requestUrlFromInput(input, currentUrl);
  const pageUrl = new URL(currentUrl);
  return requestUrl.origin === pageUrl.origin
    && requestUrl.pathname.startsWith("/api/")
    && !requestUrl.pathname.startsWith("/api/auth/");
}

function requestUrlFromInput(input: RequestInfo | URL, baseUrl: string): URL {
  if (input instanceof Request) return new URL(input.url, baseUrl);
  return new URL(input.toString(), baseUrl);
}
