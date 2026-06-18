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
  clientId: number;
  reqId: string;
  text: string;
  mode: EffortMode;
  /** Base64 JPEG data URL (decoded to bytes here before inference). */
  image?: string;
}

// Extension messaging is JSON-only, so the image arrives as a base64 data URL.
// Turn it back into the raw file bytes wllama's vision encoder expects.
function dataUrlToArrayBuffer(dataUrl: string): ArrayBuffer {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
const jobs: ChatJob[] = [];
let draining = false;

// The job currently generating, so a Stop press can abort it mid-stream.
let current: { clientId: number; reqId: string; controller: AbortController } | undefined;

function relay(clientId: number, event: EngineEvent): void {
  chrome.runtime.sendMessage({ to: "relay", clientId, ...event }).catch(() => {});
}

function broadcast(event: EngineEvent): void {
  for (const id of loadWaiters) relay(id, event);
}

// ── Loading ───────────────────────────────────────────────────────────────────

async function ensureLoaded(clientId: number): Promise<void> {
  // Already loaded at the size the client wants — nothing to do.
  if (state === "ready" && ctxSize === requestedCtx) {
    relay(clientId, { kind: "ready" });
    relay(clientId, { kind: "loaded", nCtx: ctxSize, fellBack: ctxFellBack });
    return;
  }
  // Loaded, but the client asked for a different context size: reload.
  if (state === "ready" && ctxSize !== requestedCtx) {
    await reload();
    return;
  }
  if (state === "error") {
    relay(clientId, { kind: "loaderror", message: loadError });
    return;
  }
  loadWaiters.add(clientId);
  relay(clientId, { kind: "progress", text: `Preparing ${MODEL.label}…`, progress: 0 });
  if (state === "loading") return; // already in flight; this client now subscribed
  state = "loading";
  await doLoad();
}

// Change the context window the model runs with. A no-op if it matches the
// current request; otherwise records the new target and reloads when loaded.
async function setContextSize(clientId: number, tokens: number): Promise<void> {
  if (!isContextTokens(tokens)) return;
  if (tokens === requestedCtx && state === "ready" && ctxSize === tokens) {
    relay(clientId, { kind: "loaded", nCtx: ctxSize, fellBack: ctxFellBack });
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
  // Walk down through context sizes on OOM: try the requested size, and if the
  // KV-cache won't allocate, fall back to the next smaller one rather than
  // leaving the panel with no model. Non-OOM errors surface immediately.
  let target = requestedCtx;
  ctxFellBack = false;
  try {
    // Guard: at most CONTEXT_SIZES.length attempts (one per available size).
    // Prevents infinite loops if the fallback chain is ever misconfigured.
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
        const smaller = fallbackContextTokens(target);
        if (isOomError(err) && smaller !== undefined) {
          // Clean up the partially-initialised instance before retrying.
          try {
            await wllama?.exit();
          } catch {
            /* best effort */
          }
          wllama = undefined;
          ctxFellBack = true;
          broadcast({
            kind: "progress",
            text: `${(target / 1024).toFixed(0)}K didn't fit — retrying at ${(smaller / 1024).toFixed(0)}K…`,
            progress: 0,
          });
          target = smaller;
          continue;
        }
        throw err;
      }
    }

    // Reflect the size we actually settled on, so a later switch compares right.
    requestedCtx = target;
    try {
      ctxSize = wllama?.getLoadedContextInfo().n_ctx || target;
    } catch {
      ctxSize = target;
    }

    state = "ready";
    broadcast({ kind: "ready" });
    broadcast({ kind: "loaded", nCtx: ctxSize, fellBack: ctxFellBack });
  } catch (err) {
    state = "error";
    loadError = err instanceof Error ? err.message : String(err);
    broadcast({ kind: "loaderror", message: loadError });
  } finally {
    loadWaiters.clear();
  }
}

// ── Chat ────────────────────────────────────────────────────────────────────

function enqueue(job: ChatJob): void {
  jobs.push(job);
  if (!draining) void drain();
}

async function drain(): Promise<void> {
  draining = true;
  try {
    while (jobs.length) {
      await runChat(jobs.shift()!);
    }
  } finally {
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
  job: ChatJob,
  cfg: ModeConfig,
  messages: ChatCompletionMessage[],
  signal: AbortSignal,
): Promise<GenResult> {
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
    return { text: stripThinking(acc), aborted: false };
  } catch (err) {
    if (signal.aborted || (err instanceof Error && err.name === "AbortError")) {
      return { text: stripThinking(acc), aborted: true };
    }
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
  if (compacting) return;

  const budget = historyBudgetFor(cfg, systemPrompt, !!job.image);
  if (sessionTokens(session) <= budget * COMPACTION_WATERMARK) return;

  const plan = planCompaction(session, Math.floor(budget * COMPACTION_TARGET));
  if (plan.fold.length === 0) return;

  compacting = true;
  emitContextUsage(job.clientId, session, budget, "compacting");
  relay(job.clientId, {
    kind: "status",
    reqId: job.reqId,
    text: "Summarizing earlier conversation…",
  });
  try {
    const summary = await summarize(session.summary, plan.fold, signal);
    if (summary) applyCompaction(session, summary, plan.keep);
    emitContextUsage(job.clientId, session, budget, "compacted");
  } finally {
    compacting = false;
  }
}

async function runChat(job: ChatJob): Promise<void> {
  const { clientId, reqId } = job;
  const cfg = MODES[job.mode] ?? MODES[DEFAULT_MODE];
  const controller = new AbortController();
  current = { clientId, reqId, controller };
  try {
    await ensureLoaded(clientId);
    if (state !== "ready" || !wllama) {
      relay(clientId, { kind: "error", reqId, message: loadError || "Model not loaded" });
      return;
    }

    const session = getSession(clientId);
    appendTurn(session, "user", job.text);

    const systemPrompt = buildSystemPrompt(job.mode);
    await maybeCompact(session, cfg, job, systemPrompt, controller.signal);

    relay(clientId, {
      kind: "status",
      reqId,
      text: job.image ? "Reading the slide…" : "Thinking…",
    });

    let result = await generate(
      job,
      cfg,
      assembleMessages(session, systemPrompt, job.image),
      controller.signal,
    );

    // Verify→correct loop (Forge). Bounded by cfg.maxIterations and Stop.
    for (let pass = 1; pass < cfg.maxIterations && !result.aborted; pass++) {
      const verdict = await verify(job, result.text);
      if (verdict.accepted || controller.signal.aborted) break;
      relay(clientId, { kind: "status", reqId, text: `Refining (pass ${pass + 1})…` });
      const refine = assembleMessages(session, systemPrompt, job.image);
      refine.push({ role: "assistant", content: result.text });
      refine.push({ role: "user", content: verdict.feedback });
      result = await generate(job, cfg, refine, controller.signal);
    }

    // Record what the user actually saw (partial answers included) so the next
    // turn has correct context.
    if (result.text) appendTurn(session, "assistant", result.text);

    // Report updated context usage after the turn lands.
    const budget = historyBudgetFor(cfg, systemPrompt, !!job.image);
    emitContextUsage(clientId, session, budget, "ok");

    const text = result.text || (result.aborted ? "(stopped)" : "(no answer)");
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

// ── Message handling ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg: ToOffscreen | { to?: string }) => {
  if (!msg || (msg as { to?: string }).to !== "offscreen") return;
  const m = msg as ToOffscreen;
  switch (m.cmd) {
    case "load":
      // An explicit size on load selects the context window before first load,
      // or reloads if it differs from what's already loaded.
      if (isContextTokens(m.nCtx)) {
        void setContextSize(m.clientId, m.nCtx);
      } else {
        void ensureLoaded(m.clientId);
      }
      break;
    case "chat":
      enqueue({
        clientId: m.clientId,
        reqId: m.reqId,
        text: m.text,
        mode: m.mode,
        image: m.image,
      });
      break;
    case "reset":
      // New chat: forget this tab's conversation context.
      sessions.delete(m.clientId);
      break;
    case "abort":
      // Stop this client's in-flight generation if it's the one named…
      if (current && current.clientId === m.clientId && current.reqId === m.reqId) {
        current.controller.abort();
      }
      // …and drop any of its still-queued jobs.
      for (let i = jobs.length - 1; i >= 0; i--) {
        if (jobs[i].clientId === m.clientId) jobs.splice(i, 1);
      }
      break;
    case "disconnect":
      // Tab closed: abort its in-flight job, drop its queued ones, free its session.
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
