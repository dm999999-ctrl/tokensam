import type { RefreshStep } from "./config.ts";

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

/** Persistence for refresh runs. Supabase in production; in-memory in tests. */
export interface RefreshStore {
  /** Returns the new run id, or null when another run holds an unexpired lease. */
  acquireRun(trigger: RefreshTrigger, now: Date, leaseMs: number): Promise<number | null>;
  recordStep(runId: number, step: StepRecord): Promise<void>;
  finishRun(runId: number, status: Exclude<RunStatus, "running">, finishedAt: Date, summary: Record<string, unknown>, error: string | null): Promise<void>;
  lastSuccessfulSteps(): Promise<Partial<Record<RefreshStep, string>>>;
  latestRun(): Promise<LatestRun | null>;
}

const STEPS: RefreshStep[] = ["coingecko", "defillama", "dexscreener", "defillama_coins", "metrics"];
const UNIQUE_VIOLATION = "23505";

function fail(error: { message: string } | null, action: string): void {
  if (error) throw new Error(`Supabase ${action} failed: ${error.message}`);
}

export class SupabaseRefreshStore implements RefreshStore {
  private readonly client: SupabaseAdminClient;

  constructor(client: SupabaseAdminClient) {
    this.client = client;
  }

  async acquireRun(trigger: RefreshTrigger, now: Date, leaseMs: number): Promise<number | null> {
    // Release a lock left behind by a run that crashed or was killed mid-flight.
    const { error: expireError } = await this.client.from("data_refresh_runs")
      .update({ status: "failed", finished_at: now.toISOString(), error: "Run abandoned: its lease expired before it finished." })
      .eq("status", "running")
      .lt("lease_expires_at", now.toISOString());
    fail(expireError, "expire abandoned refresh runs");

    const { data, error } = await this.client.from("data_refresh_runs")
      .insert({ trigger, status: "running", started_at: now.toISOString(), lease_expires_at: new Date(now.getTime() + leaseMs).toISOString() })
      .select("id")
      .single();
    // The partial unique index permits a single 'running' row: a conflict means busy.
    if (error && (error as { code?: string }).code === UNIQUE_VIOLATION) return null;
    fail(error, "start refresh run");
    return (data as { id: number }).id;
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

  async finishRun(runId: number, status: Exclude<RunStatus, "running">, finishedAt: Date, summary: Record<string, unknown>, error: string | null): Promise<void> {
    const { error: updateError } = await this.client.from("data_refresh_runs")
      .update({ status, finished_at: finishedAt.toISOString(), summary, error })
      .eq("id", runId);
    fail(updateError, "finish refresh run");
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
