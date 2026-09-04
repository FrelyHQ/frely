import { createId, RelayError } from "@frely/core";
import type { Provider, ApplicationOperationPort } from "@frely/application/runtime";
import { validateProviderId } from "../cliproxy/provider-id.js";

type ProviderCreateInput = Parameters<ApplicationOperationPort["createProvider"]>[0];

const GENERATED_PROVIDER_ID_PATTERN = /^prv_[0-9a-f]{24}$/u;
const PROVIDER_ID_INSERT_ATTEMPTS = 8;

export function generateProviderId(): string {
  return assertGeneratedProviderId(createId("prv"));
}

export function insertProviderWithGeneratedId(
  repo: ApplicationOperationPort,
  input: ProviderCreateInput,
  nextId: () => string = generateProviderId
): Provider {
  let candidate = { ...input, id: assertGeneratedProviderId(input.id) };
  for (let attempt = 0; attempt < PROVIDER_ID_INSERT_ATTEMPTS; attempt += 1) {
    try {
      return repo.createProvider(candidate);
    } catch (error) {
      if (!isProviderIdCollision(error)) throw error;
      if (attempt + 1 >= PROVIDER_ID_INSERT_ATTEMPTS) break;
      candidate = { ...candidate, id: assertGeneratedProviderId(nextId()) };
    }
  }
  throw new RelayError("provider_id_generation_failed", "Provider ID could not be generated", 503);
}

function assertGeneratedProviderId(value: string): string {
  try {
    validateProviderId(value);
  } catch {
    throw new RelayError("provider_id_generation_failed", "Provider ID generator returned an invalid ID", 503);
  }
  if (!GENERATED_PROVIDER_ID_PATTERN.test(value)) {
    throw new RelayError("provider_id_generation_failed", "Provider ID generator returned an invalid ID", 503);
  }
  return value;
}

function isProviderIdCollision(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed: providers\.id/u.test(error.message);
}
