import type { IndicatorReading } from "../../types/technical-indicators.ts";
import { formatChange, formatRatio, formatShare, formatUsd, formatUtc, isValidNumber, type Tone } from "./format.ts";

/**
 * Display text for a technical indicator reading. Formatting only: the server
 * has already decided the indicator is available and the value is valid.
 */
export function formatReading(reading: IndicatorReading): string | null {
  const { value, unit } = reading;
  if (typeof value === "string") return unit === "date" ? formatUtc(value, false) : value;
  if (!isValidNumber(value)) return null;
  switch (unit) {
    case "usd": return formatUsd(value);
    case "usd_total": return formatUsd(value, true);
    case "percent": return formatShare(value);
    case "percent_change": return formatChange(value)?.text ?? null;
    case "percent_per_day": { const text = formatChange(value)?.text; return text ? `${text} / day` : null; }
    case "index": return value.toFixed(1);
    case "ratio": return value.toFixed(2);
    case "multiple": return formatRatio(value);
    default: return String(value);
  }
}

/** Direction of a reading, for readings that are explicit changes/gaps (percent_change, percent_per_day); everything else is neutral. */
export function readingTone(reading: IndicatorReading): Tone {
  const { value, unit } = reading;
  if ((unit === "percent_change" || unit === "percent_per_day") && typeof value === "number" && isValidNumber(value)) {
    return formatChange(value)?.tone ?? "neutral";
  }
  return "neutral";
}

/** Short parameter summary, e.g. "period 20 · deviations 2". */
export function formatParameters(parameters: Record<string, number | string>): string {
  return Object.entries(parameters)
    .map(([key, value]) => `${key.replace(/([A-Z])/g, " $1").toLowerCase()} ${value}`)
    .join(" · ");
}
