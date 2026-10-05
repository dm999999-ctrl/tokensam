"use client";

import { useState, useTransition } from "react";
import { requestTokenAnalysis } from "@/app/tokens/[id]/actions";
import type { EngineAnalysisState } from "@/lib/analysis/deterministic-service";
import { ENGINE_SECTION_KEYS, ENGINE_SECTION_TITLES, type EngineParagraph, type EngineSectionKey, type EngineTokenAnalysis } from "@/lib/analysis/engine/report-schema";
import { buildFootnoteIndex, footnoteNumbersFor, type FootnoteIndex } from "@/lib/analysis/footnotes";
import type { PayloadField, ProfilePayload } from "@/lib/analysis/profile-payload";

function utc(value: string | null) {
  if (!value) return "unknown";
  return `${new Date(value).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC`;
}
function utcDate(value: string | null) {
  if (!value) return "unknown";
  return new Date(value).toLocaleString("en-GB", { dateStyle: "long", timeZone: "UTC" });
}

const REGIME_LABEL: Record<string, string> = { positive: "Positive", negative: "Negative", mixed: "Mixed", flat: "Flat", insufficient: "Insufficient Data" };
const CONFIDENCE_LABEL: Record<string, string> = { high: "High analytical confidence", moderate: "Moderate analytical confidence", low: "Low analytical confidence" };

function field(payload: ProfilePayload, id: string): PayloadField | undefined {
  return payload.fields.find((candidate) => candidate.id === id && candidate.status === "shown");
}

/** Compact, report-header-style identity + headline figures, reusing the exact fields the rest of the page (and the report body below) already cite -- never a separately computed number. */
function ReportHeader({ payload, analysis }: { payload: ProfilePayload; analysis: EngineTokenAnalysis }) {
  const price = field(payload, "obs:price");
  const change24h = field(payload, "obs:change_24h");
  const change7d = field(payload, "obs:change_7d");
  const marketCap = field(payload, "obs:market_cap");
  const tvl = field(payload, "obs:tvl");
  const regime = analysis.metadata.regime;
  const confidence = analysis.metadata.regimeConfidence;

  return (
    <div className="report-header">
      <div className="report-header-top">
        <div>
          <p className="report-kicker">{payload.token.name} ({payload.token.symbol}) · Investment Research Report</p>
          <p className="report-meta-line">{payload.token.chain} · {utcDate(analysis.metadata.generatedAt)} · Data as of {utc(analysis.metadata.contextAsOf)}</p>
        </div>
        {regime && (
          <div className="report-verdict">
            <span className={`report-regime report-regime-${regime}`}>{REGIME_LABEL[regime] ?? regime}</span>
            {confidence && <span className="report-confidence">{CONFIDENCE_LABEL[confidence]}</span>}
          </div>
        )}
      </div>
      <div className="report-figures">
        {price && <div className="report-figure"><strong>{price.value}</strong><span>Price</span></div>}
        {change24h && <div className="report-figure"><strong className={`tone-${change24h.raw !== null && change24h.raw > 0 ? "positive" : change24h.raw !== null && change24h.raw < 0 ? "negative" : "flat"}`}>{change24h.value}</strong><span>24H</span></div>}
        {change7d && <div className="report-figure"><strong className={`tone-${change7d.raw !== null && change7d.raw > 0 ? "positive" : change7d.raw !== null && change7d.raw < 0 ? "negative" : "flat"}`}>{change7d.value}</strong><span>7D</span></div>}
        {marketCap && <div className="report-figure"><strong>{marketCap.value}</strong><span>Market Cap</span></div>}
        {tvl && <div className="report-figure"><strong>{tvl.value}</strong><span>TVL</span></div>}
      </div>
    </div>
  );
}

type KeyFinding = { heading: string; value: string };

const KEY_FINDING_SECTIONS: { key: EngineSectionKey; heading: string }[] = [
  { key: "marketPerformance", heading: "Market" },
  { key: "fundamentalAnalysis", heading: "Fundamentals" },
  { key: "valuationAnalysis", heading: "Valuation" },
  { key: "technicalAnalysis", heading: "Technical" },
  { key: "marketStructureLiquidity", heading: "Liquidity" },
  { key: "tokenomicsSupply", heading: "Tokenomics" },
];

/** A compact label/value parsed from an evidence label already shown in Evidence & Methodology (format: "Section · Label: Value · Period") -- not a new calculation, just a terser rendering of the same cited figure. */
function parseEvidenceLabel(label: string): { heading: string; value: string } | null {
  const afterDot = label.split(" · ").slice(1).join(" · "); // drop the leading payload-section name
  const colon = afterDot.indexOf(": ");
  if (colon === -1) return null;
  return { heading: afterDot.slice(0, colon), value: afterDot.slice(colon + 2) };
}

/** The first real (non-placeholder) citation across a section's paragraphs, rendered as one compact tile -- reuses whatever evidence the section below already cites, never a separate figure. */
function buildKeyFindings(analysis: EngineTokenAnalysis): KeyFinding[] {
  const { sources } = analysis.metadata;
  const findings: KeyFinding[] = [];
  for (const { key, heading } of KEY_FINDING_SECTIONS) {
    const id = analysis[key].paragraphs.flatMap((paragraph) => paragraph.sourceIds).find((candidate) => candidate !== "token" && sources[candidate]);
    if (!id) continue;
    const parsed = parseEvidenceLabel(sources[id]);
    findings.push({ heading, value: parsed?.value ?? sources[id] });
  }
  return findings.slice(0, 8);
}

function KeyFindingsStrip({ analysis }: { analysis: EngineTokenAnalysis }) {
  const findings = buildKeyFindings(analysis);
  if (findings.length === 0) return null;
  return (
    <div className="key-findings">
      {findings.map((finding) => (
        <div key={finding.heading} className="key-finding">
          <span className="key-finding-heading">{finding.heading}</span>
          <strong className="key-finding-value">{finding.value}</strong>
        </div>
      ))}
    </div>
  );
}

const VALUATION_LABELS = ["Market Cap / TVL", "FDV / TVL", "Market Cap / 24h Revenue", "FDV / 24h Revenue", "Market Cap / 24h Fees"];

/** A compact table of the valuation ratios actually cited in Valuation Analysis -- parsed from the same evidence labels, not a separate calculation; rows for ratios this token does not have simply do not appear. */
function ValuationTable({ paragraphs, sources }: { paragraphs: EngineParagraph[]; sources: Record<string, string> }) {
  const ids = new Set(paragraphs.flatMap((paragraph) => paragraph.sourceIds));
  const rows = [...ids]
    .map((id) => (sources[id] ? parseEvidenceLabel(sources[id]) : null))
    .filter((row): row is { heading: string; value: string } => row !== null && VALUATION_LABELS.some((label) => row.heading.startsWith(label)));
  if (rows.length === 0) return null;
  return (
    <table className="valuation-table">
      <tbody>
        {rows.map((row) => <tr key={row.heading}><th scope="row">{row.heading}</th><td>{row.value}</td></tr>)}
      </tbody>
    </table>
  );
}

/** Superscript footnote markers for a paragraph's citations -- never the raw evidence ID or a human label inline; those live in the Footnotes and Evidence & Methodology sections below. */
function FootnoteMarks({ sourceIds, index }: { sourceIds: string[]; index: FootnoteIndex }) {
  const numbers = footnoteNumbersFor(sourceIds, index);
  if (numbers.length === 0) return null;
  return (
    <sup className="footnote-marks">
      {numbers.map((number, position) => (
        <a key={number} href={`#footnote-${number}`} id={`footnote-ref-${number}`}>{number}{position < numbers.length - 1 ? "," : ""}</a>
      ))}
    </sup>
  );
}

const ANALYTICAL_TYPE_LABEL: Record<string, string> = { observation: "Observation", interpretation: "Interpretation", inference: "Inference", limitation: "Limitation" };

function Paragraph({ paragraph, index, footnoteIndex }: { paragraph: EngineParagraph; index: number; footnoteIndex: FootnoteIndex }) {
  return (
    <p key={index} className="report-paragraph">
      {paragraph.analyticalType && <span className={`paragraph-tag paragraph-tag-${paragraph.analyticalType}`}>{ANALYTICAL_TYPE_LABEL[paragraph.analyticalType]}</span>}
      {paragraph.text}
      <FootnoteMarks sourceIds={paragraph.sourceIds} index={footnoteIndex} />
    </p>
  );
}

function Section({ sectionKey, section, footnoteIndex, sources }: { sectionKey: EngineSectionKey; section: { paragraphs: EngineParagraph[] }; footnoteIndex: FootnoteIndex; sources: Record<string, string> }) {
  return (
    <section className="report-section" id={`section-${sectionKey}`}>
      <h3>{ENGINE_SECTION_TITLES[sectionKey]}</h3>
      {sectionKey === "valuationAnalysis" && <ValuationTable paragraphs={section.paragraphs} sources={sources} />}
      {section.paragraphs.length === 0 ? <p className="report-empty">No content was generated for this section from the current data snapshot.</p> : (
        <div className="report-paragraphs">
          {section.paragraphs.map((paragraph, index) => <Paragraph key={index} paragraph={paragraph} index={index} footnoteIndex={footnoteIndex} />)}
        </div>
      )}
    </section>
  );
}

function FurtherResearchQuestions({ analysis, footnoteIndex }: { analysis: EngineTokenAnalysis; footnoteIndex: FootnoteIndex }) {
  return (
    <section className="report-section" id="section-furtherResearch">
      <h3>Further Research Questions</h3>
      {analysis.furtherResearchQuestions.length === 0 ? <p className="report-empty">No research questions arise from a materially significant, currently unresolved relationship in this snapshot.</p> : (
        <ol className="report-questions">
          {analysis.furtherResearchQuestions.map((item, index) => (
            <li key={index}>
              <strong>{item.question}</strong>
              <span>{item.rationale}<FootnoteMarks sourceIds={item.sourceIds} index={footnoteIndex} /></span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function Footnotes({ footnoteIndex }: { footnoteIndex: FootnoteIndex }) {
  if (footnoteIndex.footnotes.length === 0) return null;
  return (
    <section className="report-section report-footnotes" id="section-footnotes">
      <h3>Footnotes</h3>
      <ol>
        {footnoteIndex.footnotes.map((footnote) => (
          <li key={footnote.number} id={`footnote-${footnote.number}`}>
            <a href={`#footnote-ref-${footnote.number}`} aria-label={`Back to citation ${footnote.number}`}>{footnote.number}</a> {footnote.text}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Every evidence object the report drew on, grouped by the section it was cited in -- the raw, auditable data the report's prose summarizes, collapsed by default so it supports the report rather than dominating it. */
function EvidenceMethodology({ analysis, payload }: { analysis: EngineTokenAnalysis; payload: ProfilePayload }) {
  const { sources } = analysis.metadata;
  const ids = Object.keys(sources).sort();
  return (
    <details className="evidence-methodology">
      <summary>Evidence &amp; Methodology ({ids.length} cited {ids.length === 1 ? "record" : "records"})</summary>
      <div className="evidence-methodology-body">
        <p className="report-empty">
          Every number and named period in this report is copied directly from one of these stored evidence records -- the same data the Token Profile page itself displays (see &quot;Copy data&quot;). Report version {analysis.metadata.engineVersion ?? "—"} (engine) / {analysis.metadata.analysisVersion ?? "—"} (report structure). Context hash {analysis.metadata.contextHash.slice(0, 12)}.
        </p>
        <ul className="evidence-list">
          {ids.map((id) => <li key={id}><code>{id}</code><span>{sources[id]}</span></li>)}
        </ul>
        {payload.scope.length > 0 && (
          <>
            <h4>Provider coverage</h4>
            <ul className="evidence-list">
              {payload.scope.map((note) => <li key={note.id}><code>{note.provider}</code><span>{note.statement}</span></li>)}
            </ul>
          </>
        )}
      </div>
    </details>
  );
}

function AnalysisBody({ analysis, payload }: { analysis: EngineTokenAnalysis; payload: ProfilePayload }) {
  const footnoteIndex = buildFootnoteIndex(analysis);
  return (
    <div className="report-body">
      <ReportHeader payload={payload} analysis={analysis} />
      <KeyFindingsStrip analysis={analysis} />
      {ENGINE_SECTION_KEYS.map((key) => (
        <Section key={key} sectionKey={key} section={analysis[key]} footnoteIndex={footnoteIndex} sources={analysis.metadata.sources} />
      ))}
      <FurtherResearchQuestions analysis={analysis} footnoteIndex={footnoteIndex} />
      <Footnotes footnoteIndex={footnoteIndex} />
      <EvidenceMethodology analysis={analysis} payload={payload} />
    </div>
  );
}

export function deepAnalysisButtonHint(state: EngineAnalysisState): string {
  if (state.status !== "ready") return "Unavailable";
  return state.latest ? `Generated ${utc(state.latest.metadata.generatedAt)}` : `${state.model} · generate on request`;
}

export function DeepAnalysisPanel({ tokenId, initialState, hidden, payload }: { tokenId: string; initialState: EngineAnalysisState; hidden: boolean; payload: ProfilePayload }) {
  const [state, setState] = useState(initialState);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const generate = () => {
    setError(null);
    startTransition(async () => {
      const result = await requestTokenAnalysis(tokenId);
      if (result.ok) {
        setState((current) => current.status === "ready" ? { ...current, latest: result.analysis, nextAllowedAt: result.nextAllowedAt } : current);
      } else {
        setError(result.message);
        if (result.nextAllowedAt && state.status === "ready") setState({ ...state, nextAllowedAt: result.nextAllowedAt });
      }
    });
  };

  const latest = state.status === "ready" ? state.latest : null;
  // The server reports nextAllowedAt only while a cooldown is active (and enforces it again on request).
  const coolingDown = state.status === "ready" && state.nextAllowedAt !== null;

  return (
    <section className="ai-panel" id="deep-ai-analysis" aria-labelledby="deep-ai-title" hidden={hidden}>
      <header className="section-head ai-head">
        <div><p className="eyebrow">Research report · institutional-style analysis</p><h2 id="deep-ai-title">Deep AI Analysis</h2></div>
      </header>
      <p className="ai-disclaimer">
        A deterministic reading of this profile&apos;s stored evidence only — no AI provider is called, and every figure and named period in the text is copied from the same evidence cited beside it.
        It is not investment advice and makes no price predictions or forecasts.
      </p>

      {state.status !== "ready" ? (
        <div className="ai-state" role="status"><strong>AI analysis unavailable</strong><p>{state.message}</p></div>
      ) : (
        <>
          <div className="ai-toolbar">
            {latest ? (
              <dl className="ai-meta">
                <div><dt>Generated</dt><dd>{utc(latest.metadata.generatedAt)}</dd></div>
                <div><dt>Data as of</dt><dd>{utc(latest.metadata.contextAsOf)}</dd></div>
                <div><dt>Model</dt><dd>{latest.metadata.provider}</dd></div>
                {latest.metadata.engineVersion && <div><dt>Engine</dt><dd>v{latest.metadata.engineVersion} · analysis v{latest.metadata.analysisVersion}</dd></div>}
                <div><dt>Prompt / schema</dt><dd>v{latest.metadata.promptVersion} / v{latest.metadata.schemaVersion}</dd></div>
              </dl>
            ) : <p className="ai-empty">No analysis has been generated for this token yet. Generation uses the current stored evidence and runs only when requested.</p>}
            <button className="ai-generate-button" type="button" onClick={generate} disabled={pending || coolingDown}>
              {pending ? "Generating…" : latest ? "Regenerate analysis" : "Generate analysis"}
            </button>
          </div>
          {coolingDown && !pending && <p className="ai-note">Regeneration is available after {utc(state.nextAllowedAt)}.</p>}
          {pending && <div className="ai-state" role="status"><strong>Generating analysis…</strong><p>Building the report from the current data snapshot. This is a local computation and typically finishes in under a second.</p></div>}
          {error && !pending && <div className="ai-state error" role="alert"><strong>Analysis not updated</strong><p>{error}</p></div>}
          {latest && <AnalysisBody analysis={latest} payload={payload} />}
        </>
      )}
    </section>
  );
}
