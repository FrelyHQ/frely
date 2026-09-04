export interface UtcDateTimeFormatOptions {
  seconds?: boolean;
}

export interface ZonedDateTimeFormatOptions extends UtcDateTimeFormatOptions {
  timeZone: string;
}

export function formatZonedDate(value: string, timeZone: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone
  }).format(date);
}

export function formatZonedDateTime(value: string, options: ZonedDateTimeFormatOptions): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    ...(options.seconds ? { second: "2-digit" as const } : {}),
    hour12: false,
    timeZone: options.timeZone
  }).format(date);
}

export function formatTimeZoneOffset(value: string, timeZone: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")?.value ?? "";
}

export function formatUtcDate(value: string): string {
  return formatZonedDate(value, "UTC");
}

export function formatUtcDateTime(value: string, options: UtcDateTimeFormatOptions = {}): string {
  return formatZonedDateTime(value, { ...options, timeZone: "UTC" });
}
