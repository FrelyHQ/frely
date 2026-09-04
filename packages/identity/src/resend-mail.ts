import type { AppConfig } from "@frely/config";
import { RelayError } from "@frely/core";

const RESEND_EMAILS_ENDPOINT = "https://api.resend.com/emails";
const RESEND_REQUEST_TIMEOUT_MS = 10_000;
const RESEND_API_KEY_ENV = "EMAIL_SRV_RESEND";

export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export interface MailTransport {
  send(message: MailMessage): Promise<void>;
}

export interface ResendMailTransportOptions {
  readonly apiKey: string;
  readonly from: string;
  readonly endpoint?: string;
  readonly fetchImplementation?: typeof fetch;
  readonly timeoutMs?: number;
}

export type MailEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * Send a single transactional message through Resend's HTTPS API.
 *
 * The transport deliberately exposes only a small mail port to Better Auth.
 * Provider response bodies and transport errors are never rethrown, because
 * they may contain provider details or other data that must not reach logs or
 * an authentication response.
 */
export function createResendMailTransport(options: ResendMailTransportOptions): MailTransport {
  const apiKey = options.apiKey.trim();
  const from = options.from.trim();
  if (!apiKey || !from) throw new RelayError("email_transport_invalid_config", "Email transport configuration is invalid", 500);

  const endpoint = validateEndpoint(options.endpoint ?? RESEND_EMAILS_ENDPOINT);
  const timeoutMs = options.timeoutMs ?? RESEND_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
    throw new RelayError("email_transport_invalid_config", "Email transport configuration is invalid", 500);
  }

  const fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new RelayError("email_transport_unavailable", "Email delivery is unavailable", 503);
  }

  return Object.freeze({
    send: async (message: MailMessage): Promise<void> => {
      const payload = messagePayload(message, from);
      try {
        const response = await fetchImplementation(endpoint, {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
            "user-agent": "friday-relay-email/1",
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeoutMs),
        });
        await releaseResponseBody(response);
        if (!response.ok) throw new RelayError("email_delivery_failed", "Email delivery failed", 502);
      } catch (error) {
        if (error instanceof RelayError) throw error;
        throw new RelayError("email_delivery_failed", "Email delivery failed", 502);
      }
    },
  });
}

/** Resolve the existing deployment secret without making email mandatory at application startup. */
export function createResendMailTransportFromEnvironment(
  config: Pick<AppConfig, "app">,
  environment: MailEnvironment = process.env,
): MailTransport | undefined {
  const apiKey = environment[RESEND_API_KEY_ENV]?.trim();
  if (!apiKey) return undefined;

  return createResendMailTransport({
    apiKey,
    from: resendSenderForConfig(config),
  });
}

export function resendSenderForConfig(config: Pick<AppConfig, "app">): string {
  const hostname = new URL(config.app.publicBaseUrl).hostname;
  return `Frely <noreply@${hostname}>`;
}

/** Build a fixed-purpose link message; dynamic values are escaped before entering HTML. */
export function createAuthLinkEmail(input: {
  readonly to: string;
  readonly subject: string;
  readonly title: string;
  readonly description: string;
  readonly action: string;
  readonly url: string;
}): MailMessage {
  const safeTitle = escapeHtml(input.title);
  const safeDescription = escapeHtml(input.description);
  const safeAction = escapeHtml(input.action);
  const safeUrl = escapeHtml(input.url);
  return {
    to: input.to,
    subject: input.subject,
    text: `${input.description}\n\n${input.url}\n\nIf you did not request this email, you can ignore it.`,
    html: `<!doctype html><html lang="en"><body><h1>${safeTitle}</h1><p>${safeDescription}</p><p><a href="${safeUrl}">${safeAction}</a></p><p>If you did not request this email, you can ignore it.</p></body></html>`,
  };
}

function validateEndpoint(value: string): string {
  try {
    const endpoint = new URL(value);
    if (endpoint.protocol !== "https:") throw new Error("https_required");
    return endpoint.toString();
  } catch {
    throw new RelayError("email_transport_invalid_config", "Email transport configuration is invalid", 500);
  }
}

function messagePayload(message: MailMessage, from: string): {
  from: string;
  to: string[];
  subject: string;
  html: string;
  text: string;
} {
  const to = message.to.trim();
  if (!to || !message.subject.trim() || !message.html.trim() || !message.text.trim()) {
    throw new RelayError("email_message_invalid", "Email message is invalid", 500);
  }
  return {
    from,
    to: [to],
    subject: message.subject,
    html: message.html,
    text: message.text,
  };
}

async function releaseResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The provider response is not part of the application contract.
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}
