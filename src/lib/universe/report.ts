// Machine-readable and human-readable Phase A validation report (AGENTS.md
// #32). This is the input Phase B reads: which candidates are eligible, and
// exactly why the rest are not.

import type { EligibilityStatus, ReasonCode, UniverseCandidate, UniverseStatus } from "./types.ts";

export type ValidationReportCounts = {
  totalCandidates: number;
  coinGeckoValid: number;
  binanceSpotValid: number;
  bothValid: number;
  identityValid: number;
  logoValid: number;
  historicalDataValid: number;
  referenceDataValid: number;
  eligible: number;
  needsReview: number;
  temporarilyUnavailable: number;
  ineligible: number;
  duplicate: number;
  deprecated: number;
  migrated: number;
};

export type ValidationReportRow = {
  token: string;
  coingeckoId: string;
  coinGecko: "PASS" | "FAIL" | "TEMPORARY" | "UNKNOWN";
  binanceSpot: "PASS" | "FAIL" | "TEMPORARY" | "UNKNOWN";
  binancePair: string | null;
  binanceMarketStatus: string | null;
  identity: "PASS" | "FAIL";
  logo: "PASS" | "FAIL" | "TEMPORARY" | "UNKNOWN";
  history: "PASS" | "FAIL" | "TEMPORARY" | "UNKNOWN";
  supplyReference: "PASS" | "NEEDS_REVIEW" | "FAIL" | "UNKNOWN";
  eligibility: EligibilityStatus | "unchecked";
  failureReasons: ReasonCode[];
};

export type ValidationReport = {
  generatedAt: string;
  counts: ValidationReportCounts;
  reasonCounts: Partial<Record<ReasonCode, number>>;
  universeStatusCounts: Partial<Record<UniverseStatus, number>>;
  rows: ValidationReportRow[];
};

function checkLabel(status: string | null): "PASS" | "FAIL" | "TEMPORARY" | "UNKNOWN" {
  if (status === "pass") return "PASS";
  if (status === "fail") return "FAIL";
  if (status === "temporarily_unavailable") return "TEMPORARY";
  return "UNKNOWN";
}

export function buildValidationReport(candidates: UniverseCandidate[], generatedAt: string): ValidationReport {
  const counts: ValidationReportCounts = {
    totalCandidates: candidates.length,
    coinGeckoValid: candidates.filter((c) => c.coingeckoStatus === "pass").length,
    binanceSpotValid: candidates.filter((c) => c.binanceStatus === "pass").length,
    bothValid: candidates.filter((c) => c.coingeckoStatus === "pass" && c.binanceStatus === "pass").length,
    identityValid: candidates.filter((c) => c.identityStatus === "valid").length,
    logoValid: candidates.filter((c) => c.logoStatus === "pass").length,
    historicalDataValid: candidates.filter((c) => c.historicalDataStatus === "pass").length,
    referenceDataValid: candidates.filter((c) => c.supplyStatus === "pass").length,
    eligible: candidates.filter((c) => c.eligibilityStatus === "eligible").length,
    needsReview: candidates.filter((c) => c.eligibilityStatus === "needs_review").length,
    temporarilyUnavailable: candidates.filter((c) => c.eligibilityStatus === "temporarily_unavailable").length,
    ineligible: candidates.filter((c) => c.eligibilityStatus === "ineligible").length,
    duplicate: candidates.filter((c) => c.universeStatus === "duplicate").length,
    deprecated: candidates.filter((c) => c.universeStatus === "deprecated").length,
    migrated: candidates.filter((c) => c.universeStatus === "migrated").length,
  };

  const reasonCounts: Partial<Record<ReasonCode, number>> = {};
  for (const candidate of candidates) {
    for (const reason of candidate.eligibilityReasonCodes) reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
  }

  const universeStatusCounts: Partial<Record<UniverseStatus, number>> = {};
  for (const candidate of candidates) {
    universeStatusCounts[candidate.universeStatus] = (universeStatusCounts[candidate.universeStatus] ?? 0) + 1;
  }

  const rows: ValidationReportRow[] = candidates.map((candidate) => ({
    token: `${candidate.name} (${candidate.symbol})`,
    coingeckoId: candidate.coingeckoId,
    coinGecko: checkLabel(candidate.coingeckoStatus),
    binanceSpot: checkLabel(candidate.binanceStatus),
    binancePair: candidate.binanceSymbol,
    binanceMarketStatus: candidate.binanceMarketStatus,
    identity: candidate.identityStatus === "valid" ? "PASS" : "FAIL",
    logo: checkLabel(candidate.logoStatus),
    history: checkLabel(candidate.historicalDataStatus),
    supplyReference: candidate.supplyStatus === "pass" ? "PASS" : candidate.supplyStatus === "needs_review" ? "NEEDS_REVIEW" : candidate.supplyStatus === "fail" ? "FAIL" : "UNKNOWN",
    eligibility: candidate.eligibilityStatus ?? "unchecked",
    failureReasons: candidate.eligibilityReasonCodes,
  }));

  return { generatedAt, counts, reasonCounts, universeStatusCounts, rows };
}

function summaryLines(report: ValidationReport): string[] {
  const c = report.counts;
  return [
    `| Metric | Count |`,
    `| --- | --- |`,
    `| Total candidates | ${c.totalCandidates} |`,
    `| CoinGecko valid | ${c.coinGeckoValid} |`,
    `| Binance Spot valid | ${c.binanceSpotValid} |`,
    `| Both CoinGecko + Binance valid | ${c.bothValid} |`,
    `| Identity valid | ${c.identityValid} |`,
    `| Logo valid | ${c.logoValid} |`,
    `| Historical data valid | ${c.historicalDataValid} |`,
    `| Reference data valid | ${c.referenceDataValid} |`,
    `| Eligible | ${c.eligible} |`,
    `| Needs review | ${c.needsReview} |`,
    `| Temporarily unavailable | ${c.temporarilyUnavailable} |`,
    `| Ineligible | ${c.ineligible} |`,
    `| Duplicate | ${c.duplicate} |`,
    `| Deprecated | ${c.deprecated} |`,
    `| Migrated | ${c.migrated} |`,
  ];
}

/** Full markdown report; `maxRows` bounds the per-token table for very large pools (the JSON report always has every row). */
export function renderMarkdownReport(report: ValidationReport, maxRows = 500): string {
  const reasonRows = Object.entries(report.reasonCounts)
    .sort(([, a], [, b]) => (b ?? 0) - (a ?? 0))
    .map(([reason, count]) => `| ${reason} | ${count} |`);

  const tableRows = report.rows
    .slice(0, maxRows)
    .map((row) =>
      `| ${row.token} | ${row.coinGecko} | ${row.binanceSpot} | ${row.binancePair ?? "-"} | ${row.binanceMarketStatus ?? "-"} | ${row.identity} | ${row.logo} | ${row.history} | ${row.supplyReference} | ${row.eligibility} | ${row.failureReasons.join(", ") || "-"} |`,
    );

  const truncatedNote = report.rows.length > maxRows ? `\n_Showing the first ${maxRows} of ${report.rows.length} candidates; the JSON report has every row._\n` : "";

  return [
    `# Phase A candidate validation report`,
    "",
    `Generated at ${report.generatedAt}.`,
    "",
    `## Summary`,
    "",
    ...summaryLines(report),
    "",
    `## Major exclusion reasons`,
    "",
    `| Reason code | Candidates |`,
    `| --- | --- |`,
    ...(reasonRows.length > 0 ? reasonRows : ["| (none) | 0 |"]),
    "",
    `## Candidates`,
    truncatedNote,
    `| Token | CoinGecko | Binance Spot | Binance pair | Binance status | Identity | Logo | History | Supply/reference | Eligibility | Failure reasons |`,
    `| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`,
    ...tableRows,
    "",
  ].join("\n");
}
