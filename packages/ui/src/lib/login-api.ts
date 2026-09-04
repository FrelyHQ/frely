export interface LoginInput { email: string; password: string }
export interface AuthenticatedLoginUser { id: string }

export async function login(input: LoginInput): Promise<AuthenticatedLoginUser> {
  const response = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  });
  const body = await response.json().catch(() => ({})) as { user?: { id?: unknown }; error?: { message?: string } };
  if (!response.ok) throw new Error(body.error?.message ?? "Failed to sign in");
  if (typeof body.user?.id !== "string" || !body.user.id) throw new Error("Invalid sign-in response");
  return { id: body.user.id };
}
