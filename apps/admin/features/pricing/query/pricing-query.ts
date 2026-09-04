export const pricingKeys = {
  all: ["owner", "pricing"] as const,
  reference: () => [...pricingKeys.all, "openai-reference"] as const,
  providerCandidates: (query: string, page: number) => [...pricingKeys.all, "provider-candidates", query, page] as const,
};
