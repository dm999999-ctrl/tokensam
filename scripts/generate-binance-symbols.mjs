// Regenerates cloudflare/refresh-scheduler/src/binance-symbols.ts from the canonical
// mapping in src/data/binance-token-mappings.ts. Run with: pnpm binance:symbols
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { binanceSymbols } = await import(resolve(root, "src/data/binance-token-mappings.ts"));
const symbols = Object.values(binanceSymbols).sort();

writeFileSync(resolve(root, "cloudflare/refresh-scheduler/src/binance-symbols.ts"), `// GENERATED -- do not edit by hand.
//
// The Binance spot symbols this Worker is allowed to quote, copied from
// src/data/binance-token-mappings.ts (the canonical mapping) so the public
// /binance-prices route can never be driven to quote arbitrary symbols by its
// caller: the client sends no symbol list at all.
//
// Regenerate with: pnpm binance:symbols
// tests/binance.test.mjs asserts this list still matches the canonical mapping, so
// adding a token there without regenerating fails the suite rather than silently
// leaving the new token without a live price.
export const BINANCE_SYMBOLS: string[] = ${JSON.stringify(symbols, null, 2)};
`);
console.log(`wrote ${symbols.length} symbols`);
