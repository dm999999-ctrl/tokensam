"use client";

import { useState, useTransition } from "react";
import { requestTokenAnalysis } from "@/app/tokens/[id]/actions";
import type { EngineAnalysisState } from "@/lib/analysis/deterministic-service";
import { ENGINE_SECTION_KEYS, ENGINE_SECTION_TITLES, type EngineSectionKey, type EngineTokenAnalysis } from "@/lib/analysis/engine/report-schema";

const LETTERS = "ABCDEFGHIJK";

function utc(value: string | null) {
  if (!value) return "unknown";
  return `${new Date(value).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC`;
}

/**
 * Renders each cited evidence ID (e.g. "obs:price") as its human-readable provenance label (e.g.
 * "Overview · Price: $9.33"), never as the raw internal ID: that ID is an evidence-contract
 * implementation detail (see analysis/engine/report-schema.ts), not something to expose in a
 * user-facing report. The raw ID stays reachable in the title tooltip, which is the intended
 * provenance mechanism for anyone who wants to see exactly which context entry a citation points to.
 */
function Sources({ ids, sources }: { ids: string[]; sources: Record<string, string> }) {
  if (ids.length === 0) return null;
  return (
    <span className="ai-sources">
      {ids.map((id) => <span key={id} className="ai-source" title={id}>{sources[id] ?? "Evidence"}</span>)}
    </span>
  );
}

function Section({ letter, sectionKey, section, sources }: { letter: string; sectionKey: EngineSectionKey; section: { paragraphs: { text: string; sourceIds: string[] }[] }; sources: Record<string, string> }) {
  return (
    <section className="ai-section">
      <h3><span>{letter}</span>{ENGINE_SECTION_TITLES[sectionKey]}</h3>
      {section.paragraphs.length === 0 ? <p className="ai-empty">No content was generated for this section from the current data snapshot.</p> : (
        <div className="ai-paragraphs">
          {section.paragraphs.map((paragraph, index) => (
            <p key={index} className="ai-paragraph">
              {paragraph.text}
              <Sources ids={paragraph.sourceIds} sources={sources} />
            </p>
          ))}
        </div>
      )}
    </section>
  );
}

function AnalysisBody({ analysis }: { analysis: EngineTokenAnalysis }) {
  const { sources } = analysis.metadata;
  return (
    <div className="ai-body">
      {ENGINE_SECTION_KEYS.map((key, index) => <Section key={key} letter={LETTERS[index]} sectionKey={key} section={analysis[key]} sources={sources} />)}

      <section className="ai-section">
        <h3><span>{LETTERS[ENGINE_SECTION_KEYS.length]}</span>Further Research Questions</h3>
        {analysis.furtherResearchQuestions.length === 0 ? <p className="ai-empty">No research questions arise from a materially significant, currently unresolved relationship in this snapshot.</p> : (
          <ol className="ai-questions">
            {analysis.furtherResearchQuestions.map((item, index) => (
              <li key={index}><strong>{item.question}</strong><span>{item.rationale}</span><Sources ids={item.sourceIds} sources={sources} /></li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

export function deepAnalysisButtonHint(state: EngineAnalysisState): string {
  if (state.status !== "ready") return "Unavailable";
  return state.latest ? `Generated ${utc(state.latest.metadata.generatedAt)}` : `${state.model} · generate on request`;
}

export function DeepAnalysisPanel({ tokenId, initialState, hidden }: { tokenId: string; initialState: EngineAnalysisState; hidden: boolean }) {
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
          {latest && <AnalysisBody analysis={latest} />}
        </>
      )}
    </section>
  );
}
