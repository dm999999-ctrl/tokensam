"use client";

import { useEffect, useRef, useState, type ComponentType } from "react";
import type { MLCEngine } from "@mlc-ai/web-llm";
import type { ProfilePayload } from "@/lib/analysis/profile-payload";
import type { TokenAnalysis } from "@/lib/analysis/schema";
import { ANALYSIS_RESPONSE_SCHEMA } from "@/lib/analysis/schema";
import { LOCAL_MODEL, buildLocalPrompt, finalizeLocalAnalysis, type LocalResult, type LocalRunStats } from "@/lib/analysis/local/local-analysis";

/**
 * Local AI (proof of concept): the canonical profile payload is analysed by a
 * model running in this browser on WebGPU. The payload never leaves the
 * device: the only network traffic is the one-time model download (weights
 * and the WebGPU kernel library), which the browser then caches. There is no
 * fallback to an external provider; the external path is separate.
 */

type Phase =
  | { kind: "checking" }
  | { kind: "unsupported"; reason: string }
  | { kind: "idle"; cached: boolean }
  | { kind: "loading"; progress: number; text: string }
  | { kind: "generating"; chunks: number }
  | { kind: "validating" }
  | { kind: "done"; result: LocalResult; stats: LocalRunStats; downloadedBytes: number | null }
  | { kind: "error"; message: string };

async function webGpuSupport(): Promise<string | null> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<{ features: Set<string> } | null> } }).gpu;
  if (!gpu) return "This browser does not provide WebGPU, so the local model cannot run on this device.";
  const adapter = await gpu.requestAdapter().catch(() => null);
  if (!adapter) return "WebGPU is present but no compatible graphics adapter is available on this device.";
  if (!adapter.features.has("shader-f16")) return "This device's GPU does not support 16-bit shaders (shader-f16), which this model requires.";
  return null;
}

async function storageUsage(): Promise<number | null> {
  try { return (await navigator.storage.estimate()).usage ?? null; } catch { return null; }
}

const seconds = (ms: number | null) => (ms === null ? "—" : `${(ms / 1000).toFixed(1)} s`);

export function LocalAnalysisPanel({ payload, Report }: { payload: ProfilePayload; Report: ComponentType<{ analysis: TokenAnalysis }> }) {
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });
  const engine = useRef<MLCEngine | null>(null);
  const loadMs = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const unsupported = await webGpuSupport();
      if (unsupported) { if (!cancelled) setPhase({ kind: "unsupported", reason: unsupported }); return; }
      const { hasModelInCache } = await import("@mlc-ai/web-llm");
      const cached = await hasModelInCache(LOCAL_MODEL.id).catch(() => false);
      if (!cancelled) setPhase({ kind: "idle", cached });
    })();
    return () => { cancelled = true; };
  }, []);

  const run = async () => {
    const usageBefore = await storageUsage();
    try {
      const webllm = await import("@mlc-ai/web-llm");
      if (!engine.current) {
        setPhase({ kind: "loading", progress: 0, text: "Preparing model…" });
        const started = performance.now();
        engine.current = await webllm.CreateMLCEngine(
          LOCAL_MODEL.id,
          { initProgressCallback: (report) => setPhase({ kind: "loading", progress: report.progress, text: report.text }) },
          { context_window_size: LOCAL_MODEL.contextWindow },
        );
        loadMs.current = performance.now() - started;
      }
      const usageAfter = await storageUsage();
      const downloadedBytes = usageBefore !== null && usageAfter !== null && usageAfter > usageBefore ? usageAfter - usageBefore : null;

      const prompt = buildLocalPrompt(payload);
      setPhase({ kind: "generating", chunks: 0 });
      const started = performance.now();
      const stream = await engine.current.chat.completions.create({
        messages: [{ role: "system", content: prompt.system }, { role: "user", content: prompt.user }],
        stream: true,
        stream_options: { include_usage: true },
        response_format: { type: "json_object", schema: JSON.stringify(ANALYSIS_RESPONSE_SCHEMA) },
        temperature: LOCAL_MODEL.temperature,
        max_tokens: LOCAL_MODEL.maxOutputTokens,
      });
      let text = "";
      let chunks = 0;
      let finishReason: string | null = null;
      let usage: { prompt_tokens?: number; completion_tokens?: number; extra?: { prefill_tokens_per_s?: number; decode_tokens_per_s?: number } } | undefined;
      for await (const chunk of stream) {
        text += chunk.choices[0]?.delta?.content ?? "";
        finishReason = chunk.choices[0]?.finish_reason ?? finishReason;
        if (chunk.usage) usage = chunk.usage as typeof usage;
        chunks += 1;
        if (chunks % 16 === 0) setPhase({ kind: "generating", chunks });
      }
      const stats: LocalRunStats = {
        modelId: LOCAL_MODEL.id,
        loadMs: loadMs.current,
        inferenceMs: performance.now() - started,
        inputTokens: usage?.prompt_tokens ?? null,
        outputTokens: usage?.completion_tokens ?? null,
        prefillTokensPerSecond: usage?.extra?.prefill_tokens_per_s ?? null,
        decodeTokensPerSecond: usage?.extra?.decode_tokens_per_s ?? null,
        finishReason,
      };
      setPhase({ kind: "validating" });
      const result = await finalizeLocalAnalysis(text, payload, stats);
      setPhase({ kind: "done", result, stats, downloadedBytes });
    } catch (error) {
      // A lost GPU device (driver reset, out of memory) leaves the engine unusable: discard it so a retry reloads.
      await engine.current?.unload().catch(() => undefined);
      engine.current = null;
      loadMs.current = null;
      const message = error instanceof Error ? error.message : String(error);
      setPhase({
        kind: "error",
        message: /device (was )?lost|GrammarMatcher|DEVICE_HUNG/i.test(message)
          ? `The graphics device stopped responding during local inference (${message}). The model has been unloaded; you can try again.`
          : message,
      });
    }
  };

  const busy = phase.kind === "loading" || phase.kind === "generating" || phase.kind === "validating";
  // Once past "idle", the model has been downloaded (or was cached) in this session.
  const modelAvailable = phase.kind === "idle" ? phase.cached : true;

  return (
    <section className="ai-local" aria-labelledby="local-ai-title">
      <header className="ai-local-head">
        <div>
          <p className="eyebrow">Proof of concept</p>
          <h3 id="local-ai-title">Local AI — running on your device</h3>
        </div>
        <span className="ai-local-model">{LOCAL_MODEL.label} · {LOCAL_MODEL.quantization.split(" ")[0]}</span>
      </header>
      <p className="ai-note">The profile data shown on this page is analysed in this browser. It is not sent to any AI provider; only the model files are downloaded once and cached.</p>

      {phase.kind === "checking" ? <p className="ai-note">Checking this device for WebGPU…</p> : null}
      {phase.kind === "unsupported" ? <div className="ai-state" role="status"><strong>Local AI unavailable on this device</strong><p>{phase.reason}</p></div> : null}
      {phase.kind === "error" ? <div className="ai-state error" role="alert"><strong>Local analysis failed</strong><p>{phase.message}</p></div> : null}

      {phase.kind !== "checking" && phase.kind !== "unsupported" ? (
        <div className="ai-toolbar">
          <button className="ai-generate-button" type="button" onClick={run} disabled={busy}>
            {busy ? "Working…" : modelAvailable ? "Run analysis on this device" : "Download AI model"}
          </button>
          {phase.kind === "idle" && !phase.cached ? <p className="ai-note">One-time download of about 0.9 GB; later runs use the browser cache.</p> : null}
        </div>
      ) : null}

      {phase.kind === "loading" ? (
        <div className="ai-state" role="status">
          <strong>Loading model · {Math.round(phase.progress * 100)}%</strong>
          <progress max={1} value={phase.progress} className="ai-progress" />
          <p>{phase.text}</p>
        </div>
      ) : null}
      {phase.kind === "generating" ? <div className="ai-state" role="status"><strong>Generating on this device…</strong><p>{phase.chunks} tokens so far.</p></div> : null}
      {phase.kind === "validating" ? <div className="ai-state" role="status"><strong>Checking the report against the evidence contract…</strong></div> : null}

      {phase.kind === "done" ? (
        <>
          <dl className="ai-meta ai-local-stats">
            <div><dt>Model</dt><dd>{phase.stats.modelId}</dd></div>
            <div><dt>Model load</dt><dd>{seconds(phase.stats.loadMs)}{phase.downloadedBytes ? ` · ${(phase.downloadedBytes / 1e9).toFixed(2)} GB cached` : ""}</dd></div>
            <div><dt>Inference</dt><dd>{seconds(phase.stats.inferenceMs)}</dd></div>
            <div><dt>Tokens in / out</dt><dd>{phase.stats.inputTokens ?? "—"} / {phase.stats.outputTokens ?? "—"}{phase.stats.finishReason === "length" ? " (output limit reached)" : ""}</dd></div>
            <div><dt>Speed</dt><dd>prefill {phase.stats.prefillTokensPerSecond?.toFixed(0) ?? "—"} · decode {phase.stats.decodeTokensPerSecond?.toFixed(1) ?? "—"} tokens/s</dd></div>
            <div><dt>Evidence contract</dt><dd>{phase.result.ok ? "Passed · 0 issues" : `Failed at ${phase.result.stage} · ${phase.result.issues} issue${phase.result.issues === 1 ? "" : "s"}`}</dd></div>
          </dl>
          {phase.result.ok ? <Report analysis={phase.result.analysis} /> : (
            <div className="ai-state error" role="alert">
              <strong>Report not shown</strong>
              <p>{phase.result.message}</p>
              <ul className="ai-local-violations">{phase.result.violations.slice(0, 12).map((violation, index) => <li key={index}>{violation}</li>)}</ul>
              {phase.result.violations.length > 12 ? <p>…and {phase.result.violations.length - 12} more.</p> : null}
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}
