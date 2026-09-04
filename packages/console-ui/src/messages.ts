export const CONSOLE_MESSAGE_KEYS = [
  "common.preview_only",
  "common.retry",
  "team_invite.loading",
  "team_invite.copy_succeeded",
  "team_invite.copy_failed",
  "team_invite.request_failed",
  "team_invite.created",
  "team_invite.existing_link",
  "team_invite.disabled",
  "team_invite.domain_restricted",
  "team_invite.domain_open",
  "team_invite.members_enabled",
  "team_invite.members_disabled",
  "api_key.create",
  "api_key.created",
  "api_key.copy_once",
  "api_key.create_failed",
  "api_key.update_failed",
  "credit.preview_only",
  "credit.checkout_failed",
  "credit.topup_failed",
] as const;

export type ConsoleMessageKey = (typeof CONSOLE_MESSAGE_KEYS)[number];
export type ConsoleMessageValues = Readonly<Record<string, string | number>>;

export interface ConsoleMessageContext {
  defaultMessage: string;
  values: ConsoleMessageValues;
}

export type ConsoleMessageResolver = (
  key: ConsoleMessageKey,
  context: ConsoleMessageContext,
) => string;

export function resolveConsoleMessage(
  resolver: ConsoleMessageResolver | undefined,
  key: ConsoleMessageKey,
  defaultMessage: string,
  values: ConsoleMessageValues = {},
): string {
  if (resolver) return resolver(key, { defaultMessage, values });
  return interpolateConsoleMessage(defaultMessage, values);
}

export function interpolateConsoleMessage(
  message: string,
  values: ConsoleMessageValues,
): string {
  return message.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (placeholder, key: string) => {
    const value = values[key];
    return value === undefined ? placeholder : String(value);
  });
}
