export interface ProviderModelMapping {
  name: string;
  alias: string;
}

export function appendProviderModelMapping(mappings: readonly ProviderModelMapping[], modelName: string): ProviderModelMapping[] {
  const name = modelName.trim();
  if (!name || mappings.some((mapping) => mapping.name.trim() === name)) return [...mappings];
  const aliases = new Set(mappings.map((mapping) => mapping.alias.trim()).filter(Boolean));
  let alias = name;
  let suffix = 2;
  while (aliases.has(alias)) {
    alias = `${name}-${suffix}`;
    suffix += 1;
  }
  return [...mappings, { name, alias }];
}

export function normalizeProviderModelMappings(mappings: readonly ProviderModelMapping[]):
  | { ok: true; value: ProviderModelMapping[] }
  | { ok: false; error: string } {
  if (mappings.length === 0) return { ok: false, error: "Select or add at least one upstream model." };
  if (mappings.length > 8192) return { ok: false, error: "A Provider can contain at most 8192 model mappings." };
  const aliases = new Set<string>();
  const value: ProviderModelMapping[] = [];
  for (const mapping of mappings) {
    const name = mapping.name.trim();
    const alias = mapping.alias.trim();
    if (!name || !alias) return { ok: false, error: "Every model mapping requires an upstream model and Friday alias." };
    if (name.includes("/") || alias.includes("/")) return { ok: false, error: "Model names and Friday aliases cannot contain '/'." };
    if (aliases.has(alias)) return { ok: false, error: `Friday model alias must be unique within this Provider: ${alias}` };
    aliases.add(alias);
    value.push({ name, alias });
  }
  return { ok: true, value };
}
