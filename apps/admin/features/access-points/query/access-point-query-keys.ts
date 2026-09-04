export const accessPointKeys = {
  all: ["owner", "access-points"] as const,
  modelCandidates: (providerId: string) =>
    [
      "owner",
      "access-points",
      "provider-model-candidates",
      providerId,
    ] as const,
  targetCandidates: (query: string, page: number) => ["owner", "access-points", "target-candidates", query, page] as const,
};
