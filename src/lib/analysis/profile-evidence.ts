/**
 * Evidence index for the existing evidence-contract validator, built from the
 * profile payload instead of the research context. The validator's rules are
 * unchanged: every citable ID is a payload field (or scope note / identity),
 * numbers are grounded against the cited fields' displayed and stored values,
 * and period-bearing fields must be cited with their exact period label.
 */

import { createHash } from "node:crypto";

import type { ContextSizeDiagnostic } from "./diagnostics.ts";
import type { ProfilePayload } from "./profile-payload.ts";

// The index and source labels are browser-safe and shared with the local-AI path.
export { buildProfileEvidenceIndex, profileSourceLabels } from "./profile-evidence-index.ts";

/** Stable hash of the payload (it contains no clock-dependent wording). */
export function profilePayloadHash(payload: ProfilePayload): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/** Size diagnostics for the payload (same shape as the research-context measurement). */
export function measureProfilePayload(payload: ProfilePayload, prompt: { systemInstruction: string; userContent: string; responseSchema: unknown }): ContextSizeDiagnostic {
  const bytes = (value: unknown) => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)).length;
  const componentBytes = { token: bytes(payload.token), scope: bytes(payload.scope), fields: bytes(payload.fields) };
  const count = (prefix: string) => payload.fields.filter((field) => field.id.startsWith(prefix)).length;
  const systemInstructionBytes = bytes(prompt.systemInstruction);
  const userContentBytes = bytes(prompt.userContent);
  const responseSchemaBytes = bytes(prompt.responseSchema);
  return {
    contextVersion: payload.version,
    contextBytes: bytes(payload),
    componentBytes,
    largestComponent: "fields",
    counts: {
      observations: count("obs:"), calculatedMetrics: count("calc:"), historySeries: count("hist:"), historyPoints: 0,
      unavailable: payload.fields.filter((field) => field.status === "not_reported").length,
      citableIds: 1 + payload.scope.length + payload.fields.length,
    },
    systemInstructionBytes, userContentBytes, responseSchemaBytes,
    promptBytes: systemInstructionBytes + userContentBytes + responseSchemaBytes,
  };
}
