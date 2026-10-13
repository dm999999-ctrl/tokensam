import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Server/operator command only. It does not call crypto providers or print env values.
const envPath = resolve(process.cwd(), ".env.local");
if (existsSync(envPath)) process.loadEnvFile(envPath);
const args = process.argv.slice(2);
const enabled = args.find((arg) => arg.startsWith("--enable="));
const batchArg = args.find((arg) => arg.startsWith("--batch="));
const disable = args.includes("--disable");

try {
  if (args.some((arg) => arg !== "--disable" && !arg.startsWith("--enable=") && !arg.startsWith("--batch="))) {
    throw new Error("Use no arguments for status, --enable=<verified deployed commit>, --disable, or --batch=1..100.");
  }
  if ([Boolean(enabled), disable, Boolean(batchArg)].filter(Boolean).length > 1) {
    throw new Error("Choose one operation per command.");
  }
  const { createSupabaseAdminClient } = await import("../src/lib/supabase/admin.ts");
  const client = createSupabaseAdminClient();
  if (enabled || disable) {
    const release = enabled?.slice("--enable=".length);
    if (enabled && !/^[a-f0-9]{7,40}$/.test(release)) throw new Error("Supply the verified deployed Git commit SHA.");
    const { error } = await client.from("observation_metadata_compaction_state")
      .update(enabled ? { enabled: true, verified_release: release, last_error_code: null, last_error_at: null, updated_at: new Date().toISOString() }
        : { enabled: false, updated_at: new Date().toISOString() }).eq("id", true);
    if (error) throw error;
    console.log(disable ? "Metadata compaction paused; existing packed observations remain readable."
      : "Metadata compaction enabled for the operator-verified deployment.");
  } else if (batchArg) {
    const batch = Number(batchArg.slice("--batch=".length));
    if (!Number.isInteger(batch) || batch < 1 || batch > 100) throw new Error("Batch must be 1..100.");
    const { data, error } = await client.rpc("compact_observation_metadata_batch", { p_batch_size: batch });
    if (error) throw error;
    console.log(JSON.stringify(data));
  }
  const { data, error } = await client.from("observation_metadata_compaction_state")
    .select("enabled,verified_release,compacted_rows,scan_cursor,next_scan_at,max_database_bytes,last_error_code,last_error_at").eq("id", true).single();
  if (error) throw error;
  console.log(JSON.stringify(data));
} catch (error) {
  console.error(`Metadata compaction command failed: ${error?.message ?? "Unknown error"}`);
  process.exitCode = 1;
}
