import { randomUUID } from "node:crypto";
import { PROVIDER_STEPS, type RefreshStep } from "./config.ts";

type SupabaseAdminClient = ReturnType<typeof import("../supabase/admin").createSupabaseAdminClient>;

export type RunStatus = "running" | "succeeded" | "partial" | "failed" | "skipped";
export type StepStatus = "succeeded" | "failed" | "timed_out" | "skipped";
export type RefreshTrigger = "scheduled" | "manual";

export type StepRecord = {
  step: RefreshStep;
  status: StepStatus;
  startedAt: string;
  finishedAt: string;
  detail: Record<string, unknown>;
  error: string | null;
};

export type LatestRun = { id: number; status: RunStatus; startedAt: string; finishedAt: string | null };

/** Ownership credential returned by acquireRun; required by every later call on that run. */
export type RunOwnership = { runId: number; lockToken: string };

/** Persistence for refresh runs. Supabase in production; in-memory in tests. */
export interface RefreshStore {
  /** Returns the new run's id and ownership token, or null when another run holds an unexpired lease. */
  acquireRun(trigger: RefreshTrigger, now: Date, leaseMs: number): Promise<RunOwnership | null>;
  recordStep(runId: number, step: StepRecord): Promise<void>;
  /**
   * Extends the lease, but only while `lockToken` still matches the row's current
   * token and the row is still 'running'. Returns false — without throwing — the
   * moment another invocation has already reclaimed this run (its lease expired
   * and a new run was acquired): the caller must treat that as having lost
   * ownership and stop starting new work.
   */
  renewLease(runId: number, lockToken: string, now: Date, leaseMs: number): Promise<boolean>;
  /**
   * Marks the run finished, but only while `lockToken` still matches and the row
   * is still 'running'. Returns false — without throwing — if ownership was
   * already reclaimed by a newer run, which that newer run's own row is
   * untouched by (finishRun/renewLease always filter by this run's own id).
   */
  finishRun(runId: number, lockToken: string, status: Exclude<RunStatus, "running">, finishedAt: Date, summary: Record<string, unknown>, error: string | null): Promise<boolean>;
  lastSuccessfulSteps(): Promise<Partial<Record<RefreshStep, string>>>;
  latestRun(): Promise<LatestRun | null>;
}

/**
 * Derived from PROVIDER_STEPS rather than listed by hand: a provider missing from
 * this list never reports a last successful run, so isProviderDue treats it as due
 * on every tick and it refreshes far more often than its configured interval.
 */
const STEPS: RefreshStep[] = [...PROVIDER_STEPS, "metrics"];
const UNIQUE_VIOLATION = "23505";

// TEMPORARY diagnostic logging for the acquireRun 500 investigation. Logs only the
// Supabase error's own code/message/details/hint — never headers, secrets, or env vars.
// Remove once the cause is confirmed.
function logSupabaseError(operation: string, error: { code?: string; message?: string; details?: string; hint?: string } | null): void {
  if (!error) return;
  console.error("[diagnostic] acquireRun operation failed", {
    operation,
    code: error.code ?? null,
    message: error.message ?? null,
    details: error.details ?? null,
    hint: error.hint ?? null,
  });
}

function fail(error: { message: string } | null, action: string): void {
  if (error) throw new Error(`Supabase ${action} failed: ${error.message}`);
}

export class SupabaseRefreshStore implements RefreshStore {
  private readonly client: SupabaseAdminClient;

  constructor(client: SupabaseAdminClient) {
    this.client = client;
  }

  async acquireRun(trigger: RefreshTrigger, now: Date, leaseMs: number): Promise<RunOwnership | null> {
    // Release a lock left behind by a run that crashed, was killed mid-flight, or
    // simply stopped heartbeating (see renewLease): its audit row is preserved,
    // just marked failed/abandoned, never deleted or overwritten with new data.
    console.log("[diagnostic] acquireRun: about to run expire-abandoned-runs UPDATE");
    const { error: expireError } = await this.client.from("data_refresh_runs")
      .update({ status: "failed", finished_at: now.toISOString(), error: "Run abandoned: its lease expired before it finished." })
      .eq("status", "running")
      .lt("lease_expires_at", now.toISOString());
    logSupabaseError("expire_abandoned_refresh_runs", expireError as { code?: string; message?: string; details?: string; hint?: string } | null);
    fail(expireError, "expire abandoned refresh runs");

    // Generated here (not left to the column's DB default) so the caller has its
    // ownership credential immediately, with no extra round trip to read it back.
    const lockToken = randomUUID();
    console.log("[diagnostic] acquireRun: about to run data_refresh_runs INSERT");
    const { data, error } = await this.client.from("data_refresh_runs")
      .insert({
        trigger, status: "running", started_at: now.toISOString(),
        lease_expires_at: new Date(now.getTime() + leaseMs).toISOString(),
        heartbeat_at: now.toISOString(), lock_token: lockToken,
      })
      .select("id")
      .single();
    // The partial unique index permits a single 'running' row: a conflict means busy.
    if (error && (error as { code?: string }).code === UNIQUE_VIOLATION) return null;
    logSupabaseError("start_refresh_run", error as { code?: string; message?: string; details?: string; hint?: string } | null);
    fail(error, "start refresh run");
    return { runId: (data as { id: number }).id, lockToken };
  }

  async renewLease(runId: number, lockToken: string, now: Date, leaseMs: number): Promise<boolean> {
    const { data, error } = await this.client.from("data_refresh_runs")
      .update({ lease_expires_at: new Date(now.getTime() + leaseMs).toISOString(), heartbeat_at: now.toISOString() })
      .eq("id", runId)
      .eq("lock_token", lockToken)
      .eq("status", "running")
      .select("id");
    fail(error, "renew refresh run lease");
    // Zero rows matched means another invocation already reclaimed this run
    // (its lease expired and a new run/token took over); this invocation must
    // stop treating itself as the owner.
    return (data ?? []).length > 0;
  }

  async recordStep(runId: number, step: StepRecord): Promise<void> {
    const { error } = await this.client.from("data_refresh_steps").insert({
      run_id: runId,
      step: step.step,
      status: step.status,
      started_at: step.startedAt,
      finished_at: step.finishedAt,
      detail: step.detail,
      error: step.error,
    });
    fail(error, `record ${step.step} refresh step`);
  }

  async finishRun(runId: number, lockToken: string, status: Exclude<RunStatus, "running">, finishedAt: Date, summary: Record<string, unknown>, error: string | null): Promise<boolean> {
    const { data, error: updateError } = await this.client.from("data_refresh_runs")
      .update({ status, finished_at: finishedAt.toISOString(), summary, error })
      .eq("id", runId)
      .eq("lock_token", lockToken)
      .eq("status", "running")
      .select("id");
    fail(updateError, "finish refresh run");
    // False means this run was already reclaimed (its own row was already flipped
    // to 'failed' by another invocation's acquireRun); the caller no longer owns
    // it and must not treat this as having finalized anything.
    return (data ?? []).length > 0;
  }

  async lastSuccessfulSteps(): Promise<Partial<Record<RefreshStep, string>>> {
    const results = await Promise.all(STEPS.map(async (step) => {
      const { data, error } = await this.client.from("data_refresh_steps")
        .select("finished_at").eq("step", step).eq("status", "succeeded")
        .order("finished_at", { ascending: false }).limit(1).maybeSingle();
      fail(error, `read last ${step} refresh`);
      return [step, (data as { finished_at: string } | null)?.finished_at] as const;
    }));
    return Object.fromEntries(results.filter(([, finishedAt]) => finishedAt)) as Partial<Record<RefreshStep, string>>;
  }

  /** The most recent recorded step of each kind, whatever its outcome. */
  async latestAttempts(): Promise<Partial<Record<RefreshStep, { status: StepStatus; finishedAt: string }>>> {
    const results = await Promise.all(STEPS.map(async (step) => {
      const { data, error } = await this.client.from("data_refresh_steps")
        .select("status,finished_at").eq("step", step)
        .order("finished_at", { ascending: false }).limit(1).maybeSingle();
      fail(error, `read latest ${step} attempt`);
      const row = data as { status: StepStatus; finished_at: string } | null;
      return [step, row ? { status: row.status, finishedAt: row.finished_at } : undefined] as const;
    }));
    return Object.fromEntries(results.filter(([, attempt]) => attempt)) as Partial<Record<RefreshStep, { status: StepStatus; finishedAt: string }>>;
  }

  async latestRun(): Promise<LatestRun | null> {
    const { data, error } = await this.client.from("data_refresh_runs")
      .select("id,status,started_at,finished_at").order("started_at", { ascending: false }).limit(1).maybeSingle();
    fail(error, "read latest refresh run");
    if (!data) return null;
    const row = data as { id: number; status: RunStatus; started_at: string; finished_at: string | null };
    return { id: row.id, status: row.status, startedAt: row.started_at, finishedAt: row.finished_at };
  }
}
