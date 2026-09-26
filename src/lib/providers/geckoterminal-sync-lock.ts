/**
 * A small, dedicated lease-based lock for GeckoTerminal collection, mirroring
 * the proven pattern in `src/lib/refresh/store.ts` (`data_refresh_runs`): a
 * single "running" row (enforced by a partial unique index), with an
 * expiring lease so a crashed run releases itself automatically.
 *
 * GeckoTerminal deliberately does NOT share `data_refresh_runs`/
 * `data_refresh_steps`: those are typed to the automated hourly
 * `ProviderStep` set (see refresh/config.ts), and forcing GeckoTerminal's very
 * different cadence (daily, longer-running, tolerant of partial failure) into
 * that shape would mean widening the same `ProviderStep`/step-check
 * constraint the GeckoTerminal integration deliberately left untouched. This
 * lock protects both entry points — a scheduled run and a manual
 * `pnpm geckoterminal:sync` — from ever executing concurrently.
 */

type SupabaseAdminClient = ReturnType<typeof import("../supabase/admin").createSupabaseAdminClient>;

export type GeckoTerminalSyncTrigger = "scheduled" | "manual";
export type GeckoTerminalSyncStatus = "running" | "succeeded" | "partial" | "failed";

const UNIQUE_VIOLATION = "23505";
// PostgREST reports a missing relation as PGRST205 (schema cache) or 42P01 (Postgres).
const MISSING_RELATION_CODES = new Set(["PGRST205", "42P01"]);

function fail(error: { message: string } | null, action: string): void {
  if (error) throw new Error(`Supabase ${action} failed: ${error.message}`);
}

export async function geckoTerminalSyncLockTableExists(client: SupabaseAdminClient): Promise<boolean> {
  const { error } = await client.from("geckoterminal_sync_runs").select("id").limit(0);
  return !error || !MISSING_RELATION_CODES.has((error as { code?: string }).code ?? "");
}

/** Acquires the single GeckoTerminal sync lock, or returns null when another run already holds it. */
export async function acquireGeckoTerminalSyncLock(
  client: SupabaseAdminClient,
  trigger: GeckoTerminalSyncTrigger,
  now: Date,
  leaseMs: number,
): Promise<number | null> {
  // Release a lock left behind by a run that crashed or was killed mid-flight.
  const { error: expireError } = await client.from("geckoterminal_sync_runs")
    .update({ status: "failed", finished_at: now.toISOString(), error: "Run abandoned: its lease expired before it finished." })
    .eq("status", "running")
    .lt("lease_expires_at", now.toISOString());
  fail(expireError, "expire abandoned GeckoTerminal sync runs");

  const { data, error } = await client.from("geckoterminal_sync_runs")
    .insert({ trigger, status: "running", started_at: now.toISOString(), lease_expires_at: new Date(now.getTime() + leaseMs).toISOString() })
    .select("id")
    .single();
  // The partial unique index permits a single 'running' row: a conflict means busy.
  if (error && (error as { code?: string }).code === UNIQUE_VIOLATION) return null;
  fail(error, "start GeckoTerminal sync run");
  return (data as { id: number }).id;
}

export async function finishGeckoTerminalSyncLock(
  client: SupabaseAdminClient,
  runId: number,
  status: Exclude<GeckoTerminalSyncStatus, "running">,
  finishedAt: Date,
  summary: Record<string, unknown>,
  error: string | null,
): Promise<void> {
  const { error: updateError } = await client.from("geckoterminal_sync_runs")
    .update({ status, finished_at: finishedAt.toISOString(), summary, error })
    .eq("id", runId);
  fail(updateError, "finish GeckoTerminal sync run");
}

/** Finished timestamp of the most recent successful (or partially successful) run, for a due-check. */
export async function lastSuccessfulGeckoTerminalSync(client: SupabaseAdminClient): Promise<string | null> {
  const { data, error } = await client.from("geckoterminal_sync_runs")
    .select("finished_at")
    .in("status", ["succeeded", "partial"])
    .order("finished_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  fail(error, "read last successful GeckoTerminal sync");
  return (data as { finished_at?: string } | null)?.finished_at ?? null;
}

/**
 * Runs `work` while holding the lock, releasing it on success or failure.
 * Throws immediately (before calling `work`) if another run already holds it.
 */
export async function withGeckoTerminalSyncLock<T>(
  client: SupabaseAdminClient,
  trigger: GeckoTerminalSyncTrigger,
  leaseMs: number,
  work: () => Promise<T>,
): Promise<T> {
  const runId = await acquireGeckoTerminalSyncLock(client, trigger, new Date(), leaseMs);
  if (runId === null) {
    throw new Error("A GeckoTerminal collection is already running (scheduled or manual); try again once it finishes.");
  }
  try {
    const result = await work();
    await finishGeckoTerminalSyncLock(client, runId, "succeeded", new Date(), {}, null);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error.";
    await finishGeckoTerminalSyncLock(client, runId, "failed", new Date(), {}, message).catch(() => undefined);
    throw error;
  }
}
