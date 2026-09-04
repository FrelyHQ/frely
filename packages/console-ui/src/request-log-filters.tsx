"use client";

import { useMemo, useRef, useState } from "react";
import { Button } from "@frely/ui/components/button";
import { SearchSelect, type SearchSelectOption } from "./search-select.js";

const TIME_WINDOW_OPTIONS: SearchSelectOption[] = [
  { value: "24h", label: "24h", description: "Past 24 hours" },
  { value: "3d", label: "3 days", description: "Past 3 days", searchText: "3d" },
  { value: "7d", label: "7 days", description: "Past 7 days", searchText: "7d" },
  { value: "1mo", label: "1 month", description: "Past 1 month", searchText: "1mo" }
];

export interface RequestLogFilterApiKey {
  id: string;
  name: string;
  keyPrefix: string;
}

export interface RequestLogFilterOption {
  value: string;
  label: string;
  description?: string;
  searchText?: string;
}

export function RequestLogFilters({
  action,
  className = "",
  resetHref,
  status,
  providerId = "",
  providerOptions = [],
  model = "",
  modelOptions = [],
  apiKeyId = "",
  apiKeys,
  owner = "",
  ownerOptions = [],
  duration = "",
  start,
  timeWindow,
  downloadHref,
  canBatchDownload,
  hiddenParams = {},
}: {
  action: string;
  className?: string;
  resetHref: string;
  status: string;
  providerId?: string;
  providerOptions?: RequestLogFilterOption[];
  model?: string;
  modelOptions?: RequestLogFilterOption[];
  apiKeyId?: string;
  apiKeys?: RequestLogFilterApiKey[];
  owner?: string;
  ownerOptions?: RequestLogFilterOption[];
  duration?: string;
  start: string;
  timeWindow: string;
  downloadHref: string;
  canBatchDownload: boolean;
  hiddenParams?: Record<string, string>;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [selectedStatus, setSelectedStatus] = useState(status);
  const [selectedTimeWindow, setSelectedTimeWindow] = useState(timeWindow);
  const [selectedProviderId, setSelectedProviderId] = useState(providerId);
  const [selectedApiKeyId, setSelectedApiKeyId] = useState(apiKeyId);
  const [selectedOwner, setSelectedOwner] = useState(owner);
  const [selectedDuration, setSelectedDuration] = useState(duration);
  const [selectedModel, setSelectedModel] = useState(model);
  const [selectedStart, setSelectedStart] = useState(start);
  const apiKeyOptions: RequestLogFilterOption[] = (apiKeys ?? []).map((apiKey) => ({
    value: apiKey.id,
    label: apiKey.name,
    description: apiKey.keyPrefix,
    searchText: `${apiKey.name} ${apiKey.keyPrefix} ${apiKey.id}`
  }));
  const activeFilters = [
    selectedStatus ? { name: "status" as const, label: `Status: ${selectedStatus}` } : null,
    selectedProviderId ? { name: "providerId" as const, label: `Provider: ${optionLabel(providerOptions, selectedProviderId)}` } : null,
    selectedModel ? { name: "model" as const, label: `Model: ${selectedModel}` } : null,
    selectedApiKeyId ? { name: "apiKeyId" as const, label: `API key: ${optionLabel(apiKeyOptions, selectedApiKeyId)}` } : null,
    selectedOwner ? { name: "owner" as const, label: `Owner: ${optionLabel(ownerOptions, selectedOwner)}` } : null,
    selectedDuration ? { name: "duration" as const, label: `Duration: ${optionLabel(DURATION_OPTIONS, selectedDuration)}` } : null,
    selectedStart ? { name: "start" as const, label: `Start: ${selectedStart}` } : null,
    selectedTimeWindow && selectedTimeWindow !== "24h" ? { name: "timeWindow" as const, label: `Window: ${selectedTimeWindow}` } : null
  ].filter((filter): filter is NonNullable<typeof filter> => filter !== null);

  return (
    <form ref={formRef} className={["request-log-filter-bar", className].filter(Boolean).join(" ")} action={action}>
      {Object.entries(hiddenParams).map(([name, value]) => value ? <input key={name} type="hidden" name={name} value={value} /> : null)}
      <div className="request-log-filter-primary" aria-label="Common filters">
        <label className="request-log-filter-field" data-size="status">
          Status
          <SearchSelect name="status" value={selectedStatus} searchable={false} onValueChange={(value) => { setSelectedStatus(value); submitSoon(); }} options={[{ value: "", label: "All statuses" }, { value: "started", label: "Started" }, { value: "completed", label: "Completed" }, { value: "failed", label: "Failed" }]} />
        </label>
        <SearchSelectFilter
          label="Model"
          name="model"
          value={selectedModel}
          options={modelOptions}
          placeholder="All models"
          allowCustomValue
          size="model"
          onChange={setSelectedModel}
          onValueCommit={submitSoon}
        />
        {apiKeyOptions.length > 0 ? (
          <SearchSelectFilter label="API Key" name="apiKeyId" value={selectedApiKeyId} options={apiKeyOptions} placeholder="All keys" size="api-key" onChange={setSelectedApiKeyId} onValueCommit={submitSoon} />
        ) : apiKeys ? (
          <label className="request-log-filter-field" data-size="api-key">
            API Key
            <SearchSelect name="apiKeyId" value={selectedApiKeyId} searchable={false} onValueChange={(value) => { setSelectedApiKeyId(value); submitSoon(); }} options={[{ value: "", label: "All keys" }]} />
          </label>
        ) : null}
        <label className="request-log-filter-field" data-size="window">
          Time Window
          <SearchSelect name="timeWindow" value={selectedTimeWindow} options={TIME_WINDOW_OPTIONS} onValueChange={(value) => { setSelectedTimeWindow(value); submitSoon(); }} placeholder="24h, 3d, 7d, 1mo, 12h" allowCustomValue />
        </label>
      </div>
      <details className="request-log-more-filters">
        <summary>More filters</summary>
        <div className="request-log-filter-secondary">
          {providerOptions.length > 0 ? <SearchSelectFilter label="Provider" name="providerId" value={selectedProviderId} options={providerOptions} placeholder="All providers" size="provider" onChange={setSelectedProviderId} onValueCommit={submitSoon} /> : null}
          {ownerOptions.length > 0 ? <SearchSelectFilter label="Owner" name="owner" value={selectedOwner} options={ownerOptions} placeholder="All owners" size="owner" onChange={setSelectedOwner} onValueCommit={submitSoon} /> : null}
          <SearchSelectFilter label="Duration" name="duration" value={selectedDuration} options={DURATION_OPTIONS} placeholder="All durations" size="duration" onChange={setSelectedDuration} onValueCommit={submitSoon} />
          <label className="request-log-filter-field" data-size="start">Start<input type="datetime-local" name="start" value={selectedStart} onChange={(event) => { setSelectedStart(event.target.value); submitSoon(); }} /></label>
        </div>
      </details>
      <div className="request-log-filter-actions">
        {canBatchDownload ? (
          <Button asChild variant="default" className="request-log-download-button"><a href={downloadHref} download>Batch Download</a></Button>
        ) : (
          <Button type="button" variant="default" className="request-log-download-button" disabled>Batch Download</Button>
        )}
        <Button asChild variant="ghost">
          <a href={resetHref}>Reset</a>
        </Button>
      </div>
      {activeFilters.length > 0 ? (
        <div className="request-log-filter-chips" aria-label="Applied filters">
          {activeFilters.map((filter) => <Button key={filter.name} type="button" size="sm" variant="secondary" onClick={() => clearFilter(filter.name)}>{filter.label}<span aria-hidden="true">×</span></Button>)}
        </div>
      ) : null}
    </form>
  );

  function submitSoon() {
    window.setTimeout(() => formRef.current?.requestSubmit(), 0);
  }

  function clearFilter(name: (typeof activeFilters)[number]["name"]) {
    if (name === "status") setSelectedStatus("");
    if (name === "providerId") setSelectedProviderId("");
    if (name === "model") setSelectedModel("");
    if (name === "apiKeyId") setSelectedApiKeyId("");
    if (name === "owner") setSelectedOwner("");
    if (name === "duration") setSelectedDuration("");
    if (name === "start") setSelectedStart("");
    if (name === "timeWindow") setSelectedTimeWindow("24h");
    submitSoon();
  }
}

const DURATION_OPTIONS: SearchSelectOption[] = [
  { value: "open", label: "Open", description: "No end time" },
  { value: "lt1s", label: "< 1s", description: "Under 1 second", searchText: "less than 1s" },
  { value: "1s-5s", label: "1s - 5s", description: "1 to 5 seconds" },
  { value: "5s-30s", label: "5s - 30s", description: "5 to 30 seconds" },
  { value: "30s+", label: "30s+", description: "30 seconds or more", searchText: "slow" }
];

function SearchSelectFilter({
  label,
  name,
  value,
  options,
  placeholder,
  size,
  allowCustomValue = false,
  onChange,
  onValueCommit
}: {
  label: string;
  name: string;
  value: string;
  options: SearchSelectOption[];
  placeholder: string;
  size: "provider" | "model" | "api-key" | "owner" | "duration";
  allowCustomValue?: boolean;
  onChange: (value: string) => void;
  onValueCommit: () => void;
}) {
  const searchOptions = useMemo(() => [{ value: "", label: placeholder }, ...options], [options, placeholder]);
  return (
    <label className="request-log-filter-field" data-size={size}>
      {label}
      <SearchSelect
        name={name}
        value={value}
        options={searchOptions}
        onValueChange={(nextValue) => {
          onChange(nextValue);
          onValueCommit();
        }}
        placeholder={placeholder}
        allowCustomValue={allowCustomValue}
        searchable={size !== "duration"}
      />
    </label>
  );
}

function optionLabel(options: RequestLogFilterOption[], value: string): string {
  return options.find((option) => option.value === value)?.label ?? value;
}
