import "server-only";

type SupabaseAdminClient = ReturnType<typeof import("../supabase/admin").createSupabaseAdminClient>;
type QueryResult = { data: unknown; error: { code?: string; message: string } | null };

export const RESOLVED_OBSERVATIONS = "token_metric_observations_resolved";
const missing = (error: { code?: string } | null) => error?.code === "PGRST205" || error?.code === "42P01";

/** Preserve original row shapes while resolving compacted provenance server-side. */
export async function observationRead<T extends QueryResult>(
  client: SupabaseAdminClient,
  build: (relation: string) => PromiseLike<T>,
): Promise<T> {
  const result = await build(RESOLVED_OBSERVATIONS);
  if (!missing(result.error)) return result;

  // Old environments can use their original table. Once packing has been enabled
  // or used, falling back would silently omit provenance and must fail explicitly.
  const state = await client.from("observation_metadata_compaction_state")
    .select("enabled,compacted_rows").eq("id", true).maybeSingle();
  if (state.error && !missing(state.error)) throw new Error("Cannot verify observation storage compatibility.");
  if (state.data?.enabled || Number(state.data?.compacted_rows ?? 0) > 0) {
    throw new Error("Resolved observation view is required for compacted data; refusing incomplete provenance.");
  }
  return await build("token_metric_observations");
}
