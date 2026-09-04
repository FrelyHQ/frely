"use client";

import { useEffect, useState } from "react";
import { formatTimeZoneOffset, formatZonedDate, formatZonedDateTime } from "../lib/date-time";
import { Tooltip } from "./tooltip";

export interface BrowserTimeProps {
  value: string;
  dateOnly?: boolean;
  seconds?: boolean;
}

export function BrowserTime({ value, dateOnly = false, seconds = false }: BrowserTimeProps) {
  const [timeZone, setTimeZone] = useState("UTC");

  useEffect(() => {
    setTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  }, []);

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return <span>{value}</span>;
  const display = dateOnly
    ? formatZonedDate(value, timeZone)
    : formatZonedDateTime(value, { timeZone, seconds });
  const offset = formatTimeZoneOffset(value, timeZone);
  return (
    <Tooltip content={`Time zone: ${timeZone}${offset ? ` (${offset})` : ""}`}>
      <time className="whitespace-nowrap" dateTime={date.toISOString()} tabIndex={0}>{display}</time>
    </Tooltip>
  );
}

export function BrowserTimeRange({ start, end, seconds = false, openEndLabel = "No end" }: { start: string; end: string | null; seconds?: boolean; openEndLabel?: string }) {
  return <><BrowserTime value={start} seconds={seconds} /> - {end ? <BrowserTime value={end} seconds={seconds} /> : openEndLabel}</>;
}
