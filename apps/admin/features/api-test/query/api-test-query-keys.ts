export const apiTestQueryKeys = { all: ["owner", "api-test"] as const, inputs: () => [...apiTestQueryKeys.all, "inputs"] as const };
