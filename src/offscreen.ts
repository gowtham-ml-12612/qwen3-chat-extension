// Offscreen document: the only place wllama can run inside an MV3 extension.
// Service workers can't spawn the worker wllama needs, and normal extension
// pages' CSP blocks the blob: worker wllama creates — but offscreen documents
// run blob workers fine and expose WebGPU + DOM. So all model loading and
// inference happens here. We talk to the rest of the extension only through
// chrome.runtime messages relayed by the service worker.

import { Wllama } from "@wllama/wllama/esm/index.js";
import type { ChatCompletionMessage } from "@wllama/wllama/esm/index.js";
import { MODEL, DEFAULT_CONTEXT_TOKENS, CONTEXT_SIZES, isContextTokens, fallbackContextTokens } from "./models";
import { MODES, DEFAULT_MODE, type EffortMode, type ModeConfig } from "./modes";
import { stripThinking } from "./stripThinking";
import { buildSystemPrompt, SUMMARY_SYSTEM, buildSummaryUserPrompt } from "./prompts";
import {
  type Session,
  createSession,
  appendTurn,
  sessionTokens,
  planCompaction,
  applyCompaction,
  renderTranscript,
  estimateTokens,
  COMPACTION_WATERMARK,
  COMPACTION_TARGET,
} from "./session";
import type { EngineEvent, ToOffscreen } from "./messages";

let wllama: Wllama | undefined;
type LoadState = "idle" | "loading" | "ready" | "error";
let state: LoadState = "idle";
let loadError = "";
// Real context window, read from the model after load (falls back to config).
let ctxSize = MODEL.nCtx;
// Context size to load with. Changeable from the panel; a change while loaded
// triggers a reload, since the KV-cache is fixed at load time.
let requestedCtx = DEFAULT_CONTEXT_TOKENS;
// True when the last load fell back to a smaller size than requested (OOM).
let ctxFellBack = false;
// The context size that was originally requested before an OOM fallback.
let fallbackOriginalCtx = 0;
// Clients waiting for the model to finish loading (so we can broadcast progress).
const loadWaiters = new Set<number>();

// One conversation per connected tab; the engine owns and compacts it.
const sessions = new Map<number, Session>();

function getSession(clientId: number): Session {
  let s = sessions.get(clientId);
  if (!s) {
    s = createSession();
    sessions.set(clientId, s);
  }
  return s;
}

interface ChatJob {
  kind: "chat";
  clientId: number;
  reqId: string;
  text: string;
  mode: EffortMode;
  /** Base64 JPEG data URL (decoded to bytes here before inference). */
  image?: string;
}

// One step of the agent loop: a stateless generation (no session). Carries its
// own fully-built system + user prompts and the page screenshot.
interface AgentStepJob {
  kind: "agentStep";
  clientId: number;
  reqId: string;
  system: string;
  user: string;
  mode: EffortMode;
  image?: string;
}

type Job = ChatJob | AgentStepJob;

// Extension messaging is JSON-only, so the image arrives as a base64 data URL.
// Turn it back into the raw file bytes wllama's vision encoder expects.
function dataUrlToArrayBuffer(dataUrl: string): ArrayBuffer {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
const jobs: Job[] = [];
let draining = false;

// The job currently generating, so a Stop press can abort it mid-stream.
let current: { clientId: number; reqId: string; controller: AbortController } | undefined;

function relay(clientId: number, event: EngineEvent): void {
  if (event.kind !== "delta") {
    console.log(`[OS][relay] clientId=${clientId} kind="${event.kind}"`, JSON.stringify(event).slice(0, 300));
  }
  chrome.runtime.sendMessage({ to: "relay", clientId, ...event }).catch(() => {});
}

function broadcast(event: EngineEvent): void {
  if (event.kind !== "delta") {
    console.log(`[OS][broadcast] kind="${event.kind}" to ${loadWaiters.size} waiters`, JSON.stringify(event).slice(0, 300));
  }
  for (const id of loadWaiters) relay(id, event);
}

// ── Loading ───────────────────────────────────────────────────────────────────

async function ensureLoaded(clientId: number): Promise<void> {
  console.log(`[OS][ensureLoaded] clientId=${clientId} state="${state}" ctxSize=${ctxSize} requestedCtx=${requestedCtx}`);
  // Already loaded at the size the client wants — nothing to do.
  if (state === "ready" && ctxSize === requestedCtx) {
    console.log(`[OS][ensureLoaded] already ready at requested size, sending ready+loaded`);
    relay(clientId, { kind: "ready" });
    relay(clientId, {
      kind: "loaded",
      nCtx: ctxSize,
      fellBack: ctxFellBack,
      requestedCtx: ctxFellBack ? fallbackOriginalCtx : ctxSize,
    });
    return;
  }
  // Loaded, but the client asked for a different context size: reload.
  if (state === "ready" && ctxSize !== requestedCtx) {
    console.log(`[OS][ensureLoaded] ctx mismatch (loaded=${ctxSize} vs requested=${requestedCtx}) → reload`);
    await reload();
    return;
  }
  if (state === "error") {
    console.log(`[OS][ensureLoaded] in error state: "${loadError}"`);
    relay(clientId, { kind: "loaderror", message: loadError });
    return;
  }
  loadWaiters.add(clientId);
  relay(clientId, { kind: "progress", text: `Preparing ${MODEL.label}…`, progress: 0 });
  if (state === "loading") {
    console.log(`[OS][ensureLoaded] already loading, added client to waiters`);
    return;
  }
  console.log(`[OS][ensureLoaded] starting fresh load`);
  state = "loading";
  await doLoad();
}

// Change the context window the model runs with. A no-op if it matches the
// current request; otherwise records the new target and reloads when loaded.
async function setContextSize(clientId: number, tokens: number): Promise<void> {
  if (!isContextTokens(tokens)) return;
  if (tokens === requestedCtx && state === "ready" && ctxSize === tokens) {
    relay(clientId, {
      kind: "loaded",
      nCtx: ctxSize,
      fellBack: ctxFellBack,
      requestedCtx: ctxFellBack ? fallbackOriginalCtx : ctxSize,
    });
    return;
  }
  requestedCtx = tokens;
  // Subscribe every interested client so they all see reload progress/result.
  loadWaiters.add(clientId);
  if (state === "ready") {
    await reload();
  } else if (state === "idle" || state === "error") {
    state = "loading";
    await doLoad();
  }
  // If state === "loading", the in-flight load will pick up requestedCtx on its
  // next attempt; nothing to do here.
}

// Tear down the loaded model and load again at the current requestedCtx. The
// KV-cache is allocated at load, so this full reload is the only way to change
// context size. Aborts any in-flight generation first.
async function reload(): Promise<void> {
  if (current) {
    current.controller.abort();
    current = undefined;
  }
  try {
    await wllama?.exit();
  } catch {
    // Best effort — proceed to reload regardless.
  }
  wllama = undefined;
  state = "loading";
  broadcast({
    kind: "progress",
    text: `Switching to ${(requestedCtx / 1024).toFixed(0)}K context…`,
    progress: 0,
  });
  await doLoad();
}

// True when a thrown load error looks like an out-of-memory / wasm abort, the
// signature of the KV-cache failing to allocate at a large context size.
function isOomError(err: unknown): boolean {
  if (err instanceof Error && err.name === "RuntimeError") return true;
  const msg = err instanceof Error ? err.message : String(err);
  // "replace is not a function" happens when wllama's abort handler receives a
  // non-string message from the wasm engine during an OOM crash (upstream bug).
  if (msg.includes("replace is not a function")) return true;
  return /\(ABORT\)|out of memory|OOM|memory access out of bounds|allocation failed/i.test(msg);
}

// Load the model once at the given context size. Throws on failure so the caller
// can decide whether to retry smaller.
async function loadAt(nCtx: number): Promise<void> {
  // The wasm is copied to the extension root at build time (see package.json)
  // and loaded by its stable extension URL — no inline import map (which MV3's
  // CSP would block) and no hashed filename to track.
  wllama = new Wllama({ default: chrome.runtime.getURL("wllama.wasm") });

  const mb = (n: number) => (n / 1048576).toFixed(0);
  let lastWhole = -1;

  await wllama.loadModelFromHF(
    { repo: MODEL.repo, quant: MODEL.quant, mmprojFile: MODEL.mmprojFile },
    {
      n_ctx: nCtx,
      n_gpu_layers: 999, // offload everything to WebGPU when available
      jinja: true, // use the model's own chat template (places vision tokens)
      image_max_tokens: MODEL.imageMaxTokens,
      progressCallback: ({ loaded, total }) => {
        const pct = total > 0 ? loaded / total : 0;
        const whole = Math.floor(pct * 100);
        if (whole === lastWhole) return;
        lastWhole = whole;
        broadcast({
          kind: "progress",
          text:
            total > 0
              ? `Downloading ${MODEL.label} — ${mb(loaded)}/${mb(total)} MB (${whole}%)`
              : `Downloading ${MODEL.label}…`,
          progress: pct,
        });
      },
    },
  );
}

async function doLoad(): Promise<void> {
  console.log(`[OS][doLoad] ── BEGIN ── requestedCtx=${requestedCtx}`);
  const originalRequest = requestedCtx;
  let target = requestedCtx;
  ctxFellBack = false;
  fallbackOriginalCtx = 0;
  try {
    const MAX_FALLBACK_ATTEMPTS = CONTEXT_SIZES.length;
    let attempts = 0;
    for (;;) {
      if (++attempts > MAX_FALLBACK_ATTEMPTS) {
        throw new Error("Exhausted all context-size fallbacks without a successful load");
      }
      try {
        await loadAt(target);
        break;
      } catch (err) {
        if (!isOomError(err)) throw err;

        const smaller = fallbackContextTokens(target);
        // Clean up the partially-initialised instance before deciding.
        try {
          await wllama?.exit();
        } catch {
          /* best effort */
        }
        wllama = undefined;

        if (smaller === undefined) {
          // Even the smallest size (8K) failed — device can't run the model.
          throw new Error(
            "Not compatible — your device doesn't have enough memory to run this model. " +
            "Try closing other tabs or apps and reload.",
            { cause: err },
          );
        }

        ctxFellBack = true;
        fallbackOriginalCtx = originalRequest;
        broadcast({
          kind: "progress",
          text: `${(target / 1024).toFixed(0)}K didn't fit — retrying at ${(smaller / 1024).toFixed(0)}K…`,
          progress: 0,
        });
        target = smaller;
      }
    }

    requestedCtx = target;
    try {
      ctxSize = wllama?.getLoadedContextInfo().n_ctx || target;
    } catch {
      ctxSize = target;
    }

    console.log(`[OS][doLoad] ── SUCCESS ── ctxSize=${ctxSize} fellBack=${ctxFellBack} original=${originalRequest}`);
    state = "ready";
    broadcast({ kind: "ready" });
    broadcast({ kind: "loaded", nCtx: ctxSize, fellBack: ctxFellBack, requestedCtx: originalRequest });
  } catch (err) {
    state = "error";
    loadError = err instanceof Error ? err.message : String(err);
    console.error(`[OS][doLoad] ── FAILED ── ${loadError}`);
    broadcast({ kind: "loaderror", message: loadError });
  } finally {
    loadWaiters.clear();
  }
}

// ── Chat ────────────────────────────────────────────────────────────────────

function enqueue(job: Job): void {
  console.log(`[OS][enqueue] kind="${job.kind}" clientId=${job.clientId} reqId=${job.reqId} queueLen=${jobs.length} draining=${draining}`);
  jobs.push(job);
  if (!draining) void drain();
}

async function drain(): Promise<void> {
  console.log(`[OS][drain] ── START ── ${jobs.length} jobs queued`);
  draining = true;
  try {
    while (jobs.length) {
      const job = jobs.shift()!;
      console.log(`[OS][drain] processing: kind="${job.kind}" reqId=${job.reqId} remaining=${jobs.length}`);
      if (job.kind === "agentStep") await runAgentStep(job);
      else await runChat(job);
    }
  } finally {
    console.log(`[OS][drain] ── END ──`);
    draining = false;
  }
}

// A request runs as: assemble the prompt (system + running summary + recent
// turns + the new question), generate, then (for high-effort modes) verify and
// correct, looping until the verifier accepts or the iteration budget runs out.
// Today `verify` always accepts — see its note — so every mode runs a single
// generation; the loop is the seam where the future agent plugs in.

// Build the full message array the model sees: persona/rules, the running
// summary of older turns (if any), the recent verbatim turns, and — on a vision
// turn — the slide image attached to the latest user message.
function assembleMessages(
  session: Session,
  systemPrompt: string,
  image: string | undefined,
): ChatCompletionMessage[] {
  const msgs: ChatCompletionMessage[] = [{ role: "system", content: systemPrompt }];
  if (session.summary) {
    msgs.push({
      role: "system",
      content: `Conversation memory so far (structured notes from earlier in this chat):\n${session.summary}`,
    });
  }
  const turns = session.turns;
  turns.forEach((turn, i) => {
    const isCurrent = i === turns.length - 1;
    if (isCurrent && turn.role === "user" && image) {
      msgs.push({
        role: "user",
        content: [
          { type: "image", data: dataUrlToArrayBuffer(image) },
          { type: "text", text: turn.text },
        ],
      });
    } else {
      msgs.push({ role: turn.role, content: turn.text });
    }
  });
  return msgs;
}

interface GenResult {
  text: string;
  aborted: boolean;
}

// One streamed generation. Relays deltas as they arrive and returns the final
// (thinking-stripped) text. A Stop is surfaced as a flag, not an exception, so
// callers keep whatever was produced before it.
async function generate(
  job: { clientId: number; reqId: string },
  cfg: ModeConfig,
  messages: ChatCompletionMessage[],
  signal: AbortSignal,
): Promise<GenResult> {
  console.log(`[OS][generate] ── BEGIN ── reqId=${job.reqId} msgCount=${messages.length} maxTokens=${cfg.maxTokens} thinking=${cfg.thinking}`);
  let acc = "";
  try {
    const stream = await wllama!.createChatCompletion({
      messages,
      stream: true,
      max_tokens: cfg.maxTokens,
      temperature: 0.3,
      abortSignal: signal,
      ...(cfg.thinking ? {} : { chat_template_kwargs: { enable_thinking: false } }),
    });
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        acc += delta;
        relay(job.clientId, { kind: "delta", reqId: job.reqId, text: stripThinking(acc) });
      }
    }
    console.log(`[OS][generate] ── END ── reqId=${job.reqId} accLen=${acc.length} strippedLen=${stripThinking(acc).length}`);
    return { text: stripThinking(acc), aborted: false };
  } catch (err) {
    if (signal.aborted || (err instanceof Error && err.name === "AbortError")) {
      console.log(`[OS][generate] ── ABORTED ── reqId=${job.reqId} accLen=${acc.length}`);
      return { text: stripThinking(acc), aborted: true };
    }
    console.error(`[OS][generate] ── ERROR ── reqId=${job.reqId}`, err);
    throw err;
  }
}

interface Verdict {
  accepted: boolean;
  /** Instruction for the next pass, used only when not accepted. */
  feedback: string;
}

// The agent's critic. Once action tools + acceptance criteria exist (reading the
// slide's object model back), this is where Forge decides whether the result
// matches the user's prompt and, if not, what to fix. Until then there's nothing
// to check, so it accepts immediately and the loop runs a single pass.
async function verify(_job: ChatJob, _answer: string): Promise<Verdict> {
  return { accepted: true, feedback: "" };
}

// Fold the given turns (plus the existing summary) into one updated summary via a
// cheap, no-stream model call. Returns null on failure so the caller keeps the
// full turns rather than silently dropping context.
async function summarize(
  previousSummary: string,
  fold: Session["turns"],
  signal: AbortSignal,
): Promise<string | null> {
  try {
    const res = await wllama!.createChatCompletion({
      messages: [
        { role: "system", content: SUMMARY_SYSTEM },
        { role: "user", content: buildSummaryUserPrompt(previousSummary, renderTranscript(fold)) },
      ],
      stream: false,
      // A touch more room than a freeform summary: the structured schema has four
      // sections to fill. Still bounded, so the running memory can't grow forever.
      max_tokens: 512,
      temperature: 0.2,
      abortSignal: signal,
      chat_template_kwargs: { enable_thinking: false },
    });
    const text = stripThinking(res.choices[0]?.message?.content ?? "");
    return text || null;
  } catch {
    return null;
  }
}

// Recursion guard: `summarize` below is a plain model call that never touches a
// Session, so compaction can't recurse into itself; this flag additionally keeps
// two compactions from overlapping if jobs ever interleave.
let compacting = false;

// Compute the history budget (tokens available for summary + turns) and emit a
// context-usage event so the panel can update its progress ring.
function historyBudgetFor(
  cfg: ModeConfig,
  systemPrompt: string,
  hasImage: boolean,
): number {
  const reserve =
    estimateTokens(systemPrompt) + (hasImage ? MODEL.imageMaxTokens : 0) + cfg.maxTokens + 256;
  return Math.max(512, ctxSize - reserve);
}

function emitContextUsage(
  clientId: number,
  session: Session,
  budget: number,
  phase: "ok" | "compacting" | "compacted",
): void {
  const used = sessionTokens(session);
  relay(clientId, {
    kind: "context",
    ratio: budget > 0 ? used / budget : 0,
    used,
    budget,
    total: ctxSize,
    phase,
  });
}

// Compact the session when it nears the context budget by summarizing its oldest
// turns. `historyBudget` is the room left for the conversation (summary + turns)
// after reserving the system prompt, the image (vision turns), the model's reply,
// and a safety margin. We trigger at WATERMARK (early, so the model has space to
// write a good summary) and compact down to TARGET (so we don't summarize again
// next turn).
async function maybeCompact(
  session: Session,
  cfg: ModeConfig,
  job: ChatJob,
  systemPrompt: string,
  signal: AbortSignal,
): Promise<void> {
  if (compacting) { console.log("[OS][maybeCompact] already compacting, skipping"); return; }

  const budget = historyBudgetFor(cfg, systemPrompt, !!job.image);
  const tokens = sessionTokens(session);
  const watermark = budget * COMPACTION_WATERMARK;
  console.log(`[OS][maybeCompact] tokens=${tokens} budget=${budget} watermark=${watermark.toFixed(0)} needsCompaction=${tokens > watermark}`);
  if (tokens <= watermark) return;

  const plan = planCompaction(session, Math.floor(budget * COMPACTION_TARGET));
  console.log(`[OS][maybeCompact] plan: fold=${plan.fold.length} keep=${plan.keep.length}`);
  if (plan.fold.length === 0) return;

  compacting = true;
  emitContextUsage(job.clientId, session, budget, "compacting");
  relay(job.clientId, {
    kind: "status",
    reqId: job.reqId,
    text: "Summarizing earlier conversation…",
  });
  try {
    console.log("[OS][maybeCompact] summarizing…");
    const summary = await summarize(session.summary, plan.fold, signal);
    if (summary) {
      console.log(`[OS][maybeCompact] summary produced (${summary.length} chars), applying compaction`);
      applyCompaction(session, summary, plan.keep);
    } else {
      console.warn("[OS][maybeCompact] summarization returned null, keeping full turns");
    }
    emitContextUsage(job.clientId, session, budget, "compacted");
  } finally {
    compacting = false;
  }
}

async function runChat(job: ChatJob): Promise<void> {
  const { clientId, reqId } = job;
  const cfg = MODES[job.mode] ?? MODES[DEFAULT_MODE];
  console.log(`[OS][runChat] ── BEGIN ── reqId=${reqId} clientId=${clientId} mode=${job.mode} hasImage=${!!job.image} textLen=${job.text.length}`);
  console.log(`[OS][runChat] text (first 300): "${job.text.slice(0, 300)}"`);
  console.log(`[OS][runChat] cfg: maxTokens=${cfg.maxTokens} maxIterations=${cfg.maxIterations} thinking=${cfg.thinking}`);
  const controller = new AbortController();
  current = { clientId, reqId, controller };
  try {
    await ensureLoaded(clientId);
    if (state !== "ready" || !wllama) {
      console.error(`[OS][runChat] model not ready: state="${state}" loadError="${loadError}"`);
      relay(clientId, { kind: "error", reqId, message: loadError || "Model not loaded" });
      return;
    }

    const session = getSession(clientId);
    console.log(`[OS][runChat] session: turns=${session.turns.length} summaryLen=${session.summary.length} tokens=${sessionTokens(session)}`);
    appendTurn(session, "user", job.text);

    const systemPrompt = buildSystemPrompt(job.mode);
    console.log(`[OS][runChat] systemPrompt length=${systemPrompt.length}`);
    await maybeCompact(session, cfg, job, systemPrompt, controller.signal);

    relay(clientId, {
      kind: "status",
      reqId,
      text: job.image ? "Analysing the page…" : "Thinking…",
    });

    const messages = assembleMessages(session, systemPrompt, job.image);
    console.log(`[OS][runChat] assembled ${messages.length} messages for generation`);
    let result = await generate(job, cfg, messages, controller.signal);
    console.log(`[OS][runChat] generation done: aborted=${result.aborted} textLen=${result.text.length}`);

    // Verify→correct loop (Forge). Bounded by cfg.maxIterations and Stop.
    for (let pass = 1; pass < cfg.maxIterations && !result.aborted; pass++) {
      console.log(`[OS][runChat] verify pass ${pass}…`);
      const verdict = await verify(job, result.text);
      if (verdict.accepted || controller.signal.aborted) {
        console.log(`[OS][runChat] verify pass ${pass}: accepted=${verdict.accepted}`);
        break;
      }
      relay(clientId, { kind: "status", reqId, text: `Refining (pass ${pass + 1})…` });
      const refine = assembleMessages(session, systemPrompt, job.image);
      refine.push({ role: "assistant", content: result.text });
      refine.push({ role: "user", content: verdict.feedback });
      result = await generate(job, cfg, refine, controller.signal);
    }

    if (result.text) appendTurn(session, "assistant", result.text);

    const budget = historyBudgetFor(cfg, systemPrompt, !!job.image);
    emitContextUsage(clientId, session, budget, "ok");

    const text = result.text || (result.aborted ? "(stopped)" : "(no answer)");
    console.log(`[OS][runChat] ── END ── reqId=${reqId} finalTextLen=${text.length}`);
    relay(clientId, { kind: "done", reqId, text });
  } catch (err) {
    // A wasm RuntimeError / "(ABORT)" is a native crash — almost always the
    // vision encoder running out of memory on a large slide. Translate it into
    // something the user can act on instead of the raw "(ABORT)".
    const raw = err instanceof Error ? err.message : String(err);
    const fatal = (err instanceof Error && err.name === "RuntimeError") || raw.includes("(ABORT)");
    relay(clientId, {
      kind: "error",
      reqId,
      message: fatal
        ? "Ran out of memory reading this slide. Try Focus or Flash mode, or a simpler slide."
        : raw,
    });
  } finally {
    if (current?.reqId === reqId) current = undefined;
  }
}

// ── Agent step ────────────────────────────────────────────────────────────────
//
// A single, stateless decision in the browser-agent loop. The orchestrator (side
// panel) owns the agent's working memory and passes a fully-built system + user
// prompt plus the current screenshot; we just generate the model's next-action
// JSON and stream it back. Crucially this never touches a Session, so the agent's
// many intermediate reasoning steps don't pollute conversational memory.
async function runAgentStep(job: AgentStepJob): Promise<void> {
  const { clientId, reqId } = job;
  const cfg = MODES[job.mode] ?? MODES[DEFAULT_MODE];
  console.log(`[OS][runAgentStep] ── BEGIN ── reqId=${reqId} clientId=${clientId} mode=${job.mode} hasImage=${!!job.image}`);
  console.log(`[OS][runAgentStep] system (${job.system.length} chars): "${job.system.slice(0, 200)}…"`);
  console.log(`[OS][runAgentStep] user (${job.user.length} chars): "${job.user.slice(0, 300)}…"`);
  const controller = new AbortController();
  current = { clientId, reqId, controller };
  try {
    await ensureLoaded(clientId);
    if (state !== "ready" || !wllama) {
      console.error(`[OS][runAgentStep] model not ready: state="${state}"`);
      relay(clientId, { kind: "error", reqId, message: loadError || "Model not loaded" });
      return;
    }

    const userContent: ChatCompletionMessage["content"] = job.image
      ? [
          { type: "image", data: dataUrlToArrayBuffer(job.image) },
          { type: "text", text: job.user },
        ]
      : job.user;

    const messages: ChatCompletionMessage[] = [
      { role: "system", content: job.system },
      { role: "user", content: userContent },
    ];

    console.log(`[OS][runAgentStep] generating with ${messages.length} messages…`);
    const result = await generate(job, cfg, messages, controller.signal);
    const text = result.text || (result.aborted ? "(stopped)" : "");
    console.log(`[OS][runAgentStep] ── END ── reqId=${reqId} aborted=${result.aborted} textLen=${text.length} text="${text.slice(0, 200)}"`);
    relay(clientId, { kind: "done", reqId, text });
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const fatal = (err instanceof Error && err.name === "RuntimeError") || raw.includes("(ABORT)");
    relay(clientId, {
      kind: "error",
      reqId,
      message: fatal
        ? "Ran out of memory reading the page. Try Focus or Flash mode."
        : raw,
    });
  } finally {
    if (current?.reqId === reqId) current = undefined;
  }
}

// ── Message handling ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg: ToOffscreen | { to?: string }) => {
  if (!msg || (msg as { to?: string }).to !== "offscreen") return;
  const m = msg as ToOffscreen;
  console.log(`[OS][onMessage] cmd="${m.cmd}" clientId=${m.clientId}`, m.cmd === "chat" ? `reqId=${(m as ChatJob).reqId} mode=${(m as ChatJob).mode}` : m.cmd === "agentStep" ? `reqId=${(m as AgentStepJob).reqId}` : "");
  switch (m.cmd) {
    case "load":
      if (isContextTokens(m.nCtx)) {
        console.log(`[OS][onMessage] load with nCtx=${m.nCtx}`);
        void setContextSize(m.clientId, m.nCtx);
      } else {
        console.log(`[OS][onMessage] load (default ctx)`);
        void ensureLoaded(m.clientId);
      }
      break;
    case "chat":
      enqueue({
        kind: "chat",
        clientId: m.clientId,
        reqId: m.reqId,
        text: m.text,
        mode: m.mode,
        image: m.image,
      });
      break;
    case "agentStep":
      enqueue({
        kind: "agentStep",
        clientId: m.clientId,
        reqId: m.reqId,
        system: m.system,
        user: m.user,
        mode: m.mode,
        image: m.image,
      });
      break;
    case "reset":
      console.log(`[OS][onMessage] reset — clearing session for clientId=${m.clientId}`);
      sessions.delete(m.clientId);
      break;
    case "injectContext": {
      console.log(`[OS][onMessage] injectContext clientId=${m.clientId} userText=${m.userText?.length ?? 0} chars, assistantText=${m.assistantText?.length ?? 0} chars`);
      const s = getSession(m.clientId);
      if (m.userText) appendTurn(s, "user", m.userText);
      if (m.assistantText) appendTurn(s, "assistant", m.assistantText);
      break;
    }
    case "abort":
      console.log(`[OS][onMessage] abort reqId=${m.reqId} — current=${current?.reqId} match=${current?.reqId === m.reqId}`);
      if (current && current.clientId === m.clientId && current.reqId === m.reqId) {
        current.controller.abort();
      }
      for (let i = jobs.length - 1; i >= 0; i--) {
        if (jobs[i].clientId === m.clientId) jobs.splice(i, 1);
      }
      break;
    case "disconnect":
      console.log(`[OS][onMessage] disconnect clientId=${m.clientId}`);
      if (current && current.clientId === m.clientId) current.controller.abort();
      for (let i = jobs.length - 1; i >= 0; i--) {
        if (jobs[i].clientId === m.clientId) jobs.splice(i, 1);
      }
      sessions.delete(m.clientId);
      break;
  }
});

// Keep the ephemeral service worker awake so it can relay our messages during
// long silent stretches (model compile, image prefill). Cheap, and it stops
// when the offscreen document is closed.
setInterval(() => {
  chrome.runtime.sendMessage({ to: "keepalive" }).catch(() => {});
}, 20000);
