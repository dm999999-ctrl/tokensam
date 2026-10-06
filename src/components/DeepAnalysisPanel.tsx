"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { requestTokenAnalysis } from "@/app/tokens/[id]/actions";
import { ENGINE_SECTION_KEYS, ENGINE_SECTION_TITLES, type EngineParagraph, type EngineSectionKey, type EngineTokenAnalysis } from "@/lib/analysis/engine/report-schema";
import { buildFootnoteIndex, footnoteNumbersFor, type FootnoteIndex } from "@/lib/analysis/footnotes";
import type { ProfilePayload } from "@/lib/analysis/profile-payload";

function utc(value: string | null) {
  if (!value) return "unknown";
  return `${new Date(value).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC`;
}
/**
 * Plain identity header, matching the same "TOKEN SAMURAI — NAME / Token / Chain / Category /
 * Contract / Data as of" block the page's own "Copy data" export uses (formatProfilePayloadText in
 * profile-payload.ts) -- one canonical header format for this token's data, not a separate one
 * invented for the panel.
 */
function ReportHeader({ payload, analysis }: { payload: ProfilePayload; analysis: EngineTokenAnalysis }) {
  const { token } = payload;
  return (
    <div className="report-header">
      <p className="report-kicker">Token Samurai — {token.name.toUpperCase()}</p>
      <p className="report-subtitle">Deep AI Research Report</p>
      <dl className="report-identity">
        <div><dt>Token</dt><dd>{token.name} ({token.symbol})</dd></div>
        <div><dt>Chain</dt><dd>{token.chain}</dd></div>
        <div><dt>Category</dt><dd>{token.category}</dd></div>
        <div><dt>Contract</dt><dd>{token.isNative ? "Native asset — no contract" : token.contractAddress ?? "Not recorded"}</dd></div>
        <div><dt>Data as of</dt><dd>{utc(analysis.metadata.contextAsOf)}</dd></div>
      </dl>
    </div>
  );
}

/** A compact label/value parsed from an evidence label (format: "Section · Label: Value · Period") -- not a new calculation, just a terser rendering of the same cited figure. */
function parseEvidenceLabel(label: string): { heading: string; value: string } | null {
  const afterDot = label.split(" · ").slice(1).join(" · "); // drop the leading payload-section name
  const colon = afterDot.indexOf(": ");
  if (colon === -1) return null;
  return { heading: afterDot.slice(0, colon), value: afterDot.slice(colon + 2) };
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

function Paragraph({ paragraph, index, footnoteIndex }: { paragraph: EngineParagraph; index: number; footnoteIndex: FootnoteIndex }) {
  return (
    <p key={index} className="report-paragraph">
      {paragraph.text}
      <FootnoteMarks sourceIds={paragraph.sourceIds} index={footnoteIndex} />
    </p>
  );
}

/**
 * Sections that only ever have substantive content when the token actually has evidence for that
 * domain -- when none exists, the engine still returns one placeholder paragraph citing only the
 * bare "token" identity marker (never a real evidence ID; see e.g. fundamentalAnalysisSection's
 * "no associated protocol is mapped" fallback in narrative.ts), so the report doesn't render an
 * empty-looking section for a domain this token genuinely has nothing to say about. The limitation
 * itself is not lost: when material, it's still cited in the Executive Assessment / Final
 * Conclusion's own domain-synthesis clauses (see narrative.ts's fundamentalsSynthesisClause and
 * siblings) and, if it affects analytical coverage/interpretation/confidence, in Data Quality &
 * Analytical Limitations (also hidable when empty -- see below) -- this only controls whether the
 * standalone section with nothing to analyze gets a heading of its own. Market Performance,
 * Cross-Domain Analysis, and Key Investment Risks always render: every token has price evidence,
 * and the other two already degrade gracefully to a substantive "could not be established" reading
 * rather than a bare placeholder. Technical Analysis is hidable too: when the Token Profile has no
 * technical-indicator data at all, there is nothing to render, and narrative.ts folds that gap into
 * Data Quality instead (see findings.ts's "no_technical_indicators").
 */
const HIDABLE_WHEN_EMPTY = new Set<EngineSectionKey>(["fundamentalAnalysis", "valuationAnalysis", "marketStructureLiquidity", "tokenomicsSupply", "technicalAnalysis", "dataQualityLimitations"]);

/** True when a section's only content is the engine's own no-evidence placeholder (sourceIds === ["token"], the same signal report.ts's classifyParagraphs already uses to mark a paragraph as an ungrounded placeholder). */
export function isEmptySection(section: { paragraphs: EngineParagraph[] }): boolean {
  return section.paragraphs.every((paragraph) => paragraph.sourceIds.length === 1 && paragraph.sourceIds[0] === "token");
}

export function visibleSectionKeys(analysis: EngineTokenAnalysis): EngineSectionKey[] {
  return ENGINE_SECTION_KEYS.filter((key) => key === "executiveAssessment" || !HIDABLE_WHEN_EMPTY.has(key) || !isEmptySection(analysis[key]));
}

function Section({ sectionKey, section, number, footnoteIndex, sources }: { sectionKey: EngineSectionKey; section: { paragraphs: EngineParagraph[] }; number: number; footnoteIndex: FootnoteIndex; sources: Record<string, string> }) {
  return (
    <section className="report-section" id={`section-${sectionKey}`}>
      <h3>{number >= 0 ? `${number + 1}. ` : ""}{ENGINE_SECTION_TITLES[sectionKey]}</h3>
      {sectionKey === "valuationAnalysis" && <ValuationTable paragraphs={section.paragraphs} sources={sources} />}
      {section.paragraphs.length === 0 ? <p className="report-empty">No content was generated for this section from the current data snapshot.</p> : (
        <div className="report-paragraphs">
          {section.paragraphs.map((paragraph, index) => <Paragraph key={index} paragraph={paragraph} index={index} footnoteIndex={footnoteIndex} />)}
        </div>
      )}
    </section>
  );
}

function FurtherResearchQuestions({ analysis, footnoteIndex, number }: { analysis: EngineTokenAnalysis; footnoteIndex: FootnoteIndex; number: number }) {
  return (
    <section className="report-section" id="section-furtherResearch">
      <h3>{number}. Further Research Questions</h3>
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
  // Numbered sequentially over only the sections that actually render (see visibleSectionKeys),
  // so hiding an empty domain never leaves a gap like "3. Technical Analysis" jumping to "5. ...".
  const visibleKeys = visibleSectionKeys(analysis);
  const numberedKeys: EngineSectionKey[] = visibleKeys.filter((key) => key !== "executiveAssessment");
  return (
    <div className="report-body">
      <ReportHeader payload={payload} analysis={analysis} />
      {visibleKeys.map((key) => (
        <Section key={key} sectionKey={key} section={analysis[key]} number={numberedKeys.indexOf(key)} footnoteIndex={footnoteIndex} sources={analysis.metadata.sources} />
      ))}
      <FurtherResearchQuestions analysis={analysis} footnoteIndex={footnoteIndex} number={numberedKeys.length + 1} />
      <Footnotes footnoteIndex={footnoteIndex} />
      <EvidenceMethodology analysis={analysis} payload={payload} />
    </div>
  );
}

/**
 * One unit of text the typewriter reveals progressively: a section heading or one paragraph's
 * text, flattened in the exact same order AnalysisBody renders them (same visibleSectionKeys/
 * numberedKeys derivation) so the typed sequence matches the final report precisely. Only plain
 * text is typed -- footnote marks, the valuation table, Footnotes, and Evidence & Methodology are
 * supplementary apparatus around the prose, not the prose itself, so they appear instantly once
 * typing finishes rather than being animated piece by piece.
 */
type TypingUnit = { kind: "heading"; text: string } | { kind: "paragraph"; text: string };

function buildTypingUnits(analysis: EngineTokenAnalysis): TypingUnit[] {
  const visibleKeys = visibleSectionKeys(analysis);
  const numberedKeys: EngineSectionKey[] = visibleKeys.filter((key) => key !== "executiveAssessment");
  const units: TypingUnit[] = [];
  for (const key of visibleKeys) {
    const number = numberedKeys.indexOf(key);
    units.push({ kind: "heading", text: `${number >= 0 ? `${number + 1}. ` : ""}${ENGINE_SECTION_TITLES[key]}` });
    const section = analysis[key];
    if (section.paragraphs.length === 0) {
      units.push({ kind: "paragraph", text: "No content was generated for this section from the current data snapshot." });
    } else {
      for (const paragraph of section.paragraphs) units.push({ kind: "paragraph", text: paragraph.text });
    }
  }
  units.push({ kind: "heading", text: `${numberedKeys.length + 1}. Further Research Questions` });
  if (analysis.furtherResearchQuestions.length === 0) {
    units.push({ kind: "paragraph", text: "No research questions arise from a materially significant, currently unresolved relationship in this snapshot." });
  } else {
    for (const item of analysis.furtherResearchQuestions) {
      units.push({ kind: "paragraph", text: item.question });
      units.push({ kind: "paragraph", text: item.rationale });
    }
  }
  return units;
}

const TYPING_CHARS_PER_TICK = 3;
const TYPING_TICK_MS = 10;

function TypingReport({ units, unitIndex, charIndex }: { units: TypingUnit[]; unitIndex: number; charIndex: number }) {
  const current = unitIndex < units.length ? units[unitIndex] : null;
  return (
    <div className="report-body report-typing">
      {units.slice(0, unitIndex).map((unit, index) => (
        unit.kind === "heading" ? <h3 key={index}>{unit.text}</h3> : <p key={index} className="report-paragraph">{unit.text}</p>
      ))}
      {current && (
        current.kind === "heading"
          ? <h3>{current.text.slice(0, charIndex)}<span className="typing-caret" aria-hidden="true" /></h3>
          : <p className="report-paragraph">{current.text.slice(0, charIndex)}<span className="typing-caret" aria-hidden="true" /></p>
      )}
    </div>
  );
}

type GenerationStatus = "idle" | "pending" | "typing" | "done" | "error";

/**
 * Stateless, per-visitor generation: each call to requestTokenAnalysis recomputes the report fresh
 * from the current live data and returns it straight to this component's own local state -- nothing
 * is persisted server-side, so a report generated here is never visible to another visitor of the
 * same token page, and a page refresh clears it (generating again produces a fresh computation, not
 * a cached one). `autoGenerateSignal` is incremented by the header's own "Generate AI Research
 * Report" art button (see TokenProfile.tsx); any change to it past the initial mount starts a fresh
 * generation here even if a report is already showing, so the header button always works regardless
 * of this panel's current state.
 */
export function DeepAnalysisPanel({ tokenId, payload, autoGenerateSignal, onBackToOverview }: { tokenId: string; payload: ProfilePayload; autoGenerateSignal: number; onBackToOverview: () => void }) {
  const [status, setStatus] = useState<GenerationStatus>("idle");
  const [analysis, setAnalysis] = useState<EngineTokenAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [units, setUnits] = useState<TypingUnit[]>([]);
  const [unitIndex, setUnitIndex] = useState(0);
  const [charIndex, setCharIndex] = useState(0);
  const pendingRef = useRef(false);

  const generate = useCallback(() => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setStatus("pending");
    setError(null);
    (async () => {
      try {
        const result = await requestTokenAnalysis(tokenId);
        if (result.ok) {
          setAnalysis(result.analysis);
          setUnits(buildTypingUnits(result.analysis));
          setUnitIndex(0);
          setCharIndex(0);
          setStatus("typing");
        } else {
          setError(result.message);
          setStatus("error");
        }
      } catch {
        setError("The AI report could not be generated. Please try again later.");
        setStatus("error");
      } finally {
        pendingRef.current = false;
      }
    })();
  }, [tokenId]);

  const lastSignal = useRef(autoGenerateSignal);
  useEffect(() => {
    if (autoGenerateSignal === lastSignal.current) return;
    lastSignal.current = autoGenerateSignal;
    generate();
  }, [autoGenerateSignal, generate]);

  // Typewriter: a few characters per tick, paused whenever status leaves "typing" (e.g. a fresh
  // generate() call resets status to "pending" first, which this effect no-ops on).
  useEffect(() => {
    if (status !== "typing") return;
    const timer = setTimeout(() => {
      if (unitIndex >= units.length) { setStatus("done"); return; }
      const unit = units[unitIndex];
      if (charIndex >= unit.text.length) {
        setUnitIndex((index) => index + 1);
        setCharIndex(0);
      } else {
        setCharIndex((count) => Math.min(unit.text.length, count + TYPING_CHARS_PER_TICK));
      }
    }, TYPING_TICK_MS);
    return () => clearTimeout(timer);
  }, [status, unitIndex, charIndex, units]);

  return (
    <section className="ai-panel" id="deep-ai-analysis" aria-labelledby="deep-ai-title">
      <header className="section-head ai-head">
        <div><p className="eyebrow">Research report · institutional-style analysis</p><h2 id="deep-ai-title">Deep AI Analysis</h2></div>
      </header>

      {status === "idle" && (
        <div className="analysis-invite">
          <div>
            <p className="muted-copy">An evidence-labelled reading of this profile&apos;s current data, generated fresh for you on request. Not investment advice.</p>
          </div>
          <button className="blade-button" type="button" onClick={generate}>
            <span className="blade-copy"><strong>Generate AI Research Report</strong></span>
            <span className="blade-edge" aria-hidden="true" />
          </button>
        </div>
      )}

      {status === "error" && (
        <div className="ai-state error" role="alert">
          <strong>Analysis not generated</strong>
          <p>{error}</p>
          <button className="ai-generate-button" type="button" onClick={generate}>Try again</button>
        </div>
      )}

      {status === "typing" && <TypingReport units={units} unitIndex={unitIndex} charIndex={charIndex} />}

      {status === "done" && analysis && (
        <>
          <AnalysisBody analysis={analysis} payload={payload} />
          <button className="blade-button back-to-overview" type="button" onClick={onBackToOverview}>
            <span className="blade-copy"><strong>↑ Back to Token Overview</strong></span>
            <span className="blade-edge" aria-hidden="true" />
          </button>
        </>
      )}
    </section>
  );
}
