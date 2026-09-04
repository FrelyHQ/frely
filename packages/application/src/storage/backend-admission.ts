export const DATABASE_BACKENDS = ["postgres"] as const;
export type DatabaseBackend = (typeof DATABASE_BACKENDS)[number];

export interface DatabaseBackendSelection { backend?: unknown; }

export interface RuntimeSchemaCompatibility {
  currentSchema: number;
  minReadableSchema: number;
  maxReadableSchema: number;
  minWritableSchema: number;
  maxWritableSchema: number;
  writeEnabled?: boolean;
}

export function normalizeDatabaseBackend(value: unknown): DatabaseBackend {
  if (value === undefined || value === null || value === "" || value === "postgres") return "postgres";
  throw new Error("database_backend_invalid");
}

export function assertDatabaseBackendAllowed(selection: DatabaseBackendSelection): DatabaseBackend {
  return normalizeDatabaseBackend(selection.backend);
}

export function assertRuntimeSchemaCompatibility(input: RuntimeSchemaCompatibility): void {
  const values = [input.currentSchema, input.minReadableSchema, input.maxReadableSchema, input.minWritableSchema, input.maxWritableSchema];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 1)) throw new Error("database_schema_compatibility_invalid");
  if (input.minReadableSchema > input.maxReadableSchema || input.minWritableSchema > input.maxWritableSchema) throw new Error("database_schema_compatibility_range_invalid");
  if (input.currentSchema < input.minReadableSchema || input.currentSchema > input.maxReadableSchema) throw new Error("database_schema_read_range_incompatible");
  if (input.writeEnabled !== false && (input.currentSchema < input.minWritableSchema || input.currentSchema > input.maxWritableSchema)) throw new Error("database_schema_write_range_incompatible");
}
