export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export function toJsonObject(value: unknown): JsonObject {
  const projected = toJsonValue(value);
  return projected !== null && typeof projected === "object" && !Array.isArray(projected)
    ? projected
    : {};
}

function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    const projected: JsonValue[] = [];
    for (const item of value) {
      const next = toJsonValue(item);
      if (next !== undefined) projected.push(next);
    }
    return projected;
  }
  if (typeof value !== "object") return undefined;
  const entries: Array<[string, JsonValue]> = [];
  for (const [key, item] of Object.entries(value)) {
    const next = toJsonValue(item);
    if (next !== undefined) entries.push([key, next]);
  }
  return Object.fromEntries(entries);
}
