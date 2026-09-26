"use client";

import { useState, useTransition } from "react";
import { requestTokenAnalysis } from "@/app/tokens/[id]/actions";
import type { AnalysisState } from "@/lib/analysis/service";
import type { AnalysisSection, AnalysisStatement, SectionKey, TokenAnalysis } from "@/lib/analysis/schema";

const SECTIONS: { key: SectionKey; letter: string; title: string }[] = [
  { key: "executiveSummary", letter: "A", title: "Executive summary" },
  { key: "marketPerformance", letter: "B", title: "Market performance" },
  { key: "fundamentalPerformance", letter: "C", title: "Fundamental performance" },
  { key: "valuation", letter: "D", title: "Valuation relationships" },
  { key: "marketFundamentalRelationships", letter: "E", title: "Price vs fundamentals" },
  { key: "liquidityMarketStructure", letter: "F", title: "Liquidity / market structure" },
  { key: "tokenomics", letter: "G", title: "Tokenomics" },
];

const KIND_LABEL: Record<AnalysisStatement["kind"], string> = {
  observed: "Observed data",
  calculated: "Calculated metric",
  interpretation: "AI interpretation",
  uncertainty: "Uncertainty",
};

function utc(value: string | null) {
  if (!value) return "unknown";
  return `${new Date(value).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC`;
}

function Sources({ ids, sources }: { ids: string[]; sources: Record<string, string> }) {
  if (ids.length === 0) return null;
  return (
    <span className="ai-sources">
      {ids.map((id) => <span key={id} className="ai-source" title={sources[id] ?? id}>{id}</span>)}
    </span>
  );
}

function Section({ letter, title, section, sources }: { letter: string; title: string; section: AnalysisSection; sources: Record<string, string> }) {
  return (
    <section className="ai-section">
      <h3><span>{letter}</span>{title}</h3>
      <p className="ai-overview"><span className="ai-kind interpretation">AI interpretation</span>{section.overview}</p>
      {section.statements.length > 0 && (
        <ul className="ai-statements">
          {section.statements.map((statement, index) => (
            <li key={index} className={`ai-statement ${statement.kind}`}>
              <span className={`ai-kind ${statement.kind}`}>{KIND_LABEL[statement.kind]}</span>
              <span className="ai-statement-text">
                {statement.text}
                {statement.period && <small className="ai-period">Period: {statement.period}</small>}
                {!statement.traceable && (statement.kind === "observed" || statement.kind === "calculated") && <small className="ai-untraceable">No traceable source ID was cited for this statement.</small>}
              </span>
              <Sources ids={statement.sourceIds} sources={sources} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AnalysisBody({ analysis }: { analysis: TokenAnalysis }) {
  const { sources } = analysis.metadata;
  return (
    <div className="ai-body">
      {SECTIONS.map(({ key, letter, title }) => <Section key={key} letter={letter} title={title} section={analysis[key]} sources={sources} />)}

      <section className="ai-section">
        <h3><span>H</span>Risks / areas requiring attention</h3>
        {analysis.risks.length === 0 ? <p className="ai-empty">No evidence-supported risks were identified in the supplied data.</p> : (
          <ul className="ai-statements">
            {analysis.risks.map((risk, index) => (
              <li key={index} className="ai-statement">
                <span className={`ai-kind ${risk.basis === "evidence" ? "interpretation" : "uncertainty"}`}>{risk.basis === "evidence" ? "Evidence of risk" : "Data limitation"}</span>
                <span className="ai-statement-text"><strong>{risk.title}</strong> {risk.detail}</span>
                <Sources ids={risk.sourceIds} sources={sources} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="ai-section">
        <h3><span>I</span>Data gaps and uncertainties</h3>
        {analysis.dataGaps.length === 0 ? <p className="ai-empty">No data gaps were listed.</p> : (
          <ul className="ai-statements">
            {analysis.dataGaps.map((gap, index) => (
              <li key={index} className="ai-statement">
                <span className="ai-kind uncertainty">{gap.category.replaceAll("_", " ")}</span>
                <span className="ai-statement-text">{gap.detail}</span>
                <Sources ids={gap.sourceIds} sources={sources} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="ai-section">
        <h3><span>J</span>Further research questions</h3>
        {analysis.furtherResearchQuestions.length === 0 ? <p className="ai-empty">No research questions were listed.</p> : (
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

export function deepAnalysisButtonHint(state: AnalysisState): string {
  if (state.status === "unconfigured") return "Unavailable · Gemini not configured";
  if (state.status !== "ready") return "Unavailable";
  return state.latest ? `Generated ${utc(state.latest.metadata.generatedAt)}` : "Gemini · generate on request";
}

export function DeepAnalysisPanel({ tokenId, initialState, hidden }: { tokenId: string; initialState: AnalysisState; hidden: boolean }) {
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
        <div><p className="eyebrow">Research report · AI interpretation</p><h2 id="deep-ai-title">Deep AI Analysis</h2></div>
      </header>
      <p className="ai-disclaimer">
        An AI reading of this profile&apos;s stored evidence only. It is not investment advice and makes no price predictions.
        Labels separate <b className="ai-kind observed">Observed data</b> <b className="ai-kind calculated">Calculated metric</b> <b className="ai-kind interpretation">AI interpretation</b> <b className="ai-kind uncertainty">Uncertainty</b>.
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
                <div><dt>Model</dt><dd>{latest.metadata.provider} · {latest.metadata.model}{latest.metadata.requestedModel && latest.metadata.requestedModel !== latest.metadata.model ? ` (via ${latest.metadata.requestedModel})` : ""}</dd></div>
                {latest.metadata.fallback?.used && <div><dt>Fallback</dt><dd>Gemini unavailable ({latest.metadata.fallback.reason}); generated by OpenRouter</dd></div>}
                <div><dt>Prompt / schema</dt><dd>v{latest.metadata.promptVersion} / v{latest.metadata.schemaVersion}</dd></div>
              </dl>
            ) : <p className="ai-empty">No analysis has been generated for this token yet. Generation uses the current stored evidence and runs only when requested.</p>}
            <button className="ai-generate-button" type="button" onClick={generate} disabled={pending || coolingDown}>
              {pending ? "Generating…" : latest ? "Regenerate analysis" : "Generate analysis"}
            </button>
          </div>
          {coolingDown && !pending && <p className="ai-note">Regeneration is available after {utc(state.nextAllowedAt)}.</p>}
          {pending && <div className="ai-state" role="status"><strong>Generating analysis…</strong><p>Building the research context and waiting for Gemini. This can take up to a minute.</p></div>}
          {error && !pending && <div className="ai-state error" role="alert"><strong>Analysis not updated</strong><p>{error}</p></div>}
          {latest && <AnalysisBody analysis={latest} />}
        </>
      )}
    </section>
  );
}
