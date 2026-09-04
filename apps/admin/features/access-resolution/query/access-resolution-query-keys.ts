export const accessResolutionQueryKeys = {
  all: ["owner", "access-resolution"] as const,
  inputs: () => [...accessResolutionQueryKeys.all, "inputs"] as const
};
