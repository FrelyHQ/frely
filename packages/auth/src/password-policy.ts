export const PASSWORD_MIN_CODE_POINTS = 12;
export const PASSWORD_MAX_UTF8_BYTES = 256;

export type PasswordPolicyFailure = "too_short" | "too_long";

export interface PasswordPolicyResult {
  valid: boolean;
  failure: PasswordPolicyFailure | null;
  codePointLength: number;
  utf8ByteLength: number;
}

export function validatePasswordPolicy(password: string): PasswordPolicyResult {
  const codePointLength = Array.from(password).length;
  const utf8ByteLength = new TextEncoder().encode(password).byteLength;
  const failure = codePointLength < PASSWORD_MIN_CODE_POINTS
    ? "too_short"
    : utf8ByteLength > PASSWORD_MAX_UTF8_BYTES
      ? "too_long"
      : null;
  return { valid: failure === null, failure, codePointLength, utf8ByteLength };
}

export function passwordPolicyMessage(password: string): string | undefined {
  const result = validatePasswordPolicy(password);
  if (result.failure === "too_short") return `Password must contain at least ${PASSWORD_MIN_CODE_POINTS} characters`;
  if (result.failure === "too_long") return `Password must be at most ${PASSWORD_MAX_UTF8_BYTES} UTF-8 bytes`;
  return undefined;
}
