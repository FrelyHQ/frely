import profileDefinition from "./instance-data-profile.json" with { type: "json" };

export type InstanceDataColumnTransform =
  | Readonly<{ kind: "constant"; value: string }>
  | Readonly<{ kind: "null" }>;

export type InstanceDataProfile = Readonly<{
  schema: string;
  profileId: string;
  version: number;
  selection: "table-type";
  rowSelection: "whole-table";
  capabilities: Readonly<Record<string, boolean>>;
  requiredTablesByCategory: Readonly<Record<string, readonly string[]>>;
  runtimeStateTables: readonly string[];
  historicalFactTables: readonly string[];
  optionalFeatureTables: readonly string[];
  infrastructureTables: readonly string[];
  excludedFromMinimum: Readonly<Record<string, Readonly<{ reason: string; note: string }>>>;
  columnTransforms: Readonly<Record<string, Readonly<Record<string, InstanceDataColumnTransform>>>>;
  businessReferences: readonly Readonly<Record<string, string>>[];
}>;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const INSTANCE_DATA_PROFILE = deepFreeze(structuredClone(profileDefinition) as InstanceDataProfile);

export function listRequiredInstanceDataTables(profile: InstanceDataProfile = INSTANCE_DATA_PROFILE): readonly string[] {
  return Object.freeze(Object.values(profile.requiredTablesByCategory).flat());
}
