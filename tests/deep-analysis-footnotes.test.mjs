// Automatic footnote resolution (src/lib/analysis/footnotes.ts) for the Deep Analysis Engine's
// research-report redesign: every paragraph's sourceIds must resolve to sequential, stable footnote
// numbers with no invented or orphaned citations, and the "token" identity marker must never
// consume a footnote number (it names no external provider record worth citing).

import assert from "node:assert/strict";

import { getLiveTokenProfile } from "../src/lib/data/live-data.ts";
import { buildProfilePayload } from "../src/lib/analysis/profile-payload.ts";
import { createFakeSupabase } from "./support/fake-supabase.mjs";
import { buildEngineReport } from "../src/lib/analysis/engine/report.ts";
import { ENGINE_SECTION_KEYS } from "../src/lib/analysis/engine/report-schema.ts";
import { buildFootnoteIndex, footnoteNumbersFor } from "../src/lib/analysis/footnotes.ts";

const cases = [];
function test(name, run) { cases.push({ name, run }); }

const NOW = new Date();
const MIDNIGHT = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate(), 0, 10, 0));
const HOUR = 60 * 60 * 1000;
const at = (hoursAgo) => new Date(MIDNIGHT.getTime() - hoursAgo * HOUR).toISOString();

function seed(tokenId, chainId, rows) {
  let id = 1000;
  const obs = ([provider, metric, value, hoursAgo = 0.5, extra = {}]) => ({
    id: id++, token_id: tokenId, chain_id: chainId, provider_id: provider, metric_id: metric, value,
    status: value === null ? "unavailable" : "available", observed_at: at(hoursAgo), collected_at: at(hoursAgo), window_days: null, note: null, ...extra,
  });
  return {
    tokens: [{ id: tokenId, name: "Footnote Token", symbol: "FTN", chain_id: chainId, contract_address: "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984", is_native: false, category: "DeFi", description: null }],
    chains: [{ id: chainId, name: chainId }],
    token_metric_observations: rows.map(obs),
    metric_definitions: [],
    calculated_metric_observations: [],
    calculated_metric_definitions: [],
  };
}

const PAYLOAD = await (async () => {
  const data = seed("ftn-e2e", "ethereum", [
    ["coingecko", "price_usd", 1.5, 0.5], ["coingecko", "price_usd", 1.2, 24.5], ["coingecko", "price_usd", 1.1, 168.5],
    ["coingecko", "market_cap_usd", 150_000_000, 0.5],
    ["coingecko", "volume_24h_usd", 5_000_000, 0.5],
  ]);
  const profile = await getLiveTokenProfile("ftn-e2e", createFakeSupabase({ seed: data }).client);
  return buildProfilePayload(profile);
})();

const REPORT = buildEngineReport(PAYLOAD);
// buildFootnoteIndex takes the fully assembled, stored shape (EngineTokenAnalysis, with metadata
// attached) — the same shape deterministic-service.ts wraps buildEngineReport's own output in
// before it ever reaches the renderer; reconstruct that minimal wrapping here for the test.
const ANALYSIS = { ...REPORT.analysis, metadata: { sources: REPORT.sources } };
const INDEX = buildFootnoteIndex(ANALYSIS);

test("1. every cited evidence ID (other than the bare 'token' marker) gets exactly one footnote, numbered sequentially from 1 with no gaps", () => {
  const numbers = INDEX.footnotes.map((footnote) => footnote.number);
  assert.deepEqual(numbers, Array.from({ length: numbers.length }, (_, i) => i + 1), "footnote numbers run 1..N with no gaps or duplicates");
  const ids = INDEX.footnotes.map((footnote) => footnote.evidenceId);
  assert.equal(new Set(ids).size, ids.length, "no evidence ID appears in more than one footnote entry");
});

test("2. the literal 'token' evidence ID never consumes a footnote number", () => {
  assert.equal(INDEX.numberByEvidenceId.token, undefined, "'token' is excluded from numberByEvidenceId");
  assert.ok(!INDEX.footnotes.some((footnote) => footnote.evidenceId === "token"), "'token' never appears as a footnote entry");
});

test("3. every footnote's text is the report's own stored source label for that evidence ID — never invented", () => {
  for (const footnote of INDEX.footnotes) {
    assert.equal(footnote.text, REPORT.sources[footnote.evidenceId], "footnote text is exactly the engine's own evidence label for that ID");
  }
});

test("4. footnoteNumbersFor a paragraph returns only numbers actually present in the index, deduplicated and ascending", () => {
  for (const key of ENGINE_SECTION_KEYS) {
    for (const paragraph of REPORT.analysis[key].paragraphs) {
      const numbers = footnoteNumbersFor(paragraph.sourceIds, INDEX);
      for (const number of numbers) assert.ok(number >= 1 && number <= INDEX.footnotes.length, `footnote number ${number} is within the resolved range`);
      assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b), "numbers are ascending");
      assert.equal(new Set(numbers).size, numbers.length, "no duplicate numbers for one paragraph");
    }
  }
});

test("5. a first-citation-order rebuild from the same report is byte-identical (deterministic numbering)", () => {
  const again = buildFootnoteIndex(ANALYSIS);
  assert.deepEqual(again, INDEX, "the same report always assigns the same footnote numbers");
});

test("6. no section ever cites an evidence ID absent from the report's own sources map, except the 'token' marker", () => {
  for (const key of ENGINE_SECTION_KEYS) {
    for (const paragraph of REPORT.analysis[key].paragraphs) {
      for (const id of paragraph.sourceIds) {
        assert.ok(id === "token" || REPORT.sources[id] !== undefined, `paragraph in ${key} cites ${id}, which is not in the report's own sources map`);
      }
    }
  }
});

let failures = 0;
for (const { name, run } of cases) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}: ${error instanceof Error ? error.stack : "unknown error"}`);
  }
}
console.log(`${cases.length - failures}/${cases.length} Deep Analysis footnote checks passed.`);
if (failures > 0) process.exitCode = 1;
