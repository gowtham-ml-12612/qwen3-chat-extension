import { ENGINE_PORT, type EngineEvent } from "./messages";
import {
  MODEL_LABEL,
  CONTEXT_SIZES,
  DEFAULT_CONTEXT_TOKENS,
  isContextTokens,
} from "./models";
import { MODES, DEFAULT_MODE, EFFORT_MODES, isEffortMode, type EffortMode } from "./modes";
import { PANEL_CSS } from "./panel-styles";

interface HistoryTurn {
  role: "user" | "assistant";
  text: string;
}

// ── Create host element + shadow root ────────────────────────────────────────

const PANEL_W = 400;
const PANEL_H = 560;
const MIN_W = 320;
const MIN_H = 400;

const host = document.createElement("div");
host.id = "__qwen_chat_host__";
Object.assign(host.style, {
  position: "fixed",
  bottom: "24px",
  right: "24px",
  width: `${PANEL_W}px`,
  height: `${PANEL_H}px`,
  zIndex: "2147483647",
  display: "none",
  border: "none",
  padding: "0",
  margin: "0",
  background: "transparent",
});
(document.body ?? document.documentElement).appendChild(host);

const shadow = host.attachShadow({ mode: "open" });

shadow.innerHTML = `
<style>${PANEL_CSS}</style>

<div class="panel">
  <header id="drag-handle">
    <div class="header-row">
      <h1>Qwen Chat</h1>
      <div class="hbtns">
        <button class="ibtn" id="new-chat-btn" title="New chat" disabled>↺</button>
        <button class="ibtn" id="copy-btn" title="Copy conversation log" disabled>⧉</button>
        <button class="ibtn" id="close-btn" title="Close">✕</button>
      </div>
    </div>
    <div class="modes" id="mode-switch" role="tablist" aria-label="Effort mode"></div>
    <div class="ctx-row">
      <label class="ctx-label" for="ctx-select" title="Context window — how much conversation the model can hold. Changing it reloads the model.">Context</label>
      <select id="ctx-select" class="ctx-select" title="Context window size — larger holds more but uses more memory; changing it reloads the model" disabled></select>
    </div>
    <div class="status-row">
      <div id="status">Loading model…</div>
      <div class="ctx-ring-wrap" id="ctx-ring-wrap" title="Context usage">
        <svg class="ctx-ring" viewBox="0 0 36 36">
          <circle class="ctx-ring-bg" cx="18" cy="18" r="15.5" />
          <circle class="ctx-ring-fg" id="ctx-ring-fg" cx="18" cy="18" r="15.5" />
        </svg>
        <span class="ctx-ring-pct" id="ctx-ring-pct"></span>
      </div>
    </div>
    <progress id="load-progress" max="1" value="0"></progress>
  </header>

  <main id="messages">
    <div id="welcome">
      <div class="welcome-icon">✦</div>
      <h2>Qwen Chat</h2>
      <p>Ask about your slides, get analysis, or chat about your presentation.</p>
    </div>
  </main>

  <footer>
    <textarea id="input" rows="2" placeholder="Message Qwen…" disabled></textarea>
    <button id="send-btn" disabled>Send</button>
    <button id="stop-btn" hidden>Stop</button>
  </footer>

  <div class="rh rh-n" data-dir="n"></div>
  <div class="rh rh-s" data-dir="s"></div>
  <div class="rh rh-e" data-dir="e"></div>
  <div class="rh rh-w" data-dir="w"></div>
  <div class="rh rh-ne" data-dir="ne"></div>
  <div class="rh rh-nw" data-dir="nw"></div>
  <div class="rh rh-se" data-dir="se"></div>
  <div class="rh rh-sw" data-dir="sw"></div>
</div>
`;

// ── DOM refs ──────────────────────────────────────────────────────────────────

const q = <T extends HTMLElement>(id: string) => shadow.getElementById(id) as T;
const statusEl   = q("status");
const progressEl = q<HTMLProgressElement>("load-progress");
const messagesEl = q("messages");
const inputEl    = q<HTMLTextAreaElement>("input");
const sendBtn    = q<HTMLButtonElement>("send-btn");
const stopBtn    = q<HTMLButtonElement>("stop-btn");
const newChatBtn     = q<HTMLButtonElement>("new-chat-btn");
const copyBtn        = q<HTMLButtonElement>("copy-btn");
const closeBtn       = q<HTMLButtonElement>("close-btn");
const dragHandle     = q("drag-handle");
const modeSwitchEl   = q("mode-switch");
const ctxSelectEl    = q<HTMLSelectElement>("ctx-select");
const welcomeEl      = q("welcome");
const ctxRingWrap    = q("ctx-ring-wrap");
const ctxRingFg      = shadow.getElementById("ctx-ring-fg") as unknown as SVGCircleElement;
const ctxRingPct     = q("ctx-ring-pct");

// ── State ─────────────────────────────────────────────────────────────────────

let chatHistory: HistoryTurn[] = [];
let busy = false;
let modelReady = false;
let loadStarted = false;

// A chat request is in flight (capturing and/or generating). Drives the
// Send↔Stop swap and lets the user cancel.
let generating = false;
let stopRequested = false;
let activeReqId: string | undefined;

// Selected effort tier (Flash/Focus/Forge); persisted across sessions.
let mode: EffortMode = DEFAULT_MODE;
const modeBtns = new Map<EffortMode, HTMLButtonElement>();

// Chosen context-window size (tokens); persisted. This is the size we REQUEST;
// the size actually in effect (after any OOM fallback) is `activeCtx`, set from
// the engine's `loaded` event.
let ctxTokens = DEFAULT_CONTEXT_TOKENS;
let activeCtx = DEFAULT_CONTEXT_TOKENS;

let port: chrome.runtime.Port | undefined;

interface Pending {
  onStatus: (text: string) => void;
  onDelta: (text: string) => void;
  resolve: (text: string) => void;
  reject: (err: Error) => void;
}
const pending = new Map<string, Pending>();

// ── Helpers ───────────────────────────────────────────────────────────────────

function setReady(ready: boolean) {
  modelReady = ready;
  inputEl.disabled = !ready;
  newChatBtn.disabled = !ready || busy;
  copyBtn.disabled = chatHistory.length === 0;
  sendBtn.disabled = !ready || busy || inputEl.value.trim() === "";
  // While a request runs, swap Send for a live Stop button.
  sendBtn.hidden = generating;
  stopBtn.hidden = !generating;
}

function setIdleStatus() {
  statusEl.textContent = `${MODEL_LABEL} · ${MODES[mode].label} · ${(activeCtx / 1024).toFixed(0)}K`;
}

// ── Context-window usage ring ─────────────────────────────────────────────────
// A small circular progress indicator showing how full the context window is.
// Grows from 0 → watermark (green → yellow → red). Pulses while compacting.

const RING_CIRCUMFERENCE = 2 * Math.PI * 15.5; // r=15.5 matches the SVG
ctxRingFg.style.strokeDasharray = `${RING_CIRCUMFERENCE}`;
ctxRingFg.style.strokeDashoffset = `${RING_CIRCUMFERENCE}`;

function updateContextRing(
  ratio: number,
  used: number,
  budget: number,
  phase: "ok" | "compacting" | "compacted",
) {
  // Clamp for display
  const clamped = Math.max(0, Math.min(ratio, 1));
  const pct = Math.round(clamped * 100);

  // Stroke offset: full circle = hidden, 0 = full ring
  const offset = RING_CIRCUMFERENCE * (1 - clamped);
  ctxRingFg.style.strokeDashoffset = `${offset}`;

  // Color: green → yellow → orange → red
  let color: string;
  if (clamped < 0.5) {
    color = "var(--green)";
  } else if (clamped < 0.7) {
    color = "var(--ctx-yellow)";
  } else if (clamped < 0.85) {
    color = "var(--ctx-orange)";
  } else {
    color = "var(--red)";
  }
  ctxRingFg.style.stroke = color;

  // Percentage label
  ctxRingPct.textContent = `${pct}`;

  // Tooltip
  ctxRingWrap.title = `Context: ${used.toLocaleString()} / ${budget.toLocaleString()} tokens (${pct}%)`;

  // Pulse animation while compacting
  ctxRingWrap.classList.toggle("compacting", phase === "compacting");

  // Brief flash on compacted
  if (phase === "compacted") {
    ctxRingWrap.classList.add("compacted");
    setTimeout(() => ctxRingWrap.classList.remove("compacted"), 1500);
  }

  // Show the ring once we have data (hidden on fresh/empty chats)
  ctxRingWrap.classList.add("visible");
}

function resetContextRing() {
  ctxRingFg.style.strokeDashoffset = `${RING_CIRCUMFERENCE}`;
  ctxRingFg.style.stroke = "var(--green)";
  ctxRingPct.textContent = "";
  ctxRingWrap.title = "Context usage";
  ctxRingWrap.classList.remove("visible", "compacting", "compacted");
}

// ── Effort mode (Flash / Focus / Forge) ───────────────────────────────────────

const MODE_STORAGE_KEY = "qwenEffortMode";

function renderModeSwitch() {
  for (const id of EFFORT_MODES) {
    const cfg = MODES[id];
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mode";
    btn.dataset.mode = id;
    btn.textContent = cfg.label;
    btn.title = cfg.hint;
    btn.setAttribute("role", "tab");
    btn.addEventListener("click", () => setMode(id));
    modeSwitchEl.appendChild(btn);
    modeBtns.set(id, btn);
  }
}

function reflectMode() {
  for (const [id, btn] of modeBtns) {
    const active = id === mode;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  }
  if (modelReady && !generating) setIdleStatus();
}

function setMode(next: EffortMode) {
  if (next === mode) return;
  mode = next;
  reflectMode();
  chrome.storage?.local?.set({ [MODE_STORAGE_KEY]: next });
}

function loadMode() {
  chrome.storage?.local?.get(MODE_STORAGE_KEY, (res) => {
    const stored = res?.[MODE_STORAGE_KEY];
    if (isEffortMode(stored)) mode = stored;
    reflectMode();
  });
}

// ── Context window (8K / 16K / 32K) ────────────────────────────────────────────
// Unlike effort mode, changing this is NOT instant: the engine must reload the
// model (the KV-cache is fixed at load). So switching shows load progress and
// the picker is disabled while a switch is in flight.

const CTX_STORAGE_KEY = "qwenContextTokens";

function renderCtxSelect() {
  for (const opt of CONTEXT_SIZES) {
    const o = document.createElement("option");
    o.value = String(opt.tokens);
    o.textContent = opt.label;
    o.title = opt.hint;
    ctxSelectEl.appendChild(o);
  }
  ctxSelectEl.value = String(ctxTokens);
  ctxSelectEl.addEventListener("change", () => {
    const next = Number(ctxSelectEl.value);
    if (isContextTokens(next)) setCtx(next);
  });
}

// Reflect the dropdown to a given token value (used after load/fallback so the
// UI shows what's actually in effect, not just what was requested).
function reflectCtx(tokens: number) {
  if (isContextTokens(tokens)) ctxSelectEl.value = String(tokens);
}

// Request a context-size change: persist it, then ask the engine to (re)load at
// the new size. The dropdown is locked until the engine reports back.
function setCtx(next: number) {
  if (next === ctxTokens && next === activeCtx) return;
  ctxTokens = next;
  chrome.storage?.local?.set({ [CTX_STORAGE_KEY]: next });

  if (!port) {
    // Not connected yet — the choice will be sent on first load.
    return;
  }
  // Lock interaction and show that a reload is happening.
  busy = true;
  setReady(false);
  ctxSelectEl.disabled = true;
  progressEl.hidden = false;
  progressEl.value = 0;
  statusEl.textContent = `Switching to ${(next / 1024).toFixed(0)}K context…`;
  try {
    port.postMessage({ cmd: "load", nCtx: next });
  } catch (e) {
    // Port gone; reconnect on next open will apply the stored choice.
    console.warn("[panel] port.postMessage failed for ctx switch:", e);
    setReady(modelReady);
    ctxSelectEl.disabled = false;
  }
}

function loadCtx() {
  chrome.storage?.local?.get(CTX_STORAGE_KEY, (res) => {
    const stored = res?.[CTX_STORAGE_KEY];
    if (isContextTokens(stored)) {
      ctxTokens = stored;
      activeCtx = stored;
    }
    reflectCtx(ctxTokens);
  });
}

let copyTimeout: ReturnType<typeof setTimeout> | undefined;

function copyChat() {
  if (chatHistory.length === 0) return;

  const stamp = new Date().toLocaleString();
  const sep = "─".repeat(40);

  const lines: string[] = [
    "=== Qwen Chat Log ===",
    `Model  : ${MODEL_LABEL} (vision + text)`,
    `Copied : ${stamp}`,
    "",
  ];

  for (const msg of chatHistory) {
    const label = msg.role === "user" ? "[ You ]" : "[ Assistant ]";
    lines.push(sep, label, msg.text, "");
  }

  navigator.clipboard.writeText(lines.join("\n")).then(() => {
    copyBtn.textContent = "✓";
    copyBtn.classList.add("copied");
    clearTimeout(copyTimeout);
    copyTimeout = setTimeout(() => {
      copyBtn.textContent = "⧉";
      copyBtn.classList.remove("copied");
    }, 1800);
  }).catch(() => {
    copyBtn.textContent = "✗";
    setTimeout(() => { copyBtn.textContent = "⧉"; }, 1500);
  });
}

function appendMessage(role: "user" | "assistant", text: string): HTMLDivElement {
  welcomeEl.hidden = true;
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  el.textContent = text;
  if (role === "assistant") {
    const actions = document.createElement("div");
    actions.className = "msg-actions";
    const copyMsgBtn = document.createElement("button");
    copyMsgBtn.className = "msg-copy";
    copyMsgBtn.title = "Copy";
    copyMsgBtn.textContent = "⧉";
    copyMsgBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(el.textContent ?? "").then(() => {
        copyMsgBtn.textContent = "✓";
        setTimeout(() => { copyMsgBtn.textContent = "⧉"; }, 1200);
      });
    });
    actions.appendChild(copyMsgBtn);
    el.appendChild(actions);
  }
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return el;
}

function resetChat() {
  chatHistory = [];
  messagesEl.innerHTML = "";
  messagesEl.appendChild(welcomeEl);
  welcomeEl.hidden = false;
  copyBtn.disabled = true;
  resetContextRing();
}

// ── Engine client (port to the service worker → offscreen wllama) ─────────────

function onEngineEvent(ev: EngineEvent) {
  switch (ev.kind) {
    case "progress":
      progressEl.hidden = false;
      progressEl.value = ev.progress;
      statusEl.textContent = ev.text;
      break;
    case "ready":
      progressEl.hidden = true;
      busy = false;
      setReady(true);
      ctxSelectEl.disabled = false;
      setIdleStatus();
      inputEl.focus();
      break;
    case "loaded":
      // The size actually in effect (may be smaller than requested on OOM).
      activeCtx = ev.nCtx;
      reflectCtx(ev.nCtx);
      ctxSelectEl.disabled = false;
      if (ev.fellBack) {
        // Show what actually loaded (not the user's preference) so the status
        // and dropdown reflect reality. But do NOT persist the fallback value —
        // the user explicitly chose a larger size, and a future device / update
        // may handle it. They can manually pick a smaller size if they want to
        // make it stick.
        console.info(
          `[panel] Context fell back to ${ev.nCtx} — keeping stored preference at ${ctxTokens}`,
        );
      }
      if (modelReady && !generating) setIdleStatus();
      break;
    case "loaderror":
      progressEl.hidden = true;
      busy = false;
      setReady(false);
      // Re-enable the picker so the user can choose a smaller size and retry.
      ctxSelectEl.disabled = false;
      reflectCtx(activeCtx);
      statusEl.textContent = `Error: ${ev.message}`;
      break;
    case "context":
      updateContextRing(ev.ratio, ev.used, ev.budget, ev.phase);
      break;
    case "status":
      pending.get(ev.reqId)?.onStatus(ev.text);
      break;
    case "delta":
      pending.get(ev.reqId)?.onDelta(ev.text);
      break;
    case "done": {
      const p = pending.get(ev.reqId);
      pending.delete(ev.reqId);
      p?.resolve(ev.text);
      break;
    }
    case "error": {
      const p = pending.get(ev.reqId);
      pending.delete(ev.reqId);
      p?.reject(new Error(ev.message));
      break;
    }
  }
}

function connectEngine() {
  if (port) return;
  port = chrome.runtime.connect({ name: ENGINE_PORT });
  port.onMessage.addListener(onEngineEvent as (msg: unknown) => void);
  port.onDisconnect.addListener(() => {
    port = undefined;
    loadStarted = false;
    modelReady = false;
    for (const p of pending.values()) p.reject(new Error("Engine disconnected"));
    pending.clear();
    setReady(false);
    ctxSelectEl.disabled = true;
    if (host.style.display !== "none") {
      statusEl.textContent = "Disconnected — reopen to reconnect";
    }
  });
}

function startLoad() {
  connectEngine();
  if (loadStarted) return;
  loadStarted = true;
  busy = true;
  setReady(false);
  ctxSelectEl.disabled = true;
  progressEl.hidden = false;
  progressEl.value = 0;
  statusEl.textContent = `Loading ${MODEL_LABEL}…`;
  // Carry the user's chosen context size into the very first load so we never
  // load at the default only to immediately reload at their preference.
  port!.postMessage({ cmd: "load", nCtx: ctxTokens });
}

function runChat(
  text: string,
  image: string | undefined,
  requestMode: EffortMode,
  replyEl: HTMLDivElement,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!port) {
      reject(new Error("Not connected"));
      return;
    }
    const reqId = crypto.randomUUID();
    activeReqId = reqId;
    const clearActive = () => {
      if (activeReqId === reqId) activeReqId = undefined;
    };
    pending.set(reqId, {
      onStatus: (t) => {
        replyEl.classList.add("typing");
        replyEl.textContent = t;
        statusEl.textContent = t;
        messagesEl.scrollTop = messagesEl.scrollHeight;
      },
      onDelta: (t) => {
        if (t) {
          replyEl.classList.remove("typing");
          replyEl.textContent = t;
        } else {
          // Empty delta = model is in its hidden "thinking" phase (Forge).
          replyEl.classList.add("typing");
          replyEl.textContent = "Thinking…";
        }
        messagesEl.scrollTop = messagesEl.scrollHeight;
      },
      resolve: (t) => {
        clearActive();
        resolve(t);
      },
      reject: (e) => {
        clearActive();
        reject(e);
      },
    });
    try {
      port.postMessage({ cmd: "chat", reqId, text, mode: requestMode, image });
    } catch (err) {
      pending.delete(reqId);
      clearActive();
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

// ── URL detection + background fetch ─────────────────────────────────────────
// When the user's message contains URLs, we fetch their content via the
// background service worker and prepend it so the model can read the pages.

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;
const MAX_URLS = 3;

function fetchUrlViaWorker(url: string): Promise<{ text?: string; error?: string }> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "fetchUrl", url }, (resp) => {
      if (chrome.runtime.lastError || !resp) {
        resolve({ error: chrome.runtime.lastError?.message ?? "Fetch failed" });
        return;
      }
      resolve(resp as { text?: string; error?: string });
    });
  });
}

async function fetchUrlsInText(text: string): Promise<string> {
  const urls = [...new Set(text.match(URL_RE) ?? [])].slice(0, MAX_URLS);
  if (urls.length === 0) return text;

  const results = await Promise.all(urls.map((u) => fetchUrlViaWorker(u)));

  const sections: string[] = [];
  for (let i = 0; i < urls.length; i++) {
    const r = results[i];
    if (r.text) {
      sections.push(`[Content from ${urls[i]}]:\n${r.text}`);
    } else {
      sections.push(`[Could not fetch ${urls[i]}: ${r.error}]`);
    }
  }

  return sections.join("\n\n") + "\n\n---\n\n" + text;
}

// ── Google AI Mode research ───────────────────────────────────────────────────
// Triggered by "\use google" or "\google" anywhere in the message. Strips the
// command, sends the remaining text as a query to Google AI Mode (udm=50), and
// prepends the scraped AI response so the model has research context.

const GOOGLE_CMD_RE = /\\(use\s+)?google/i;

function fetchGoogleAIViaWorker(query: string): Promise<{ text?: string; error?: string }> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "googleAI", query }, (resp) => {
      if (chrome.runtime.lastError || !resp) {
        resolve({ error: chrome.runtime.lastError?.message ?? "Google AI fetch failed" });
        return;
      }
      resolve(resp as { text?: string; error?: string });
    });
  });
}

// Obvious "look at the slide" phrasings route the question through vision.
const SLIDE_KEYWORDS =
  /\b(slide|image|picture|photo|screenshot|diagram|chart|graph|figure|visual|infographic|layout|colou?rs?|font|what'?s (in|on)|what is (in|on)|describe (this|the|it)|analy[sz]e (this|the|it)|summari[sz]e (this|the) slide|read (the|this)|on (the )?screen|shown|displayed)\b/i;

async function sendMessage() {
  const text = inputEl.value.trim();
  if (!text || busy || !modelReady || !port) return;

  const activeMode = mode;

  generating = true;
  stopRequested = false;
  busy = true;
  setReady(false);
  inputEl.value = "";

  appendMessage("user", text);
  chatHistory.push({ role: "user", text });

  const replyEl = appendMessage("assistant", "…");
  replyEl.classList.add("typing");

  try {
    let enrichedText = text;

    // Google AI Mode research — "\use google" or "\google" in the message
    const useGoogle = GOOGLE_CMD_RE.test(text);
    if (useGoogle) {
      const query = text.replace(GOOGLE_CMD_RE, "").trim();
      replyEl.textContent = "Researching via Google AI…";
      statusEl.textContent = "Google AI researching…";

      const res = await fetchGoogleAIViaWorker(query || text);
      if (res.text) {
        enrichedText = `[Google AI Research for "${query}"]:\n${res.text}\n\n---\n\n${query}`;
      } else {
        enrichedText = `[Google AI research failed: ${res.error}]\n\n${query}`;
      }
    }

    if (stopRequested) {
      replyEl.textContent = "(stopped)";
      replyEl.classList.remove("typing");
      chatHistory.pop();
      return;
    }

    // Fetch any URLs the user included in their message (skip if already enriched by Google).
    if (!useGoogle) {
      const hasUrls = URL_RE.test(text);
      URL_RE.lastIndex = 0;

      if (hasUrls) {
        replyEl.textContent = "Reading web page…";
        statusEl.textContent = "Fetching URL…";
        enrichedText = await fetchUrlsInText(text);
      }
    }

    if (stopRequested) {
      replyEl.textContent = "(stopped)";
      replyEl.classList.remove("typing");
      chatHistory.pop();
      return;
    }

    const useSlide = SLIDE_KEYWORDS.test(text);
    let image: string | undefined;

    if (useSlide) {
      replyEl.textContent = "Capturing the current slide…";
      statusEl.textContent = "Capturing slide…";
      const rawUrl = await captureSlideViaWorker();

      image = await downscaleToDataUrl(rawUrl, MODES[activeMode].imageMaxDim);
      replyEl.classList.add("vision");
    }

    if (stopRequested) {
      replyEl.textContent = "(stopped)";
      replyEl.classList.remove("typing");
      chatHistory.pop();
    } else {
      const reply = await runChat(enrichedText, image, activeMode, replyEl);
      replyEl.textContent = reply;
      replyEl.classList.remove("typing");
      chatHistory.push({ role: "assistant", text: reply });
    }
  } catch (err) {
    replyEl.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
    replyEl.classList.remove("typing");
    chatHistory.pop();
  } finally {
    generating = false;
    stopRequested = false;
    activeReqId = undefined;
    busy = false;
    stopBtn.disabled = false;
    stopBtn.textContent = "Stop";
    setReady(true);
    copyBtn.disabled = chatHistory.length === 0;
    setIdleStatus();
    inputEl.focus();
  }
}

// Stop the in-flight request: abort generation if it reached the model, or mark
// it cancelled if we're still capturing the slide.
function stopGeneration() {
  if (!generating || stopRequested) return;
  stopRequested = true;
  stopBtn.disabled = true;
  stopBtn.textContent = "Stopping…";
  statusEl.textContent = "Stopping…";
  if (port && activeReqId) {
    try {
      port.postMessage({ cmd: "abort", reqId: activeReqId });
    } catch {
      // Port already gone; the finally in sendMessage will clean up.
    }
  }
}

// ── Slide image capture + downscale ───────────────────────────────────────────
// The content script (isolated world) can't see Zoho Show's `DownloadUtil`, so
// we ask the service worker to run the capture in the page's MAIN world and
// hand back a JPEG data URL.

function captureSlideViaWorker(): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "getSlideImage" }, (resp) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message ?? "Messaging failed"));
        return;
      }
      if (!resp || resp.error) {
        reject(new Error(resp?.error ?? "Unknown error"));
        return;
      }
      resolve(resp.dataUrl as string);
    });
  });
}

// Downscale the captured slide to a bounded JPEG data URL. Keeps the message
// payload small; the model caps vision tokens on its side anyway.
function downscaleToDataUrl(dataUrl: string, maxDim = 1600, quality = 0.85): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Canvas 2D context unavailable"));
        return;
      }
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => reject(new Error("Couldn't load the captured slide image"));
    img.src = dataUrl;
  });
}


// ── Drag ──────────────────────────────────────────────────────────────────────

let dragging = false;
let ox = 0;
let oy = 0;

dragHandle.addEventListener("mousedown", (e) => {
  if ((e.target as HTMLElement).closest("button, .modes, select, label, .ctx-row")) return;
  dragging = true;
  const r = host.getBoundingClientRect();
  ox = e.clientX - r.left;
  oy = e.clientY - r.top;
  e.preventDefault();
});

document.addEventListener("mousemove", (e) => {
  if (dragging) {
    const maxX = window.innerWidth - host.offsetWidth;
    const maxY = window.innerHeight - host.offsetHeight;
    host.style.left   = `${Math.max(0, Math.min(e.clientX - ox, maxX))}px`;
    host.style.top    = `${Math.max(0, Math.min(e.clientY - oy, maxY))}px`;
    host.style.right  = "auto";
    host.style.bottom = "auto";
  }
  if (resizing) onResize(e);
});

document.addEventListener("mouseup", () => {
  dragging = false;
  if (resizing) {
    resizing = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }
});

// ── Resize ───────────────────────────────────────────────────────────────────

let resizing = false;
let resizeDir = "";
let startX = 0;
let startY = 0;
let startW = 0;
let startH = 0;
let startL = 0;
let startT = 0;

for (const handle of shadow.querySelectorAll<HTMLElement>(".rh")) {
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    resizing = true;
    resizeDir = handle.dataset.dir ?? "";
    startX = e.clientX;
    startY = e.clientY;
    const rect = host.getBoundingClientRect();
    startW = rect.width;
    startH = rect.height;
    startL = rect.left;
    startT = rect.top;
    document.body.style.cursor = getComputedStyle(handle).cursor;
    document.body.style.userSelect = "none";
  });
}

function onResize(e: MouseEvent) {
  const dx = e.clientX - startX;
  const dy = e.clientY - startY;
  let w = startW;
  let h = startH;
  let l = startL;
  let t = startT;

  if (resizeDir.includes("e")) w = startW + dx;
  if (resizeDir.includes("w")) { w = startW - dx; l = startL + dx; }
  if (resizeDir.includes("s")) h = startH + dy;
  if (resizeDir.includes("n")) { h = startH - dy; t = startT + dy; }

  w = Math.max(MIN_W, Math.min(w, window.innerWidth));
  h = Math.max(MIN_H, Math.min(h, window.innerHeight));

  // Clamp position so the panel stays on screen
  if (resizeDir.includes("w")) l = Math.max(0, Math.min(l, startL + startW - MIN_W));
  if (resizeDir.includes("n")) t = Math.max(0, Math.min(t, startT + startH - MIN_H));

  host.style.width  = `${w}px`;
  host.style.height = `${h}px`;
  host.style.left   = `${l}px`;
  host.style.top    = `${t}px`;
  host.style.right  = "auto";
  host.style.bottom = "auto";
}

// ── UI events ─────────────────────────────────────────────────────────────────

copyBtn.addEventListener("click", copyChat);
closeBtn.addEventListener("click", () => { host.style.display = "none"; });

newChatBtn.addEventListener("click", () => {
  resetChat();
  // Clear the engine's conversation context for this tab too.
  if (port) {
    try {
      port.postMessage({ cmd: "reset" });
    } catch {
      // Port already gone; a fresh connection starts with an empty session anyway.
    }
  }
  setReady(modelReady);
  inputEl.focus();
});

inputEl.addEventListener("input", () => setReady(modelReady));
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void sendMessage();
  }
});
sendBtn.addEventListener("click", () => void sendMessage());
stopBtn.addEventListener("click", stopGeneration);

renderModeSwitch();
loadMode();
renderCtxSelect();
loadCtx();

// ── Toggle from background (action click) ────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "toggle") return;
  host.style.display = "block";
  startLoad();
  setTimeout(() => inputEl.focus(), 50);
});
