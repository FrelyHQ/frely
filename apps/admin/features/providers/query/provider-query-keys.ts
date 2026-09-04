export const providerQueryKeys = {
  root: ["owner", "providers"] as const,
  dialogData: () => [...providerQueryKeys.root, "dialog-data"] as const,
  userCandidates: (query: string, page: number) => [...providerQueryKeys.root, "user-candidates", query, page] as const,
  apiKeyCandidates: (query: string, page: number) => [...providerQueryKeys.root, "api-key-candidates", query, page] as const
};
