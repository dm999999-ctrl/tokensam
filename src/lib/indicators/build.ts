import {
  INDICATOR_CATEGORIES,
  type IndicatorCategory,
  type IndicatorInput,
  type TechnicalIndicator,
  type TechnicalIndicatorsView,
} from "../../types/technical-indicators.ts";
import { INDICATOR_DEFINITIONS, type IndicatorDefinition } from "./catalog.ts";
import { DAY_MS, SERIES_RULES, alignSeries, contiguousTail, dailySamples, maxHistoryAgeDays, type DailyPoint, type ObservationRow } from "./series.ts";

/**
 * Technical indicator pipeline:
 * stored observations → daily samples → per-indicator availability check →
 * deterministic calculation → every defined indicator, calculated or not.
 *
 * The Technical Analysis section is persistent: every registered indicator
 * definition always produces a card. Data availability only ever changes an
 * indicator's own status (available / stale / unavailable), never whether the
 * section or its category groups render. A newest sample older than the
 * indicator's usual freshness allowance is shown anyway (status "stale"),
 * using the most recent usable data rather than hiding it — nothing is
 * interpolated, filled, substituted, or backdated to look fresher than it is.
 */

export const CATEGORY_LABELS: Record<IndicatorCategory, string> = {
  trend: "Trend",
  momentum: "Momentum",
  volatility: "Volatility",
  volume: "Volume",
  market_structure: "Market structure · price action",
  derivatives: "Derivatives",
  on_chain: "On-chain",
  divergence: "Cross-metric analysis",
};

export const INDICATOR_METHOD = "Daily samples at 00:00 UTC taken from stored observations (the observation nearest each midnight, within 30 minutes; supply within 6 hours). "
  + "Each indicator uses the most recent run of consecutive days it has, needs its stated minimum number of days, and is shown as of its newest sample — marked stale once that sample is more than half the indicator's window old (for example 10 days for SMA(20), 7 for RSI(14), 15 for 30D comparisons), but never hidden for that reason. "
  + "Nothing is interpolated, filled or substituted.";

export type OmittedIndicator = { id: string; reason: "missing_input" | "insufficient_history" | "not_calculable" | "protocol_not_mapped"; detail: string };
const REASON_DETAIL: Record<OmittedIndicator["reason"], (definition: IndicatorDefinition, extra: string) => string> = {
  missing_input: (_d, extra) => `No usable daily samples for ${extra}.`,
  insufficient_history: (definition, extra) => `${extra} consecutive daily samples; ${definition.minPoints} required.`,
  not_calculable: () => "The stored values do not support this calculation (for example, no variation).",
  protocol_not_mapped: () => "No associated protocol is mapped for this token, so protocol-scope data is unavailable.",
};

export type IndicatorOptions = {
  asOf: Date;
  /** TVL is protocol-scope data and is used only when a curated protocol mapping exists. */
  protocolMapped: boolean;
  definitions?: IndicatorDefinition[];
};

function inputSamples(rows: ObservationRow[], input: IndicatorInput, options: IndicatorOptions): DailyPoint[] {
  if (input === "tvl" && !options.protocolMapped) return [];
  return dailySamples(rows, SERIES_RULES[input], options.asOf.getTime());
}

export function evaluateTechnicalIndicators(rows: ObservationRow[], options: IndicatorOptions): {
  view: TechnicalIndicatorsView;
  omitted: OmittedIndicator[];
} {
  const asOf = options.asOf.getTime();
  const calculatedAt = options.asOf.toISOString();
  const samples = new Map<IndicatorInput, DailyPoint[]>();
  const samplesFor = (input: IndicatorInput) => {
    if (!samples.has(input)) samples.set(input, inputSamples(rows, input, options));
    return samples.get(input)!;
  };

  const results: TechnicalIndicator[] = [];
  const omitted: OmittedIndicator[] = [];
  const base = (definition: IndicatorDefinition) => ({
    id: definition.id, name: definition.name, category: definition.category,
    parameters: definition.parameters, periodLabel: definition.periodLabel,
    summary: definition.summary, description: definition.description, formula: definition.formula,
  });
  const unavailable = (definition: IndicatorDefinition, reason: OmittedIndicator["reason"], extra = "") => {
    const detail = REASON_DETAIL[reason](definition, extra);
    omitted.push({ id: definition.id, reason, detail });
    results.push({ ...base(definition), status: "unavailable", readings: [], state: null, reason, detail, provenance: null });
  };

  for (const definition of options.definitions ?? INDICATOR_DEFINITIONS) {
    const raw = definition.inputs.map(samplesFor);
    const missing = definition.inputs.filter((_, i) => raw[i].length === 0);
    if (missing.length > 0) {
      // TVL with no curated protocol mapping is a distinct, more specific reason than a generic data gap.
      if (missing.length === 1 && missing[0] === "tvl" && !options.protocolMapped) {
        unavailable(definition, "protocol_not_mapped");
      } else {
        unavailable(definition, "missing_input", missing.join(", "));
      }
      continue;
    }
    const series = raw.length === 1 ? [contiguousTail(raw[0])] : alignSeries(raw);
    const days = series[0].length;
    if (days < definition.minPoints) {
      unavailable(definition, "insufficient_history", String(days));
      continue;
    }
    const result = definition.compute(series);
    if (!result || result.readings.some((reading) => typeof reading.value === "number" && !Number.isFinite(reading.value))) {
      unavailable(definition, "not_calculable");
      continue;
    }
    // Historical freshness (not the current-market policy): at most half the indicator's window old.
    // A stale newest sample is shown anyway, using the most recent usable data rather than hiding it.
    const ageDays = (asOf - series[0].at(-1)!.time) / DAY_MS;
    const maxAge = maxHistoryAgeDays(definition.windowDays);
    const used = result.used.flat();
    const times = used.map((point) => point.time);
    results.push({
      ...base(definition),
      status: ageDays > maxAge ? "stale" : "available",
      readings: result.readings,
      state: result.state,
      provenance: {
        providers: [...new Set(definition.inputs.map((input) => SERIES_RULES[input].providerId))],
        inputs: definition.inputs,
        sourceObservationIds: [...new Set(used.map((point) => point.obsId))].sort((a, b) => a - b),
        observationCount: new Set(used.map((point) => point.obsId)).size,
        observationStart: new Date(Math.min(...times)).toISOString(),
        observationEnd: new Date(Math.max(...times)).toISOString(),
        calculatedAt,
      },
    });
  }

  // Every category with at least one registered definition is always present — a category with
  // zero indicators calculable right now still shows its cards, each with its own unavailable state.
  const groups = INDICATOR_CATEGORIES
    .map((category) => ({ category, label: CATEGORY_LABELS[category], indicators: results.filter((indicator) => indicator.category === category) }))
    .filter((group) => group.indicators.length > 0);
  return { view: { calculatedAt, method: INDICATOR_METHOD, groups }, omitted };
}

/** Every registered indicator, grouped by category — always present, calculated or not. */
export function buildTechnicalIndicators(rows: ObservationRow[], options: IndicatorOptions): TechnicalIndicatorsView {
  return evaluateTechnicalIndicators(rows, options).view;
}

/**
 * A fully unavailable view: every registered indicator, marked unavailable with `detail`. Used when
 * the calculation pipeline itself fails (see live-data.ts), so the Technical Analysis section still
 * renders — with every card explaining why, rather than the section disappearing.
 */
export function unavailableTechnicalIndicators(calculatedAt: string, detail: string, definitions = INDICATOR_DEFINITIONS): TechnicalIndicatorsView {
  const results: TechnicalIndicator[] = definitions.map((definition) => ({
    id: definition.id, name: definition.name, category: definition.category, status: "unavailable",
    parameters: definition.parameters, periodLabel: definition.periodLabel, summary: definition.summary,
    description: definition.description, formula: definition.formula,
    readings: [], state: null, reason: "not_calculable", detail, provenance: null,
  }));
  const groups = INDICATOR_CATEGORIES
    .map((category) => ({ category, label: CATEGORY_LABELS[category], indicators: results.filter((indicator) => indicator.category === category) }))
    .filter((group) => group.indicators.length > 0);
  return { calculatedAt, method: INDICATOR_METHOD, groups };
}
