/**
 * Evidence index for the existing evidence-contract validator, built from the
 * profile payload. The validator's rules are unchanged: every citable ID is a
 * payload field (or scope note / identity), numbers are grounded against the
 * cited fields' displayed and stored values, and period-bearing fields must be
 * cited with their exact period label.
 */

import { evidenceItem, type EvidenceIndex, type EvidenceItem } from "./evidence-rules.ts";
import type { ProfilePayload } from "./profile-payload.ts";

const TYPE_BY_PREFIX: Record<string, EvidenceItem["type"]> = { obs: "obs", calc: "calc", hist: "hist", scope: "scope", fresh: "fresh" };

export function buildProfileEvidenceIndex(payload: ProfilePayload): EvidenceIndex {
  const items = new Map<string, EvidenceItem>();
  items.set("token", evidenceItem("token", "token", payload.token));
  for (const note of payload.scope) items.set(note.id, evidenceItem(note.id, "scope", note));
  for (const field of payload.fields) {
    const type = TYPE_BY_PREFIX[field.id.split(":")[0]] ?? "obs";
    items.set(field.id, evidenceItem(field.id, type, field, field.period ? [field.period] : [], field.status === "shown" && field.periodRequired));
  }
  const unmappedProviders = payload.scope
    .filter((note) => !note.mapped && (note.provider === "DeFiLlama" || note.provider === "DEX Screener"))
    .map((note) => ({ provider: note.provider as "DeFiLlama" | "DEX Screener", scopeId: note.id }));
  return { ids: new Set(items.keys()), context: { items, text: JSON.stringify(payload), tokenSymbol: payload.token.symbol, unmappedProviders } };
}

/** Labels for cited IDs, so the panel can show where each statement comes from. */
export function profileSourceLabels(payload: ProfilePayload, analysis: object): Record<string, string> {
  const labels = new Map<string, string>([["token", `${payload.token.name} (${payload.token.symbol}) on ${payload.token.chain}`]]);
  for (const note of payload.scope) labels.set(note.id, `${note.provider} scope: ${note.statement}`);
  for (const field of payload.fields) labels.set(field.id, `${field.section} · ${field.label}: ${field.value}${field.period ? ` · ${field.period}` : ""}`);
  const cited = new Set<string>();
  JSON.stringify(analysis, (key, value) => {
    if (key === "sourceIds" && Array.isArray(value)) for (const id of value) cited.add(id);
    return value;
  });
  return Object.fromEntries([...cited].filter((id) => labels.has(id)).map((id) => [id, labels.get(id)!]));
}
