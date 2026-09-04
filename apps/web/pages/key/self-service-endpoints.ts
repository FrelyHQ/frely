export const SELF_SERVICE_ENDPOINTS = [
  { id: "usage", resource: "Usage", endpoint: "/api/key/usage" },
  { id: "budget", resource: "Budget", endpoint: "/api/key/budget" }
] as const;
