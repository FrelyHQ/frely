export async function signOut(): Promise<void> {
  const response = await fetch("/api/auth/logout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  });
  if (!response.ok) throw new Error("Failed to sign out");
}
