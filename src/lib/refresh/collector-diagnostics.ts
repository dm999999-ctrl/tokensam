/**
 * Diagnostic-only stage timing for a single collector run.
 *
 * A plain object built at the end of a successful call (like
 * runCoinGeckoCollection's existing `timingMs`) is invisible whenever the
 * call is aborted mid-flight: nothing is ever returned, so there is nothing
 * to read. This class is instead mutated synchronously as each stage starts
 * and ends, and the caller (the refresh orchestrator) holds the same
 * reference it handed to the collector — so `snapshot()` still reflects
 * real progress even when the collector's own promise never resolves.
 *
 * Records only stage names and millisecond timestamps/durations (plus, for
 * HTTP attempts, an outcome and status code). Never holds request/response
 * bodies, headers, URLs, or credentials.
 */

export type StageStatus = "not_started" | "running" | "completed";

export type StageSnapshot =
  | { status: "not_started" }
  | { status: "running"; startedAt: string }
  | { status: "completed"; startedAt: string; endedAt: string; durationMs: number };

export type HttpAttemptRecord = {
  batch: number;
  attempt: number;
  outcome: "ok" | "retry" | "error";
  durationMs: number;
  httpStatus: number | null;
};

export type DiagnosticsSnapshot = {
  lastStage: string | null;
  lastStageStatus: StageStatus;
  stages: Record<string, StageSnapshot>;
  httpAttempts: HttpAttemptRecord[];
};

export class CollectorDiagnostics {
  private readonly declared: string[] = [];
  private readonly stages = new Map<string, { startedAt: number; endedAt: number | null }>();
  private readonly httpAttempts: HttpAttemptRecord[] = [];

  /** Pre-register the stages a collector intends to reach, in order, so a
   *  stage never started still shows up (as "not_started") instead of being
   *  silently absent from the snapshot. */
  declareStages(stageNames: readonly string[]): void {
    for (const name of stageNames) if (!this.declared.includes(name)) this.declared.push(name);
  }

  start(stage: string): void {
    if (!this.declared.includes(stage)) this.declared.push(stage);
    this.stages.set(stage, { startedAt: Date.now(), endedAt: null });
  }

  end(stage: string): void {
    const record = this.stages.get(stage);
    if (record && record.endedAt === null) record.endedAt = Date.now();
  }

  recordHttpAttempt(entry: HttpAttemptRecord): void {
    this.httpAttempts.push(entry);
  }

  snapshot(): DiagnosticsSnapshot {
    const stages: Record<string, StageSnapshot> = {};
    for (const name of this.declared) {
      const record = this.stages.get(name);
      if (!record) {
        stages[name] = { status: "not_started" };
      } else if (record.endedAt === null) {
        stages[name] = { status: "running", startedAt: new Date(record.startedAt).toISOString() };
      } else {
        stages[name] = {
          status: "completed",
          startedAt: new Date(record.startedAt).toISOString(),
          endedAt: new Date(record.endedAt).toISOString(),
          durationMs: record.endedAt - record.startedAt,
        };
      }
    }
    const startedOrder = [...this.stages.keys()];
    const lastStage = startedOrder.at(-1) ?? null;
    const lastStageStatus: StageStatus = lastStage ? stages[lastStage].status : "not_started";
    return { lastStage, lastStageStatus, stages, httpAttempts: [...this.httpAttempts] };
  }
}
