export interface CreateUserTeamOption {
  id: string;
  name: string;
}

const INITIAL_PASSWORD_LENGTH = 24;
const INITIAL_PASSWORD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function generateInitialPassword(randomBytes = crypto.getRandomValues(new Uint8Array(INITIAL_PASSWORD_LENGTH))): string {
  if (randomBytes.length !== INITIAL_PASSWORD_LENGTH) throw new Error(`Initial password entropy must contain ${INITIAL_PASSWORD_LENGTH} bytes`);
  return Array.from(randomBytes, (value) => INITIAL_PASSWORD_ALPHABET[value & 63]).join("");
}

export function createUserFormDefaults(teams: CreateUserTeamOption[], initialPassword = generateInitialPassword()) {
  return { teamId: teams[0]?.id ?? "", email: "", password: initialPassword };
}

export function toCreateUserInput(value: { teamId: string; email: string; password: string }) {
  return { teamId: value.teamId, email: value.email.trim(), password: value.password };
}
