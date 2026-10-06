/**
 * Automatic footnote numbering for a Deep Analysis Engine report (research-report redesign, Phase
 * 5). The engine never assigns citation numbers itself — every paragraph only ever carries
 * `sourceIds`, a list of evidence IDs already validated against the profile's own evidence index
 * (see report-schema.ts). This module is purely a renderer-side resolution step: it walks the
 * report's sections in their fixed display order, assigns each evidence ID the next sequential
 * footnote number the first time it is cited, and reuses that same number for every later citation
 * of the same ID — so footnote numbering is 100% deterministic from the report's own content and
 * can never produce an orphaned or invented citation.
 *
 * The literal "token" evidence ID (the token's own bare identity, used to ground statements like
 * "CAKE is native to BNB Chain" or a section's own "not enough data" placeholder) is intentionally
 * excluded from footnoting: it names no external provider record worth citing, so paragraphs
 * grounded only by it render with no footnote marker at all rather than a footnote that would just
 * repeat the token's own name.
 */

import { ENGINE_SECTION_KEYS, type EngineTokenAnalysis } from "./engine/report-schema.ts";

export type Footnote = { number: number; evidenceId: string; text: string };

export type FootnoteIndex = {
  /** Evidence ID -> its assigned footnote number, in first-citation order across the whole report. */
  numberByEvidenceId: Record<string, number>;
  /** One entry per distinct cited evidence ID, in footnote-number order. */
  footnotes: Footnote[];
};

const NON_CITABLE_EVIDENCE_IDS = new Set(["token"]);

export function buildFootnoteIndex(analysis: EngineTokenAnalysis): FootnoteIndex {
  const sources = analysis.metadata.sources ?? {};
  const numberByEvidenceId: Record<string, number> = {};
  const footnotes: Footnote[] = [];

  const visit = (sourceIds: string[]) => {
    for (const id of sourceIds) {
      if (NON_CITABLE_EVIDENCE_IDS.has(id) || numberByEvidenceId[id] !== undefined) continue;
      const number = footnotes.length + 1;
      numberByEvidenceId[id] = number;
      footnotes.push({ number, evidenceId: id, text: sources[id] ?? "Token Samurai stored evidence." });
    }
  };

  for (const key of ENGINE_SECTION_KEYS) for (const paragraph of analysis[key].paragraphs) visit(paragraph.sourceIds);
  for (const question of analysis.furtherResearchQuestions) visit(question.sourceIds);

  return { numberByEvidenceId, footnotes };
}

/** A paragraph's own footnote numbers, in ascending order, excluding any non-citable IDs. */
export function footnoteNumbersFor(sourceIds: string[], index: FootnoteIndex): number[] {
  const numbers = sourceIds.map((id) => index.numberByEvidenceId[id]).filter((n): n is number => n !== undefined);
  return [...new Set(numbers)].sort((a, b) => a - b);
}
