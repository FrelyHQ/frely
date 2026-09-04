import { RelayError } from "@frely/core";

export const ACCESS_POINT_DESCRIPTION_MAX_LENGTH = 500;

export function normalizeAccessPointDescription(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new RelayError("invalid_access_point_description", "AccessPoint description must be a string or null", 400);
  }
  const normalized = value.trim();
  if (!normalized) return null;
  if ([...normalized].length > ACCESS_POINT_DESCRIPTION_MAX_LENGTH) {
    throw new RelayError(
      "invalid_access_point_description",
      `AccessPoint description must be ${ACCESS_POINT_DESCRIPTION_MAX_LENGTH} Unicode code points or fewer`,
      400,
    );
  }
  return normalized;
}
