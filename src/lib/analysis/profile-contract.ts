/**
 * Structural evidence contract for the profile payload.
 *
 * 1. buildProfileResponseSchema(payload): the report schema for ONE request, derived at
 *    runtime from that token's payload. Every sourceIds item is an enum of the payload's
 *    actual evidence IDs, so a provider with constrained decoding cannot emit an ID that
 *    does not exist. The statement `period` is removed: the model does not write periods.
 * 2. attachEvidencePeriods(json, payload): deterministic post-processing that gives each
 *    statement the exact period text of the fields it cites (the first cited field whose
 *    period is required, else the first cited field with a period, else none).
 *
 * The result is then checked against the full report schema and the unchanged evidence
 * validator, which stays the final authority (it still checks IDs, periods, numbers,
 * named periods in text, scope wording, concepts, sentiment, and advice).
 */

import { ANALYSIS_RESPONSE_SCHEMA } from "./schema.ts";
import type { ProfilePayload } from "./profile-payload.ts";

type Schema = Record<string, unknown>;

/** Every ID the report may cite for this payload, in payload order. */
export function allowedEvidenceIds(payload: ProfilePayload): string[] {
  return ["token", ...payload.scope.map((note) => note.id), ...payload.fields.map((field) => field.id)];
}

const SOURCE_IDS_DESCRIPTION = "Evidence IDs from this token's data that support this item.";

/** The report schema for one payload: same report structure, evidence IDs constrained, no model-written periods. */
export function buildProfileResponseSchema(payload: ProfilePayload): Schema {
  return constrainedSchema(payload, { modelFacing: true });
}

/**
 * The schema the server checks after attaching periods: the full report schema (periods included)
 * with the same evidence-ID enums, so an ID outside this payload fails before the evidence validator.
 */
export function buildProfileValidationSchema(payload: ProfilePayload): Schema {
  return constrainedSchema(payload, { modelFacing: false });
}

function constrainedSchema(payload: ProfilePayload, options: { modelFacing: boolean }): Schema {
  const ids = allowedEvidenceIds(payload);
  const schema = JSON.parse(JSON.stringify(ANALYSIS_RESPONSE_SCHEMA)) as Schema;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node || typeof node !== "object") return;
    const record = node as Schema;
    const properties = record.properties as Record<string, Schema> | undefined;
    if (properties) {
      if (properties.sourceIds) properties.sourceIds = { type: "array", description: SOURCE_IDS_DESCRIPTION, items: { type: "string", enum: ids } };
      if (options.modelFacing && properties.period && properties.kind) {
        delete properties.period;
        record.required = (record.required as string[]).filter((key) => key !== "period");
        // These descriptions repeat once per section and restate rules the system instruction already gives;
        // short forms keep the per-request schema compact despite the evidence-ID enums.
        properties.kind = { ...properties.kind, description: "observed, calculated, interpretation, or uncertainty (see instructions)." };
        properties.text = { ...properties.text, description: "One neutral sentence." };
      }
      if (options.modelFacing && properties.overview && properties.statements) {
        properties.overview = { ...properties.overview, description: "At most three neutral sentences; no digits, dates, or named periods." };
      }
    }
    for (const value of Object.values(record)) visit(value);
  };
  visit(schema);
  return schema;
}

const SECTION_KEYS_WITH_STATEMENTS = [
  "executiveSummary", "marketPerformance", "fundamentalPerformance", "valuation",
  "marketFundamentalRelationships", "liquidityMarketStructure", "tokenomics",
] as const;

/**
 * Give every statement the period of the fields it cites, overriding anything the model wrote.
 * Leaves malformed shapes untouched (the schema check rejects them).
 */
export function attachEvidencePeriods(json: unknown, payload: ProfilePayload): unknown {
  if (!json || typeof json !== "object" || Array.isArray(json)) return json;
  const fields = new Map(payload.fields.map((field) => [field.id, field]));
  const report = { ...(json as Record<string, unknown>) };
  for (const key of SECTION_KEYS_WITH_STATEMENTS) {
    const section = report[key];
    if (!section || typeof section !== "object" || Array.isArray(section)) continue;
    const statements = (section as { statements?: unknown }).statements;
    if (!Array.isArray(statements)) continue;
    report[key] = {
      ...(section as object),
      statements: statements.map((statement) => {
        if (!statement || typeof statement !== "object" || Array.isArray(statement)) return statement;
        const ids = Array.isArray((statement as { sourceIds?: unknown }).sourceIds) ? (statement as { sourceIds: unknown[] }).sourceIds : [];
        const cited = ids.map((id) => (typeof id === "string" ? fields.get(id) : undefined)).filter((field) => field !== undefined);
        const period = cited.find((field) => field.status === "shown" && field.periodRequired)?.period
          ?? cited.find((field) => field.period)?.period
          ?? "";
        return { ...(statement as object), period };
      }),
    };
  }
  return report;
}
