"use client";

import React, { useState } from "react";
import { Button } from "@frely/ui/components/button";
import { Input } from "@frely/ui/components/input";
import { SearchSelect } from "../../../pages/owner/_components/search-select";
import {
  appendProviderModelMapping,
  type ProviderModelMapping
} from "../form/provider-model-mappings";

export function ProviderModelMappingEditor({
  value,
  onChange,
  disabled = false
}: {
  value: ProviderModelMapping[];
  onChange: (value: ProviderModelMapping[]) => void;
  disabled?: boolean;
}) {
  const [candidate, setCandidate] = useState("");

  return <div className="embedded-section" data-testid="provider-model-mapping-editor">
    <div className="panel-heading">
      <div>
        <strong>Models</strong>
        <p>Enter upstream model names explicitly. Each alias is scoped to this Provider; credential-backed catalog sync can discover additional models after connection.</p>
      </div>
      <span>{value.length} selected</span>
    </div>
    <div className="form-grid">
      <label>Add upstream model
        <SearchSelect
          ariaLabel="Add upstream model"
          value={candidate}
          options={[]}
          onValueChange={setCandidate}
          allowCustomValue
          placeholder="Enter an upstream model"
          disabled={disabled}
        />
      </label>
      <div className="drawer-actions">
        <Button type="button" variant="secondary" disabled={disabled || !candidate.trim()} onClick={() => {
          onChange(appendProviderModelMapping(value, candidate));
          setCandidate("");
        }}>Add model</Button>
      </div>
    </div>
    {value.length === 0 ? <div className="notice-box">No models selected. API-key Providers require at least one mapping.</div> : null}
    {value.map((mapping, index) => <div className="form-grid" data-testid="provider-model-mapping" key={index}>
      <label>Upstream Model {index + 1}
        <Input
          aria-label={`Upstream Model ${index + 1}`}
          value={mapping.name}
          disabled={disabled}
          onChange={(event) => onChange(updateMapping(value, index, "name", event.target.value))}
        />
      </label>
      <label>Friday Model Alias {index + 1}
        <Input
          aria-label={`Friday Model Alias ${index + 1}`}
          value={mapping.alias}
          disabled={disabled}
          onChange={(event) => onChange(updateMapping(value, index, "alias", event.target.value))}
        />
      </label>
      <div className="drawer-actions">
        <Button type="button" variant="secondary" disabled={disabled} aria-label={`Remove model ${index + 1}`} onClick={() => onChange(value.filter((_, itemIndex) => itemIndex !== index))}>Remove</Button>
      </div>
    </div>)}
  </div>;
}

function updateMapping(
  mappings: readonly ProviderModelMapping[],
  index: number,
  field: keyof ProviderModelMapping,
  nextValue: string
): ProviderModelMapping[] {
  return mappings.map((mapping, itemIndex) => {
    if (itemIndex !== index) return mapping;
    if (field === "name") {
      return {
        name: nextValue,
        alias: mapping.alias === mapping.name ? nextValue : mapping.alias
      };
    }
    return { ...mapping, alias: nextValue };
  });
}
