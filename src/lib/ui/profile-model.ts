import type { LiveTokenProfileData, CalculatedMetricView } from "../../types/token.ts";
import type { HistoryChartKey } from "../../types/historical-data.ts";
import type { TechnicalIndicator, TechnicalIndicatorGroup } from "../../types/technical-indicators.ts";
import type { CoverageReason, ProviderCoverage } from "../../data/provider-coverage.ts";
import { metricLabel, metricSection, presentMetric, type MetricDisplay } from "./calculated.ts";
import { formatChange, formatCount, formatShare, formatSupply, formatUsd, horizonLabel, isValidNumber, type Horizon, type Interval, type Tone } from "./format.ts";
import { TECHNICAL_PROVENANCE, datasetLabel, plainLanguage } from "./data-language.ts";

/**
 * Token Profile view model. Builds only what has valid data: a metric with
 * no valid value is omitted (a numeric zero is valid), and a section with
 * nothing meaningful becomes a single contextual note. Each section holds
 * one data scope — token, protocol, or market — and never mixes them.
 */

export type Card = { id: string; label: string; value: string; tone: Tone; note?: string; title?: string; interval?: Interval | null };
export type SectionNote = { title: string; reason: string };
/** Circulating vs maximum supply. `barPct` is clamped to 0–100 for drawing; `circulatingPct` is the actual ratio. */
export type SupplyComposition = { circulatingPct: number; remainingPct: number; barPct: number; circulating: string; maximum: string; symbol: string };
export type SectionId =
  | "overview" | "market" | "fundamentals" | "tokenomics" | "market-structure" | "history" | "technical" | "analysis" | "sources";

export type ProfileModel = {
  snapshot: { cards: Card[]; changes: Card[] };
  /** Historical Signals: token-scope market series, plus the associated protocol's TVL series (kept separate by scope). */
  history: { available: true; series: HistoryChartKey[]; tvl: boolean } | { available: false; note: SectionNote };
  fundamentals:
    | { available: true; protocolName: string; scopeLine: string; primary: Card[]; valuation: Card[]; changes: Card[] }
    | { available: false; note: SectionNote };
  marketStructure: { available: true; scopeLine: string; cards: Card[] } | { available: false; note: SectionNote };
  tokenomics: { available: true; items: Card[]; circulatingOfMaxPct: number | null; composition: SupplyComposition | null } | { available: false; note: SectionNote };
  /** Technical indicator categories (price action, volume, on-chain); cross-metric groups live in `divergence`. */
  technical: TechnicalIndicatorGroup[];
  /**
   * Cross-metric divergence: stored cross-scope comparisons and divergence flags from the metrics engine,
   * and the 30-day relationships from the indicator layer. Rendered only when at least one exists.
   */
  divergence: { comparisons: Card[]; signals: Card[]; signalsHorizon: Horizon | null; indicators: TechnicalIndicator[] };
  sections: { id: SectionId; label: string }[];
  methodology: Methodology;
};

/**
 * Visible methodology is deliberately short. Unavailable/invalid metrics stay
 * in `calculatedMetrics` (status and stored reason) for integrity, debugging,
 * and AI evidence, but are not listed here: a metric that cannot be computed
 * is simply not shown. External provider names live only in `provenance`.
 */
export type Methodology = {
  /** This token's own latest collection per displayed dataset (never a global or page-load time). */
  freshness: { kind: "observation" | "calculation"; label: string; ageLabel: string; state: "current" | "stale" | null; collectedAt: string; observedAt: string | null }[];
  /** Associated protocol name when protocol data is shown (scope reminder). */
  protocolName: string | null;
  referencePrice: { value: string; observedAt: string } | null;
  /** Formulas in scope language; the stored backend text is unchanged. */
  formulas: { label: string; formula: string }[];
  /** Canonical token identity only (chain, contract or mint); never provider-specific IDs or slugs. */
  identifiers: { label: string; value: string; note: string | null }[];
  /** Data provenance: the external service behind each dataset (rendered), and raw collection notes kept for audit (not rendered). */
  provenance: { datasets: { dataset: string; provider: string }[]; notes: string[] };
};

// Price, trading activity, and the risk profile (volatility and drawdown derived from the price series).
const MARKET_HISTORY: HistoryChartKey[] = ["priceUsd", "volumeUsd", "riskProfile"];

function card(id: string, label: string, value: string | null, extra: Partial<Card> = {}): Card | null {
  return value === null ? null : { id, label, value, tone: "neutral", ...extra };
}

/** Changes always carry their actual interval; short ones are labelled as snapshot changes, not trends. */
function intervalNote(display: MetricDisplay): string | undefined {
  if (!display.interval) return undefined;
  if (display.kind === "flag") return `Evaluated ${display.interval.label}${display.interval.isShort ? " (snapshot interval, not a trend)" : ""}`;
  if (display.kind === "change" || display.kind === "points") return `${display.interval.isShort ? "Snapshot change " : ""}${display.interval.label}`;
  return undefined;
}

function fromMetric(display: MetricDisplay): Card {
  const note = intervalNote(display);
  return { id: display.id, label: display.label, value: display.value, tone: display.tone, note, title: display.interval?.range, interval: display.interval };
}

const present = <T>(items: (T | null)[]): T[] => items.filter((item): item is T => item !== null);

/** Stored metrics comparing two datasets (e.g. price change vs TVL growth, in percentage points). */
const isComparison = (id: string) => id.includes("_vs_");

/** One concise reason per unavailable DEX mapping, from the curated reason code (no wrapped substitution). */
function dexReason(reason: CoverageReason | null, isNative: boolean): string {
  if (reason === "wrapped_representation_only") return "Native asset has no canonical token address; wrapped assets are not substituted.";
  if (reason === "no_provider_data") return "No on-chain DEX market was found for this asset's canonical token identifier; wrapped assets are not substituted.";
  if (reason === "native_asset_lacks_provider_identifier" || isNative) return "No canonical token market is currently available for this native asset; wrapped assets are not substituted.";
  return "No canonical token market is currently available for this asset.";
}

export function buildProfileModel(data: LiveTokenProfileData): ProfileModel {
  const { token, calculatedMetrics } = data;
  const coverageFor = (provider: ProviderCoverage["provider"]) => data.coverage.find((item) => item.provider === provider);
  const protocolMapped = coverageFor("defillama")?.status === "mapped" && data.protocol !== null;
  const dexCoverage = coverageFor("dexscreener");
  const dexMapped = dexCoverage?.status === "mapped";
  const displays = new Map(present(calculatedMetrics.map(presentMetric)).map((display) => [display.id, display]));
  const metric = (id: string) => displays.get(id);
  const inSection = (section: ReturnType<typeof metricSection>, category: CalculatedMetricView["category"]) =>
    calculatedMetrics.filter((item) => item.category === category && metricSection(item) === section)
      .map((item) => displays.get(item.id)).filter((item): item is MetricDisplay => item !== undefined).map(fromMetric);

  // A. Market snapshot: token scope only.
  const volumeToMcap = metric("volume_to_market_cap");
  const snapshot = {
    cards: present([
      card("market_cap", "Market cap", formatUsd(token.marketCapUsd, true)),
      card("volume_24h", "Volume · 24h", formatUsd(token.volume24hUsd, true)),
      volumeToMcap ? fromMetric(volumeToMcap) : null,
    ]),
    changes: inSection("market", "growth"),
  };

  // B. Market history: token-scope series with at least one stored point; protocol TVL only with a curated mapping.
  const historySeries = MARKET_HISTORY.filter((key) => data.history[key === "riskProfile" ? "priceUsd" : key].points.length > 0);
  const tvlHistory = protocolMapped && data.history.tvlUsd.points.length > 0;
  const history: ProfileModel["history"] = historySeries.length > 0 || tvlHistory
    ? { available: true, series: historySeries, tvl: tvlHistory }
    : { available: false, note: { title: "Market history", reason: "No stored market observations fall within the last 90 days." } };

  // C. Fundamentals: protocol scope, only with a curated protocol association and stored data.
  let fundamentals: ProfileModel["fundamentals"];
  if (!protocolMapped) {
    fundamentals = {
      available: false,
      note: {
        title: "Protocol fundamentals",
        reason: data.isNative
          ? "No associated protocol is mapped to this native asset. Chain-level TVL is not attributed to the token."
          : "No associated protocol is mapped to this token.",
      },
    };
  } else {
    const tvlChange = formatChange(token.tvlChange30dPct);
    const primary = present([
      card("tvl", "TVL", formatUsd(token.tvlUsd, true), { note: "Associated protocol" }),
      tvlChange ? { id: "tvl_30d", label: "TVL change · 30D", value: tvlChange.text, tone: tvlChange.tone, note: "Observations ~30 days apart" } : null,
      card("fees_24h", "Fees · 24h", formatUsd(token.fees24hUsd, true)),
      card("revenue_24h", "Revenue · 24h", formatUsd(token.revenue24hUsd, true)),
    ]);
    const valuation = inSection("fundamentals", "valuation");
    // Token-vs-protocol comparisons (percentage points) belong to Cross-Metric Divergence, not here.
    const changes = inSection("fundamentals", "growth").filter((item) => !isComparison(item.id));
    const protocol = data.protocol!;
    fundamentals = primary.length + valuation.length + changes.length > 0
      ? {
        available: true,
        protocolName: protocol.name,
        scopeLine: `Describes the associated protocol, not the token itself${protocol.aggregatesVersions ? ` · covers every ${protocol.name} version` : ""}.`,
        primary, valuation, changes,
      }
      : { available: false, note: { title: "Protocol fundamentals", reason: `No protocol fundamentals are stored yet for the associated protocol (${protocol.name}).` } };
  }

  // D. Market structure: market scope, exact-address DEX pairs only.
  let marketStructure: ProfileModel["marketStructure"];
  if (!dexMapped) {
    marketStructure = { available: false, note: { title: "DEX markets", reason: dexReason(dexCoverage?.reason ?? null, data.isNative) } };
  } else {
    const { transactions24h, buys24h, sells24h } = data.dexActivity;
    const counts = [formatCount(buys24h) && `${formatCount(buys24h)} buys`, formatCount(sells24h) && `${formatCount(sells24h)} sells`].filter(Boolean).join(" · ");
    const aggregateLiquidity = metric("dex_aggregate_liquidity_usd");
    const primaryLiquidity = metric("dex_primary_pair_liquidity_usd");
    const aggregateVolume = metric("dex_aggregate_volume_24h_usd");
    const primaryVolume = metric("dex_primary_pair_volume_24h_usd");
    // Primary-pair values only add information when more than one pair is aggregated.
    const distinct = (primary: MetricDisplay | undefined, aggregate: MetricDisplay | undefined) =>
      primary && (!aggregate || primary.value !== aggregate.value) ? fromMetric(primary) : null;
    const primaryShare = metric("dex_liquidity_to_market_cap_pct");
    const aggregateShare = metric("dex_aggregate_liquidity_to_market_cap_pct");
    const cards = present([
      aggregateLiquidity ? { ...fromMetric(aggregateLiquidity), note: "On-chain DEX markets" } : null,
      aggregateVolume ? fromMetric(aggregateVolume) : null,
      metric("dex_volume_to_liquidity") ? fromMetric(metric("dex_volume_to_liquidity")!) : null,
      card("transactions_24h", "Transactions · 24h", formatCount(transactions24h), counts ? { note: counts } : {}),
      metric("dex_buy_sell_ratio") ? fromMetric(metric("dex_buy_sell_ratio")!) : null,
      aggregateShare ? fromMetric(aggregateShare) : null,
      distinct(primaryLiquidity, aggregateLiquidity),
      distinct(primaryVolume, aggregateVolume),
      distinct(primaryShare, aggregateShare),
    ]);
    marketStructure = cards.length > 0
      ? { available: true, scopeLine: "On-chain DEX pairs for this exact token address; centralised exchanges excluded.", cards }
      : { available: false, note: { title: "DEX markets", reason: "No exact-address DEX market data is currently stored for this token." } };
  }

  // E. Tokenomics: token-scope supply; a missing maximum is hidden, never labelled "uncapped".
  const supply = (value: number | null) => formatSupply(value) === null ? null : `${formatSupply(value)} ${token.symbol}`;
  // FDV is the token-level value reported in the stored market-data record, never derived here or taken from DEX data.
  const fdv = isValidNumber(token.fdvUsd) && token.fdvUsd > 0 ? token.fdvUsd : null;
  const mcapOfFdv = fdv !== null && isValidNumber(token.marketCapUsd) && token.marketCapUsd > 0 ? (token.marketCapUsd / fdv) * 100 : null;
  const items = present([
    card("circulating_supply", "Circulating supply", supply(data.circulatingSupply)),
    card("total_supply", "Total supply", supply(data.totalSupply)),
    card("maximum_supply", "Maximum supply", supply(data.maximumSupply)),
    card("fdv", "Fully diluted valuation", formatUsd(fdv, true), { note: "As reported with market data" }),
    card("market_cap_of_fdv", "Market cap / FDV", mcapOfFdv === null ? null : formatShare(mcapOfFdv), { note: "Share of fully diluted value already circulating" }),
  ]);
  const circulatingOfMaxPct = isValidNumber(data.circulatingSupply) && isValidNumber(data.maximumSupply) && data.maximumSupply > 0
    ? (data.circulatingSupply / data.maximumSupply) * 100
    : null;
  // Supply composition: shown only when both figures exist (a missing maximum is never treated as zero).
  const composition: SupplyComposition | null = circulatingOfMaxPct === null ? null : {
    circulatingPct: circulatingOfMaxPct,
    remainingPct: Math.max(0, 100 - circulatingOfMaxPct),
    barPct: Math.min(100, Math.max(0, circulatingOfMaxPct)),
    circulating: formatSupply(data.circulatingSupply)!,
    maximum: formatSupply(data.maximumSupply)!,
    symbol: token.symbol,
  };
  const tokenomics: ProfileModel["tokenomics"] = items.length > 0
    ? { available: true, items, circulatingOfMaxPct, composition }
    : { available: false, note: { title: "Tokenomics", reason: "No supply figures are reported for this token." } };

  // F. Technical indicators and G. cross-metric divergence. Availability is decided server-side; this only places groups.
  const groups = data.technicalIndicators?.groups ?? [];
  const technical = groups.filter((group) => group.category !== "divergence");
  // Stored comparisons and flags cover the metrics engine's actual interval (often hours): their horizon
  // comes from that interval, so a short one reads "Snapshot" and is never labelled 7D or 30D.
  const withHorizon = (item: Card): Card => ({
    ...item,
    label: `${item.label} · ${horizonLabel(item.interval?.hours)}`,
    note: item.interval ? `Measured ${item.interval.label}` : item.note,
  });
  const signals = protocolMapped ? inSection("fundamentals", "divergence") : [];
  const divergence: ProfileModel["divergence"] = {
    comparisons: protocolMapped ? inSection("fundamentals", "growth").filter((item) => isComparison(item.id)).map(withHorizon) : [],
    signals,
    signalsHorizon: signals.length > 0 ? horizonLabel(signals.find((item) => item.interval)?.interval?.hours) : null,
    // Cross-metric analysis stays "shown only when there's real content" (unlike the persistent
    // Technical section above): an indicator the engine couldn't calculate is not cross-metric content.
    indicators: (groups.find((group) => group.category === "divergence")?.indicators ?? []).filter((indicator) => indicator.status !== "unavailable"),
  };

  // Research order: overview → market → fundamentals → tokenomics → market structure → history (evidence)
  // → technical (derived from it, with cross-metric analysis inside) → AI → sources. Sections without
  // data are omitted — except Technical, which is persistent: data availability only ever changes an
  // indicator's own state, never whether the section (or its nav entry) appears.
  const sections: ProfileModel["sections"] = [
    { id: "overview", label: "Overview" },
    { id: "market", label: "Market" },
    ...(fundamentals.available ? [{ id: "fundamentals" as const, label: "Fundamentals" }] : []),
    ...(tokenomics.available ? [{ id: "tokenomics" as const, label: "Tokenomics" }] : []),
    ...(marketStructure.available ? [{ id: "market-structure" as const, label: "Market Structure" }] : []),
    ...(history.available ? [{ id: "history" as const, label: "History" }] : []),
    { id: "technical" as const, label: "Technical" },
    { id: "analysis", label: "AI Analysis" },
    { id: "sources", label: "Sources" },
  ];

  return { snapshot, history, fundamentals, marketStructure, tokenomics, technical, divergence, sections, methodology: buildMethodology(data, { protocolMapped, dexMapped }) };
}

function buildMethodology(data: LiveTokenProfileData, mapped: { protocolMapped: boolean; dexMapped: boolean }): Methodology {
  const available = data.calculatedMetrics.filter((item) => item.status === "available" && isValidNumber(item.value));
  const freshness = (data.datasetFreshness ?? [])
    // Defensive: never show a dataset whose section is not shown for this token.
    .filter((item) => (item.id !== "defillama" || mapped.protocolMapped) && (item.id !== "dexscreener" || mapped.dexMapped))
    .map((item) => ({ kind: item.id === "metrics" ? "calculation" as const : "observation" as const, label: datasetLabel(item.id, item.label), ageLabel: item.ageLabel, state: item.state, collectedAt: item.collectedAt, observedAt: item.observedAt }));

  const identifiers = [
    { label: "Chain", value: data.token.chain, note: null },
    { label: "Contract / mint", value: data.isNative ? "Native asset — no contract" : data.contractAddress ?? "Not recorded", note: null },
  ];

  return {
    freshness,
    protocolName: mapped.protocolMapped && data.protocol ? data.protocol.name : null,
    referencePrice: data.tokenLevelPrice ? { value: formatUsd(data.tokenLevelPrice.value) ?? "", observedAt: data.tokenLevelPrice.observedAt } : null,
    formulas: available.map((item) => ({ label: metricLabel(item), formula: plainLanguage(item.formula) })),
    identifiers,
    provenance: { datasets: TECHNICAL_PROVENANCE, notes: data.dataNotes },
  };
}
