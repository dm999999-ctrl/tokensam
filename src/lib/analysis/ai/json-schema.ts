/**
 * Conformance to the subset of JSON Schema the Token Samurai report schema
 * uses (object/required/additionalProperties, array/items, string/enum). Runs
 * before the evidence validator so a malformed provider response is classified
 * as a structured-output failure, not an evidence failure.
 */

export type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: readonly string[];
};

/** Returns the first errors found (empty when the value conforms). */
export function schemaErrors(value: unknown, schema: JsonSchema, path = "$", out: string[] = [], max = 20): string[] {
  if (out.length >= max) return out;
  if (schema.type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) { out.push(`${path}: expected object`); return out; }
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in record)) out.push(`${path}.${key}: missing required property`);
    for (const [key, child] of Object.entries(record)) {
      const childSchema = schema.properties?.[key];
      if (!childSchema) {
        if (schema.additionalProperties === false) out.push(`${path}.${key}: property not allowed`);
      } else schemaErrors(child, childSchema, `${path}.${key}`, out, max);
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) { out.push(`${path}: expected array`); return out; }
    value.forEach((item, index) => { if (schema.items) schemaErrors(item, schema.items, `${path}[${index}]`, out, max); });
  } else if (schema.type === "string") {
    if (typeof value !== "string") out.push(`${path}: expected string`);
    else if (schema.enum && !schema.enum.includes(value)) out.push(`${path}: value not in enum`);
  }
  return out;
}
