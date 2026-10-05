"use client";

import { useState, useTransition } from "react";
import { requestTokenAnalysis } from "@/app/tokens/[id]/actions";
import type { EngineAnalysisState } from "@/lib/analysis/deterministic-service";
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

/** Sections after Executive Assessment are numbered 1-10 in report order, matching the reference report layout; Executive Assessment, Further Research Questions, Footnotes, and Evidence & Methodology stay unnumbered. */
const NUMBERED_SECTIONS: EngineSectionKey[] = ENGINE_SECTION_KEYS.filter((key) => key !== "executiveAssessment");

function Section({ sectionKey, section, footnoteIndex, sources }: { sectionKey: EngineSectionKey; section: { paragraphs: EngineParagraph[] }; footnoteIndex: FootnoteIndex; sources: Record<string, string> }) {
  const number = NUMBERED_SECTIONS.indexOf(sectionKey);
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

function FurtherResearchQuestions({ analysis, footnoteIndex }: { analysis: EngineTokenAnalysis; footnoteIndex: FootnoteIndex }) {
  return (
    <section className="report-section" id="section-furtherResearch">
      <h3>{NUMBERED_SECTIONS.length + 1}. Further Research Questions</h3>
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

      {state.status !== "ready" ? (
        <div className="ai-state" role="status"><strong>AI analysis unavailable</strong><p>{state.message}</p></div>
      ) : (
        <>
          <div className="ai-toolbar">
            {!latest && <p className="ai-empty">No analysis has been generated for this token yet. Generation uses the current stored evidence and runs only when requested.</p>}
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
