import { RelayError } from "@frely/core";
import { EmailAddr } from "@frely/identity";

const MAX_INVITE_EMAIL_DOMAIN_LENGTH = 253;
const EMAIL_DOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u;

export interface InviteEmailDomainTestResult {
  allowed: boolean;
  domain: string;
}

export function normalizeInviteEmailDomainPattern(value: string | null): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw invalidInviteEmailDomain("Invite email domain must be a string or null");
  }
  const domain = value.trim().toLowerCase().replaceAll("\\.", ".");
  if (!domain) {
    throw invalidInviteEmailDomain("Invite email domain cannot be empty; use null to remove the restriction");
  }
  if (!validEmailDomain(domain)) {
    throw invalidInviteEmailDomain("Invite email domain must be one valid exact domain");
  }
  return domain;
}

export function inviteEmailDomainAllowed(email: string, storedValue: string | null): boolean {
  try {
    return testInviteEmailDomainPattern(email, storedValue).allowed;
  } catch {
    // Unsupported historical expressions fail closed until an administrator
    // replaces them with one exact domain.
    return false;
  }
}

export function testInviteEmailDomainPattern(email: string, value: string | null): InviteEmailDomainTestResult {
  const configuredDomain = normalizeInviteEmailDomainPattern(value);
  const domain = normalizedEmailDomain(email);
  return {
    allowed: Boolean(domain && (configuredDomain === null || domain === configuredDomain)),
    domain,
  };
}

function normalizedEmailDomain(email: string): string {
  try {
    return EmailAddr.parse(email).domain;
  } catch {
    return "";
  }
}

function validEmailDomain(value: string): boolean {
  return value.length <= MAX_INVITE_EMAIL_DOMAIN_LENGTH && EMAIL_DOMAIN_PATTERN.test(value);
}

function invalidInviteEmailDomain(message: string): RelayError {
  return new RelayError("invalid_invite_email_domain_pattern", message, 400);
}
