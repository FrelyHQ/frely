export function teamInviteRegistrationUrl(publicBaseUrl: string, inviteToken: string): string {
  const url = new URL("/register", publicBaseUrl);
  url.search = `?token=${encodeURIComponent(inviteToken)}`;
  return url.toString();
}
