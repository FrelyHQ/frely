type ClarityRuntimeEnvironment = {
  [key: string]: string | undefined;
  FRIDAY_RELAY_CLARITY_PROJECT_ID?: string;
};

export function resolveClarityProjectId(
  appEnvironment: string,
  environment: ClarityRuntimeEnvironment = process.env,
): string | null {
  if (appEnvironment !== "production") return null;
  return environment.FRIDAY_RELAY_CLARITY_PROJECT_ID?.trim() || null;
}
