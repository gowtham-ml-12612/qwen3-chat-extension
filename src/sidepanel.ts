// Side panel chat UI — runs as a Chrome Side Panel extension page.
// Communicates with the service worker via port (engine relay) and runtime
// messages (CDP screenshot, URL fetch).

import { ENGINE_PORT, type EngineEvent } from "./messages";
import type {
  AgentObserveResponse,
  AgentActResponse,
} from "./messages";
import {
  isContextTokens,
} from "./models";
import { MODES, DEFAULT_MODE, isEffortMode, type EffortMode } from "./modes";
import { extractJsonObject } from "./actions";
import type { AgentAction, PageElement } from "./actions";
import { dlog, initDebugPanel } from "./debug-log";

interface HistoryTurn {
  role: "user" | "assistant";
  text: string;
}

// ── DOM refs ──────────────────────────────────────────────────────────────────

const q = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const messagesEl    = q("messages");
const inputEl       = q("input") as HTMLTextAreaElement;
const sendBtn       = q("send-btn") as HTMLButtonElement;
const stopBtn       = q("stop-btn") as HTMLButtonElement;
const newChatBtn    = q("new-chat-btn") as HTMLButtonElement;
const themeToggle   = q("theme-toggle") as HTMLButtonElement;
const attachBtn     = q("attach-btn") as HTMLButtonElement;
const fileInput     = q("file-input") as HTMLInputElement;
const imagePreview  = q("image-preview") as HTMLDivElement;
const imagePreviewImg = q("image-preview-img") as HTMLImageElement;
const imagePreviewRemove = q("image-preview-remove") as HTMLButtonElement;
const dropOverlay   = q("drop-overlay") as HTMLDivElement;
const welcomeEl     = q("welcome");

// Loading overlay
const loadingOverlay = q("loading-overlay");
const loadingPhrase  = q("loading-phrase");
const loadingFill    = q("loading-progress-fill");
const loadingPct     = q("loading-pct");

// Context dropdown
const ctxDropdownBtn   = q("ctx-dropdown-btn") as HTMLButtonElement;
const ctxDropdownLabel = q("ctx-dropdown-label");
const ctxDropdownMenu  = q("ctx-dropdown-menu");

// Mode dropdown (Ask before acting / Autopilot)
const modeDropdownBtn  = q("mode-dropdown-btn") as HTMLButtonElement;
const modeDropdownLabel = q("mode-dropdown-label");
const modeDropdownMenu = q("mode-dropdown-menu");

// ── Mode → Context token mapping ─────────────────────────────────────────────

const MODE_CTX_MAP: Record<EffortMode, number> = {
  flash: 8192,
  focus: 16384,
  forge: 32768,
  max: 65536,
};

// ── Storage keys ─────────────────────────────────────────────────────────────

const MODE_STORAGE_KEY = "showPilotMode";
const CTX_STORAGE_KEY = "showPilotCtx";

// ── State ─────────────────────────────────────────────────────────────────────

let chatHistory: HistoryTurn[] = [];
let busy = false;
let modelReady = false;
let loadStarted = false;

let generating = false;
let stopRequested = false;
let activeReqId: string | undefined;

let mode: EffortMode = DEFAULT_MODE;
let ctxTokens = MODE_CTX_MAP[DEFAULT_MODE];
let activeCtx = MODE_CTX_MAP[DEFAULT_MODE];
let interactionMode: "ask" | "autopilot" = "autopilot";
let attachedImageDataUrl: string | undefined;

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
  attachBtn.disabled = !ready || busy;
  sendBtn.disabled = !ready || busy || (inputEl.value.trim() === "" && !attachedImageDataUrl);
  sendBtn.hidden = generating;
  stopBtn.hidden = !generating;
}

function setIdleStatus() {
  loadingOverlay.hidden = true;
}

// ── Loading overlay with catchy phrases ───────────────────────────────────────

const LOADING_PHRASES = [
  "Warming up the engine…",
  "Preparing your AI assistant…",
  "Almost there, hang tight…",
  "Getting things ready for you…",
  "Powering up Show Pilot…",
  "Setting up the magic…",
  "Loading intelligence…",
];

const INIT_PHRASES = [
  "Initializing neural pathways…",
  "Connecting the dots…",
  "Final touches…",
  "Just a moment more…",
  "Calibrating responses…",
];

let phraseInterval: ReturnType<typeof setInterval> | undefined;

let loadingCurrentPct = 0;
let initInterval: ReturnType<typeof setInterval> | undefined;

function showLoadingOverlay() {
  loadingOverlay.hidden = false;
  loadingCurrentPct = 0;
  loadingFill.style.width = "0%";
  loadingPct.textContent = "0%";
  loadingPhrase.textContent = LOADING_PHRASES[0];
  clearInterval(initInterval);

  let phraseIdx = 0;
  clearInterval(phraseInterval);
  phraseInterval = setInterval(() => {
    phraseIdx = (phraseIdx + 1) % LOADING_PHRASES.length;
    loadingPhrase.textContent = LOADING_PHRASES[phraseIdx];
  }, 4000);
}

function stepTo(target: number, speed: number) {
  clearInterval(initInterval);
  initInterval = setInterval(() => {
    if (loadingCurrentPct >= target) {
      clearInterval(initInterval);
      return;
    }
    loadingCurrentPct = Math.min(loadingCurrentPct + 1, target);
    loadingFill.style.width = `${loadingCurrentPct}%`;
    loadingPct.textContent = `${loadingCurrentPct}%`;
  }, speed);
}

function updateLoadingProgress(progress: number) {
  const target = Math.round(progress * 75);
  const gap = target - loadingCurrentPct;
  // Cached model = huge gap, go super fast; fresh download = small increments, go steady
  const speed = gap > 50 ? 10 : gap > 20 ? 30 : gap > 5 ? 80 : 150;
  stepTo(target, speed);

  if (progress >= 1) {
    clearInterval(phraseInterval);
    const initPhrase = INIT_PHRASES[Math.floor(Math.random() * INIT_PHRASES.length)];
    loadingPhrase.textContent = initPhrase;
    setTimeout(() => stepTo(95, 120), 50);
  }
}

function hideLoadingOverlay() {
  clearInterval(phraseInterval);
  clearInterval(initInterval);
  loadingCurrentPct = 100;
  loadingFill.style.width = "100%";
  loadingPct.textContent = "100%";
  loadingPhrase.textContent = "Ready!";
  setTimeout(() => {
    loadingOverlay.hidden = true;
  }, 300);
}

// ── Context-window usage ring ─────────────────────────────────────────────────

const ctxRingWrap = q("ctx-ring-wrap") as HTMLElement;
const ctxRingFg = document.getElementById("ctx-ring-fg") as unknown as SVGCircleElement;
const ctxRingTooltip = q("ctx-ring-tooltip") as HTMLElement;
const ctxRingDetail = q("ctx-ring-detail") as HTMLElement;

const RING_CIRCUMFERENCE = 2 * Math.PI * 15.5; // matches r="15.5" in SVG

let ctxLastUsed = 0;
let ctxLastTotal = 0;

function formatTokens(n: number): string {
  if (n >= 1024) return (n / 1024).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

function updateContextRing(
  ratio: number,
  used: number,
  _budget: number,
  total: number,
  phase: "ok" | "compacting" | "compacted",
) {
  ctxLastUsed = used;
  ctxLastTotal = total;

  // Show usage as fraction of the full context window
  const fullRatio = total > 0 ? used / total : 0;
  const clamped = Math.max(0, Math.min(fullRatio, 1));
  const visual = used > 0 ? Math.max(0.03, clamped) : 0;
  const offset = RING_CIRCUMFERENCE * (1 - visual);
  ctxRingFg.style.strokeDashoffset = `${offset}`;

  let color: string;
  if (clamped < 0.5) color = "var(--green)";
  else if (clamped < 0.7) color = "var(--ctx-yellow)";
  else if (clamped < 0.85) color = "var(--ctx-orange)";
  else color = "var(--red)";
  ctxRingFg.style.stroke = color;

  ctxRingWrap.classList.toggle("compacting", phase === "compacting");
  if (phase === "compacted") {
    ctxRingWrap.classList.remove("compacting");
  }

  // Update tooltip content
  const pct = Math.max(1, Math.round(clamped * 100));
  ctxRingDetail.textContent = `${formatTokens(used)} / ${formatTokens(total)} · ${pct}%`;

  ctxRingWrap.hidden = false;
}

function resetContextRing() {
  ctxRingFg.style.strokeDashoffset = `${RING_CIRCUMFERENCE}`;
  ctxRingFg.style.stroke = "var(--green)";
  ctxRingWrap.hidden = true;
  ctxRingTooltip.hidden = true;
  ctxRingWrap.classList.remove("compacting");
  ctxLastUsed = 0;
  ctxLastTotal = 0;
}

// Click to toggle token details
ctxRingWrap.addEventListener("click", (e) => {
  e.stopPropagation();
  const pct = ctxLastTotal > 0 ? Math.max(1, Math.round((ctxLastUsed / ctxLastTotal) * 100)) : 0;
  ctxRingDetail.textContent = `${formatTokens(ctxLastUsed)} / ${formatTokens(ctxLastTotal)} · ${pct}%`;
  ctxRingTooltip.hidden = !ctxRingTooltip.hidden;
});

// Close tooltip on outside click
document.addEventListener("click", () => {
  ctxRingTooltip.hidden = true;
});

// ── Fallback banner ──────────────────────────────────────────────────────────

const fallbackBanner = q("fallback-banner") as HTMLElement;
const fallbackText = q("fallback-text") as HTMLElement;
const fallbackOk = q("fallback-ok") as HTMLButtonElement;

// Reverse lookup: context tokens → effort mode
const CTX_MODE_MAP: Record<number, EffortMode> = {
  8192: "flash",
  16384: "focus",
  32768: "forge",
  65536: "max",
};

function showFallbackBanner(requested: number, actual: number) {
  const reqK = (requested / 1024).toFixed(0);
  const actK = (actual / 1024).toFixed(0);
  const actMode = CTX_MODE_MAP[actual];
  const actLabel = actMode ? MODES[actMode].label : `${actK}K`;
  fallbackText.textContent =
    `${reqK}K context didn't fit in memory. Loaded at ${actLabel} (${actK}K) instead.`;
  fallbackBanner.hidden = false;
}

fallbackOk.addEventListener("click", () => {
  fallbackBanner.hidden = true;
  // Dropdown was already synced when the "loaded" event fired — nothing else to do.
});

// ── Theme ─────────────────────────────────────────────────────────────────────

const THEME_STORAGE_KEY = "showPilotTheme";

function applyTheme(theme: "light" | "dark") {
  document.documentElement.dataset.theme = theme;
}

function toggleTheme() {
  const current = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  const next = current === "dark" ? "light" : "dark";
  applyTheme(next);
  chrome.storage?.local?.set({ [THEME_STORAGE_KEY]: next });
}

function loadTheme() {
  chrome.storage?.local?.get(THEME_STORAGE_KEY, (res) => {
    const stored = res?.[THEME_STORAGE_KEY];
    if (stored === "dark" || stored === "light") {
      applyTheme(stored);
    }
  });
}

// ── Context window + Mode selector ────────────────────────────────────────────

function updateCtxDropdownLabel() {
  const modeLabel = MODES[mode].label;
  const ctxK = (ctxTokens / 1024).toFixed(0);
  ctxDropdownLabel.textContent = `${modeLabel} · ${ctxK}K`;
}

function reflectCtxOptions() {
  const options = ctxDropdownMenu.querySelectorAll(".ctx-option");
  options.forEach((el) => {
    const optMode = (el as HTMLElement).dataset.mode as EffortMode;
    el.classList.toggle("active", optMode === mode);
  });
}

function setModeAndCtx(nextMode: EffortMode) {
  if (nextMode === mode && MODE_CTX_MAP[nextMode] === ctxTokens) {
    closeCtxDropdown();
    return;
  }

  mode = nextMode;
  const nextCtx = MODE_CTX_MAP[nextMode];
  ctxTokens = nextCtx;

  updateCtxDropdownLabel();
  reflectCtxOptions();
  closeCtxDropdown();

  chrome.storage?.local?.set({ [MODE_STORAGE_KEY]: nextMode, [CTX_STORAGE_KEY]: nextCtx });

  if (nextCtx !== activeCtx && port) {
    busy = true;
    setReady(false);
    showLoadingOverlay();
    loadingPhrase.textContent = `Switching to ${(nextCtx / 1024).toFixed(0)}K context…`;
    try {
      port.postMessage({ cmd: "load", nCtx: nextCtx });
    } catch {
      hideLoadingOverlay();
      setReady(modelReady);
    }
  }
}

function openCtxDropdown() {
  ctxDropdownMenu.hidden = false;
}

function closeCtxDropdown() {
  ctxDropdownMenu.hidden = true;
}

function loadModeAndCtx() {
  chrome.storage?.local?.get([MODE_STORAGE_KEY, CTX_STORAGE_KEY], (res) => {
    const storedMode = res?.[MODE_STORAGE_KEY];
    const storedCtx = res?.[CTX_STORAGE_KEY];
    if (isEffortMode(storedMode)) mode = storedMode;
    if (isContextTokens(storedCtx)) {
      ctxTokens = storedCtx;
      activeCtx = storedCtx;
    }
    updateCtxDropdownLabel();
    reflectCtxOptions();
    // Start the engine load AFTER storage is read so we send the correct nCtx.
    startLoad();
  });
}

// ── Interaction mode (Ask before acting / Autopilot) ──────────────────────────

const INTERACTION_STORAGE_KEY = "showPilotInteraction";

function reflectInteractionMode() {
  modeDropdownLabel.textContent = interactionMode === "ask" ? "Ask before acting" : "Autopilot";
  const options = modeDropdownMenu.querySelectorAll(".mode-option");
  options.forEach((el) => {
    const optMode = (el as HTMLElement).dataset.interaction;
    el.classList.toggle("active", optMode === interactionMode);
  });
}

function setInteractionMode(next: "ask" | "autopilot") {
  interactionMode = next;
  reflectInteractionMode();
  closeModeDropdown();
  chrome.storage?.local?.set({ [INTERACTION_STORAGE_KEY]: next });
}

function openModeDropdown() {
  modeDropdownMenu.hidden = false;
}

function closeModeDropdown() {
  modeDropdownMenu.hidden = true;
}

function loadInteractionMode() {
  chrome.storage?.local?.get(INTERACTION_STORAGE_KEY, (res) => {
    const stored = res?.[INTERACTION_STORAGE_KEY];
    if (stored === "ask" || stored === "autopilot") interactionMode = stored;
    reflectInteractionMode();
  });
}

// ── Auto-resize textarea ──────────────────────────────────────────────────────

function autoResizeInput() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + "px";
}

// ── Image attachment ──────────────────────────────────────────────────────

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

async function attachImageFile(file: File) {
  if (!file.type.startsWith("image/")) return;
  try {
    const dataUrl = await readFileAsDataUrl(file);
    attachedImageDataUrl = dataUrl;
    imagePreviewImg.src = dataUrl;
    imagePreview.hidden = false;
    setReady(modelReady);
  } catch {
    // silently ignore unreadable files
  }
}

function clearAttachedImage() {
  attachedImageDataUrl = undefined;
  imagePreview.hidden = true;
  imagePreviewImg.src = "";
  fileInput.value = "";
}

function extractImageFromDataTransfer(dt: DataTransfer): File | undefined {
  for (const item of dt.items) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      return item.getAsFile() ?? undefined;
    }
  }
  for (const file of dt.files) {
    if (file.type.startsWith("image/")) return file;
  }
  return undefined;
}

// ── Lightweight Markdown → HTML ───────────────────────────────────────────────

function escapeHtml(s: string): string {
  const str = typeof s === "string" ? s : String(s ?? "");
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderMarkdown(raw: string): string {
  let html = escapeHtml(raw);

  // Code blocks: ```...```
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) =>
    `<pre><code>${code.trimEnd()}</code></pre>`);

  // Inline code: `...`
  html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");

  // Bold: **...**
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

  // Italic: *...*
  html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<em>$1</em>");

  // Headings: ### ... (only at line start)
  html = html.replace(/^### (.+)$/gm, '<h4 class="md-h">$1</h4>');
  html = html.replace(/^## (.+)$/gm, '<h3 class="md-h">$1</h3>');
  html = html.replace(/^# (.+)$/gm, '<h3 class="md-h">$1</h3>');

  // Unordered list items: - item / * item
  html = html.replace(/^[-*] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');

  // Ordered list items: 1. item
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

  // Line breaks (preserve paragraph structure)
  html = html.replace(/\n{2,}/g, "</p><p>");
  html = html.replace(/\n/g, "<br>");
  html = `<p>${html}</p>`;

  // Clean up empty paragraphs
  html = html.replace(/<p>\s*<\/p>/g, "");

  return html;
}

/** Store raw text separately from the rendered innerHTML for copy. */
const msgRawText = new WeakMap<HTMLElement, string>();

function setMessageContent(el: HTMLDivElement, text: string) {
  const safeText = typeof text === "string" ? text : String(text ?? "");
  msgRawText.set(el, safeText);

  const existingActions = el.querySelector(".msg-actions");
  const existingImg = el.querySelector(".msg-image");

  const contentEl = el.querySelector(".msg-body") ?? (() => {
    const d = document.createElement("div");
    d.className = "msg-body";
    if (existingActions) el.insertBefore(d, existingActions);
    else el.appendChild(d);
    return d;
  })();

  void existingImg;
  contentEl.innerHTML = renderMarkdown(safeText);
}

// ── Messages ──────────────────────────────────────────────────────────────────

function appendMessage(role: "user" | "assistant", text: string, imageUrl?: string): HTMLDivElement {
  welcomeEl.hidden = true;
  const el = document.createElement("div");
  el.className = `msg ${role}`;

  const body = document.createElement("div");
  body.className = "msg-body";

  if (imageUrl && role === "user") {
    const thumb = document.createElement("img");
    thumb.className = "msg-image";
    thumb.src = imageUrl;
    thumb.alt = "Attached image";
    body.appendChild(thumb);
  }

  el.appendChild(body);

  if (role === "assistant") {
    setMessageContent(el, text);
  } else {
    body.textContent = text;
  }

  const actions = document.createElement("div");
  actions.className = "msg-actions";
  const copyMsgBtn = document.createElement("button");
  copyMsgBtn.className = "msg-copy";
  copyMsgBtn.title = "Copy";
  copyMsgBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor"><path d="M13.2,4.2v1.2h-0.9V4.2c0-0.1-0.1-0.2-0.2-0.2H4.2C4,3.9,3.9,4,3.9,4.2v7.9c0,0.1,0.1,0.2,0.2,0.2h1.2v0.9H4.2c-0.6,0-1.2-0.5-1.2-1.2V4.2C3,3.5,3.5,3,4.2,3h7.9C12.7,3,13.2,3.5,13.2,4.2z M16,6.9v7.9c0,0.6-0.5,1.2-1.2,1.2H6.9c-0.6,0-1.2-0.5-1.2-1.2V6.9c0-0.6,0.5-1.2,1.2-1.2h7.9C15.5,5.8,16,6.3,16,6.9z M15.1,14.8V6.9c0-0.1-0.1-0.2-0.2-0.2H6.9c-0.1,0-0.2,0.1-0.2,0.2v7.9c0,0.1,0.1,0.2,0.2,0.2h7.9C15,15.1,15.1,15,15.1,14.8z"/></svg>`;
  copyMsgBtn.addEventListener("click", () => {
    const raw = msgRawText.get(el) ?? el.textContent ?? "";
    navigator.clipboard.writeText(raw).then(() => {
      copyMsgBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`;
      setTimeout(() => { copyMsgBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor"><path d="M13.2,4.2v1.2h-0.9V4.2c0-0.1-0.1-0.2-0.2-0.2H4.2C4,3.9,3.9,4,3.9,4.2v7.9c0,0.1,0.1,0.2,0.2,0.2h1.2v0.9H4.2c-0.6,0-1.2-0.5-1.2-1.2V4.2C3,3.5,3.5,3,4.2,3h7.9C12.7,3,13.2,3.5,13.2,4.2z M16,6.9v7.9c0,0.6-0.5,1.2-1.2,1.2H6.9c-0.6,0-1.2-0.5-1.2-1.2V6.9c0-0.6,0.5-1.2,1.2-1.2h7.9C15.5,5.8,16,6.3,16,6.9z M15.1,14.8V6.9c0-0.1-0.1-0.2-0.2-0.2H6.9c-0.1,0-0.2,0.1-0.2,0.2v7.9c0,0.1,0.1,0.2,0.2,0.2h7.9C15,15.1,15.1,15,15.1,14.8z"/></svg>`; }, 1200);
    });
  });
  actions.appendChild(copyMsgBtn);
  el.appendChild(actions);

  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return el;
}

function resetChat() {
  chatHistory = [];
  messagesEl.innerHTML = "";
  messagesEl.appendChild(welcomeEl);
  welcomeEl.hidden = false;
  resetContextRing();
}

// ── Engine client (port to the service worker → offscreen wllama) ─────────────

function onEngineEvent(ev: EngineEvent) {
  if (ev.kind !== "delta") {
    dlog.log("SP", `[onEngineEvent] kind="${ev.kind}"`, JSON.stringify(ev).slice(0, 500));
  }
  switch (ev.kind) {
    case "progress":
      loadingOverlay.hidden = false;
      updateLoadingProgress(ev.progress);
      break;
    case "ready":
      dlog.log("SP", "[onEngineEvent] model READY");
      busy = false;
      setReady(true);
      hideLoadingOverlay();
      inputEl.focus();
      break;
    case "loaded":
      dlog.log("SP", `[onEngineEvent] LOADED nCtx=${ev.nCtx} fellBack=${ev.fellBack} requestedCtx=${ev.requestedCtx}`);
      activeCtx = ev.nCtx;
      if (ev.fellBack) {
        // Sync the dropdown immediately — the user shouldn't see "Max · 64K"
        // while the ring already says "16K". Don't wait for the OK click.
        const actMode = CTX_MODE_MAP[ev.nCtx];
        if (actMode) {
          mode = actMode;
          ctxTokens = ev.nCtx;
          updateCtxDropdownLabel();
          reflectCtxOptions();
          chrome.storage?.local?.set({ [MODE_STORAGE_KEY]: mode, [CTX_STORAGE_KEY]: ctxTokens });
        }
        showFallbackBanner(ev.requestedCtx, ev.nCtx);
      }
      if (modelReady && !generating) hideLoadingOverlay();
      break;
    case "loaderror":
      dlog.error("SP", `[onEngineEvent] LOADERROR: ${ev.message}`);
      hideLoadingOverlay();
      busy = false;
      setReady(false);
      loadingOverlay.hidden = false;
      loadingPhrase.textContent = `Error: ${ev.message}`;
      loadingFill.style.width = "0%";
      loadingPct.textContent = "";
      break;
    case "context":
      updateContextRing(ev.ratio, ev.used, ev.budget, ev.total, ev.phase);
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
  dlog.log("SP", "[connectEngine] connecting to engine port…");
  port = chrome.runtime.connect({ name: ENGINE_PORT });
  port.onMessage.addListener(onEngineEvent as (msg: unknown) => void);
  port.onDisconnect.addListener(() => {
    dlog.warn("SP", "[connectEngine] port DISCONNECTED — pending jobs:", pending.size);
    port = undefined;
    loadStarted = false;
    modelReady = false;
    for (const p of pending.values()) p.reject(new Error("Engine disconnected"));
    pending.clear();
    setReady(false);
    loadingOverlay.hidden = false;
    loadingPhrase.textContent = "Disconnected — reopen panel to reconnect";
    loadingFill.style.width = "0%";
    loadingPct.textContent = "";
  });
}

function startLoad() {
  connectEngine();
  if (loadStarted) return;
  loadStarted = true;
  busy = true;
  setReady(false);
  showLoadingOverlay();
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
      dlog.error("SP", "[runChat] not connected!");
      reject(new Error("Not connected"));
      return;
    }
    const reqId = crypto.randomUUID();
    activeReqId = reqId;
    dlog.log("SP", `[runChat] reqId=${reqId} mode=${requestMode} hasImage=${!!image} textLen=${text.length}`);
    dlog.log("SP", `[runChat] text (first 300): "${text.slice(0, 300)}…"`);
    const clearActive = () => {
      if (activeReqId === reqId) activeReqId = undefined;
    };
    pending.set(reqId, {
      onStatus: (t) => {
        dlog.log("SP", `[runChat] reqId=${reqId} STATUS: "${t}"`);
        replyEl.classList.add("typing");
        const body = replyEl.querySelector(".msg-body");
        if (body) body.textContent = t;
        messagesEl.scrollTop = messagesEl.scrollHeight;
      },
      onDelta: (t) => {
        if (t) {
          replyEl.classList.remove("typing");
          setMessageContent(replyEl, t);
        } else {
          replyEl.classList.add("typing");
          const body = replyEl.querySelector(".msg-body");
          if (body) body.textContent = "Thinking…";
        }
        messagesEl.scrollTop = messagesEl.scrollHeight;
      },
      resolve: (t) => {
        clearActive();
        dlog.log("SP", `[runChat] reqId=${reqId} DONE → "${t.slice(0, 200)}${t.length > 200 ? "…" : ""}"`);
        resolve(t);
      },
      reject: (e) => {
        clearActive();
        dlog.error("SP", `[runChat] reqId=${reqId} ERROR →`, e);
        reject(e);
      },
    });
    try {
      port.postMessage({ cmd: "chat", reqId, text, mode: requestMode, image });
    } catch (err) {
      dlog.error("SP", `[runChat] postMessage failed for reqId=${reqId}`, err);
      pending.delete(reqId);
      clearActive();
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

// ── URL detection + background fetch ─────────────────────────────────────────

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

// ── CDP Screenshot capture ────────────────────────────────────────────────────

function captureScreenshotViaCDP(): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "cdpScreenshot" }, (resp) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message ?? "CDP screenshot failed"));
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
    img.onerror = () => reject(new Error("Couldn't decode the captured screenshot"));
    img.src = dataUrl;
  });
}

// ── Recipe-driven task execution ──────────────────────────────────────────────
//
// Instead of having the 4B model autonomously decide what to click (unreliable),
// we use pre-defined step-by-step procedures ("recipes") for common tasks. The
// model's only role is answering questions — element targeting is done by simple
// text matching against the page's interactive element labels.

import { RECIPES, type RecipeStep, type Recipe } from "./recipes";
import { THEMES, getThemeById, getThemeByName, type PresentationType } from "./themes";
import { summarizeSlideForAI, getSlideMetadata, summarizeDocForAI, getMastersInfo, type SlideMetadata } from "./slide-data";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Stateless model inference (no session pollution) ──────────────────────────

/**
 * Run a one-shot model call via the agentStep command.
 * Returns the raw model output text.
 */
function runInference(system: string, user: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!port) { dlog.error("SP", "[runInference] not connected!"); reject(new Error("Not connected")); return; }
    const reqId = crypto.randomUUID();
    dlog.log("SP", `[runInference] reqId=${reqId} mode=${mode}`);
    dlog.log("SP", `[runInference] system (${system.length} chars): "${system.slice(0, 200)}…"`);
    dlog.log("SP", `[runInference] user (${user.length} chars): "${user.slice(0, 300)}…"`);
    pending.set(reqId, {
      onStatus: () => {},
      onDelta: () => {},
      resolve: (t) => {
        pending.delete(reqId);
        dlog.log("SP", `[runInference] reqId=${reqId} DONE → "${t.slice(0, 200)}${t.length > 200 ? "…" : ""}"`);
        resolve(t);
      },
      reject: (e) => {
        pending.delete(reqId);
        dlog.error("SP", `[runInference] reqId=${reqId} ERROR →`, e);
        reject(e);
      },
    });
    try {
      port.postMessage({ cmd: "agentStep", reqId, system, user, mode });
    } catch (err) {
      dlog.error("SP", `[runInference] postMessage failed for reqId=${reqId}`, err);
      pending.delete(reqId);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

// ── Tool abstraction ──────────────────────────────────────────────────────────
//
// The assistant is "tool-using": for every turn the model first picks ONE tool
// from the registry below, then we run that tool. This mirrors how larger agent
// systems work — a single registry is the source of truth, and both the
// selection prompt and the dispatcher are derived from it. Adding a capability
// means appending one entry to `TOOLS`; nothing else changes.
//
//   Tool          — a capability: a name, a "when to use" description, and run()
//   ToolContext   — everything a tool needs for one invocation (DI, no globals)
//   ToolResult    — what a tool produces, rendered uniformly by the dispatcher

/** Schema for a parameter the model must extract during tool selection. */
interface ToolParam {
  name: string;
  type: "string";
  description: string;
  required?: boolean;
}

/** Per-invocation handle passed to a tool's `run`. */
interface ToolContext {
  /** The raw user message that triggered this turn. */
  userText: string;
  /** Effort tier for this turn (drives length / image detail). */
  mode: EffortMode;
  /** The assistant bubble being built — tools render their output here. */
  replyEl: HTMLDivElement;
  /** An image the user attached to this turn, if any (data URL). */
  attachedImage?: string;
  /** Arguments extracted by the model during tool selection. */
  args: Record<string, string>;
  /** Update the streaming status line shown in the bubble. */
  setStatus(text: string): void;
  /** True once the user has pressed Stop for this turn. */
  isStopped(): boolean;
}

/**
 * The outcome of running a tool. The dispatcher commits this to history and,
 * when `remember` is set, also injects it into the model's persistent session
 * so follow-up questions ("why did you pick that theme?") have context.
 */
interface ToolResult {
  /** Assistant text to store in chat history (the bubble is rendered by run). */
  assistantText: string;
  /** When true, inject the user+assistant turn into the model session. */
  remember?: boolean;
}

/** A capability the model can choose to invoke. */
interface Tool {
  /** Stable identifier the model emits to select this tool. */
  name: string;
  /** When the model should pick this tool — shown verbatim in the selector. */
  description: string;
  /** Parameters the model must extract from the user's message. */
  params?: ToolParam[];
  /**
   * Execute the tool. Render output into `ctx.replyEl` and return the text to
   * remember. Return `null` if the turn was aborted before producing output.
   */
  run(ctx: ToolContext): Promise<ToolResult | null>;
}

// ── Theme selection ───────────────────────────────────────────────────────────

/** Precomputed category prompt — built once at module load, never changes. */
const CATEGORY_PROMPT = (() => {
  const grouped: Record<string, string[]> = {};
  for (const theme of THEMES) {
    for (const cat of theme.suitedFor) {
      if (!grouped[cat]) grouped[cat] = [];
      if (!grouped[cat].includes(theme.name)) grouped[cat].push(theme.name);
    }
  }
  return Object.entries(grouped)
    .map(([cat, names]) => `- ${cat}: ${names.join(", ")}`)
    .join("\n");
})();

const CATEGORY_SYSTEM = `You choose the best presentation category for the user's topic. Each category has specific themes listed. Consider the AUDIENCE, TOPIC, and MOOD.

Reply with ONLY one category name. Nothing else.`;

interface ThemePick {
  id: string;
  name: string;
  description: string;
}

interface ThemeSelectionResult {
  primary: ThemePick;
  alternatives: ThemePick[];
  category: string;
}

/**
 * AI theme selection — optimized to 3 model calls:
 * 1. Pick category
 * 2. Pick top 3 themes from that category (one call, comma-separated)
 * 3. Verify primary choice
 */
async function pickThemesWithAI(userText: string): Promise<ThemeSelectionResult> {
  dlog.log("SP", `[pickThemesWithAI] ── BEGIN ── userText="${userText}"`);
  const fallback = THEMES[0];

  try {
    // Call 1: pick category
    const catResponse = await runInference(
      CATEGORY_SYSTEM,
      `User wants: "${userText}"\n\nCategories and their themes:\n${CATEGORY_PROMPT}\n\nBest category:`,
    );
    const chosenCat = catResponse.trim().toLowerCase().replace(/[^a-z-]/g, "") as PresentationType;
    dlog.log("SP", `[pickThemesWithAI] Call 1 — category: raw="${catResponse}" → "${chosenCat}"`);

    // Get themes for chosen category
    let categoryThemes = THEMES.filter((t) => t.suitedFor.includes(chosenCat));
    if (categoryThemes.length === 0) categoryThemes = THEMES.slice(0, 10);

    // Call 2: pick top 3 themes from that category in one shot
    const themeList = categoryThemes
      .map((t) => `${t.id} — ${t.name}: ${t.description}`)
      .join("\n");

    const themeResponse = await runInference(
      `You pick the 3 most relevant presentation themes for the user's request. Reply with ONLY 3 theme IDs separated by commas. Nothing else. Example: 123,456,789`,
      `User wants: "${userText}"\n\nThemes:\n${themeList}\n\nBest 3 theme IDs (comma separated):`,
    );

    // Parse comma-separated IDs
    const ids = themeResponse.trim().split(/[,\s]+/).map((s) => s.replace(/[^0-9]/g, "")).filter(Boolean);
    const picks: ThemePick[] = [];
    for (const id of ids) {
      const theme = getThemeById(id);
      if (theme && !picks.some((p) => p.id === theme.id)) {
        picks.push({ id: theme.id, name: theme.name, description: theme.description });
      }
      if (picks.length >= 3) break;
    }

    // Fill gaps from category if model gave fewer than 3
    for (const t of categoryThemes) {
      if (picks.length >= 3) break;
      if (!picks.some((p) => p.id === t.id)) {
        picks.push({ id: t.id, name: t.name, description: t.description });
      }
    }

    // Call 3: verify the primary choice
    const primary = picks[0] ?? { id: fallback.id, name: fallback.name, description: fallback.description };
    const verifyResponse = await runInference(
      `You verify theme choices. Is the chosen theme appropriate for the user's request? Reply ONLY "yes" or "no".`,
      `User wants: "${userText}"\nChosen theme: "${primary.name}" — ${primary.description}\n\nIs this appropriate? (yes/no):`,
    );

    const verdict = verifyResponse.trim().toLowerCase().replace(/[^a-z]/g, "");
    dlog.log("SP", `[pickThemesWithAI] Call 3 — verify verdict: "${verdict}"`);
    if (!verdict.startsWith("yes") && picks.length > 1) {
      const [rejected, second, ...rest] = picks;
      dlog.log("SP", `[pickThemesWithAI] primary REJECTED → swapping to "${second.name}"`);
      return { primary: second, alternatives: [rejected, ...rest].slice(0, 2), category: chosenCat };
    }

    dlog.log("SP", `[pickThemesWithAI] ── END ── primary="${primary.name}" alts=[${picks.slice(1,3).map(p=>p.name).join(", ")}]`);
    return {
      primary,
      alternatives: picks.slice(1, 3),
      category: chosenCat,
    };
  } catch (err) {
    dlog.error("SP", "[pickThemesWithAI] ── ERROR ──", err);
  }

  return {
    primary: { id: fallback.id, name: fallback.name, description: fallback.description },
    alternatives: [],
    category: "general",
  };
}

function observePage(): Promise<AgentObserveResponse> {
  dlog.log("SP", "[observePage] requesting observation…");
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "agentObserve" }, (resp) => {
      if (chrome.runtime.lastError || !resp) {
        dlog.error("SP", "[observePage] ERROR:", chrome.runtime.lastError?.message ?? "no response");
        resolve({ error: chrome.runtime.lastError?.message ?? "Couldn't reach the page" });
        return;
      }
      const obs = resp as AgentObserveResponse;
      dlog.log("SP", `[observePage] result: elements=${obs.observation?.elements.length ?? 0} hasScreenshot=${!!obs.dataUrl} error=${obs.error ?? "none"}`);
      resolve(obs);
    });
  });
}

function actOnPage(action: AgentAction, snapshotId: number): Promise<AgentActResponse> {
  dlog.log("SP", `[actOnPage] action=`, JSON.stringify(action), `snapshotId=${snapshotId}`);
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "agentAct", action, snapshotId }, (resp) => {
      if (chrome.runtime.lastError || !resp) {
        dlog.error("SP", "[actOnPage] ERROR:", chrome.runtime.lastError?.message ?? "no response");
        resolve({ ok: false, detail: chrome.runtime.lastError?.message ?? "Action failed" });
        return;
      }
      const result = resp as AgentActResponse;
      dlog.log("SP", `[actOnPage] result: ok=${result.ok} detail="${result.detail}"`);
      resolve(result);
    });
  });
}

/** Find element index by matching its label against a pattern. */
function findElement(
  elements: PageElement[],
  match: string | RegExp,
): number | undefined {
  const pattern = typeof match === "string"
    ? new RegExp(match.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
    : match;
  for (const el of elements) {
    if (pattern.test(el.label)) return el.index;
  }
  return undefined;
}

/** Render a recipe step progress card. */
function appendRecipeStep(
  container: HTMLElement,
  desc: string,
  status: "running" | "done" | "failed",
  detail?: string,
): HTMLElement {
  const step = document.createElement("div");
  step.className = `agent-step ${status}`;

  const act = document.createElement("div");
  act.className = "agent-step-action";
  act.textContent = desc;
  step.appendChild(act);

  if (detail) {
    const res = document.createElement("div");
    res.className = `agent-step-result ${status === "failed" ? "fail" : "ok"}`;
    res.textContent = detail;
    step.appendChild(res);
  }

  container.appendChild(step);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return step;
}

/** Execute a matched recipe — returns the final message for the user. */
async function executeRecipe(
  recipe: Recipe,
  params: Record<string, string>,
  replyEl: HTMLDivElement,
  userText: string,
): Promise<{ display: string; context: string }> {
  dlog.log("SP", `[executeRecipe] ── BEGIN ── recipe="${recipe.id}" label="${recipe.label}" steps=${recipe.steps.length} params=`, params);
  const replyBody = replyEl.querySelector(".msg-body") as HTMLElement;
  replyEl.classList.add("agent");

  const stepsEl = document.createElement("div");
  stepsEl.className = "agent-steps";
  replyEl.insertBefore(stepsEl, replyBody);

  replyBody.textContent = recipe.label + "…";

  const details: string[] = [];

  for (let i = 0; i < recipe.steps.length; i++) {
    const step = recipe.steps[i];
    if (stopRequested) {
      dlog.log("SP", `[executeRecipe] STOPPED at step ${i}`);
      return { display: "(stopped)", context: "(stopped)" };
    }

    dlog.log("SP", `[executeRecipe] step ${i}/${recipe.steps.length}: type="${step.type}" desc="${step.desc}"`);
    const result = await executeStep(step, params, stepsEl, userText);
    dlog.log("SP", `[executeRecipe] step ${i} result: ok=${result.ok} detail="${result.detail}"`);
    if (result.detail) details.push(result.detail);
    if (!result.ok) {
      const msg = `Couldn't complete: ${result.detail}. You may need to do this step manually.`;
      dlog.log("SP", `[executeRecipe] ── FAILED at step ${i} ──`);
      return { display: msg, context: msg };
    }
  }

  replyBody.textContent = "";
  const context = `[Action performed: ${recipe.label}. ${details.join(". ")}]`;
  dlog.log("SP", `[executeRecipe] ── END (success) ──`);
  return { display: recipe.doneMessage, context };
}

// ── Helpers for navigating the current tab ────────────────────────────────────

function getActiveTabUrl(): Promise<string | undefined> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "getActiveTabUrl" }, (resp) => {
      if (chrome.runtime.lastError || !resp) { resolve(undefined); return; }
      resolve(resp.url as string | undefined);
    });
  });
}

/** Extract the Zoho Show base origin from the current tab URL. */
function getShowOrigin(tabUrl: string): string | undefined {
  try {
    const url = new URL(tabUrl);
    if (/^show\.(zoho\.(com|in|eu|com\.au|com\.cn)|localzoho\.com)$/.test(url.hostname)) {
      return url.origin;
    }
    const match = url.hostname.match(/(?:^|\.)zoho\.(com|in|eu|com\.au|com\.cn)$/);
    if (match) return `https://show.zoho.${match[1]}`;
    if (url.hostname.includes("localzoho.com")) return `https://show.localzoho.com`;
  } catch { /* invalid URL */ }
  return undefined;
}

interface SlideContextResult {
  summary: string;
  metadata: SlideMetadata;
}

/** Last error from fetchSlideContext — for debugging in the UI. */
let lastSlideContextError = "";

/**
 * Fetch live slide data from the active tab.
 * Returns both the AI summary string and the parsed metadata (for UI rendering).
 * Retries once after a brief delay to handle cases where the editor is still loading.
 */
async function fetchSlideContext(): Promise<SlideContextResult | null> {
  dlog.log("SP", "[fetchSlideContext] ── BEGIN ──");
  const attempt = (): Promise<SlideContextResult | null> =>
    new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "getSlideData" }, (resp) => {
        if (chrome.runtime.lastError) {
          lastSlideContextError = chrome.runtime.lastError.message ?? "Unknown chrome error";
          resolve(null);
          return;
        }
        if (!resp || !resp.ok) {
          lastSlideContextError = resp?.error ?? "No response from background";
          resolve(null);
          return;
        }
        if (!resp.data) {
          lastSlideContextError = "Response OK but no data field";
          resolve(null);
          return;
        }
        try {
          const data = resp.data as Record<string, unknown>;
          lastSlideContextError = "";
          resolve({
            summary: summarizeSlideForAI(data, { includeColors: true }),
            metadata: getSlideMetadata(data),
          });
        } catch (e) {
          lastSlideContextError = `Parse error: ${e instanceof Error ? e.message : String(e)}`;
          resolve(null);
        }
      });
    });

  const first = await attempt();
  if (first) {
    dlog.log("SP", "[fetchSlideContext] ── END (first attempt) ── summary length:", first.summary.length);
    return first;
  }

  dlog.log("SP", "[fetchSlideContext] first attempt failed, retrying after 800ms…");
  await new Promise((r) => setTimeout(r, 800));
  const second = await attempt();
  dlog.log("SP", `[fetchSlideContext] ── END (second attempt) ── ${second ? "got data" : `FAILED: ${lastSlideContextError}`}`);
  return second;
}

// ── Document context ($.docData.masters) ─────────────────────────────────────

interface DocContextResult {
  summary: string;
  masterCount: number;
  parsedMasters: ReturnType<typeof getMastersInfo>;
}

let lastDocContextError = "";

/**
 * Fetch the document's master-slide array from the active tab.
 * Returns a compact AI summary of every master (theme, fonts, colors).
 */
async function fetchDocContext(): Promise<DocContextResult | null> {
  dlog.log("SP", "[fetchDocContext] ── BEGIN ──");
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "getDocData" }, (resp) => {
      if (chrome.runtime.lastError) {
        lastDocContextError = chrome.runtime.lastError.message ?? "Unknown chrome error";
        dlog.error("SP", "[fetchDocContext] chrome error:", lastDocContextError);
        resolve(null);
        return;
      }
      if (!resp || !resp.ok) {
        lastDocContextError = resp?.error ?? "No response from background";
        dlog.error("SP", "[fetchDocContext] bad response:", lastDocContextError);
        resolve(null);
        return;
      }
      if (!Array.isArray(resp.data)) {
        lastDocContextError = "Response OK but masters is not an array";
        resolve(null);
        return;
      }
      try {
        lastDocContextError = "";
        const data = resp.data as unknown[];
        const result: DocContextResult = {
          summary: summarizeDocForAI(data, { includeColors: true }),
          masterCount: data.length,
          parsedMasters: getMastersInfo(data),
        };
        dlog.log("SP", `[fetchDocContext] ── END ── masters=${result.masterCount} summary length=${result.summary.length}`);
        resolve(result);
      } catch (e) {
        lastDocContextError = `Parse error: ${e instanceof Error ? e.message : String(e)}`;
        dlog.error("SP", "[fetchDocContext] parse error:", lastDocContextError);
        resolve(null);
      }
    });
  });
}

/** Render color circles inline into a container element. */
function renderColorPalette(colors: { role: string; hex: string }[]): HTMLElement {
  const el = document.createElement("div");
  el.className = "theme-palette";
  for (const c of colors) {
    const circle = document.createElement("span");
    circle.className = "theme-color-dot";
    circle.style.backgroundColor = c.hex;
    circle.title = `${c.role}: ${c.hex}`;
    el.appendChild(circle);
  }
  return el;
}

function generateUUID(): string {
  return crypto.randomUUID().toUpperCase();
}

/**
 * Change the theme on the currently open presentation by calling
 * $.SlideEditor.theme.changeTheme — the same API the editor uses internally.
 */
function changeThemeOnCurrentTab(
  _origin: string,
  themeId: string,
  themeName: string,
  cardsEl: HTMLElement,
): void {
  chrome.runtime.sendMessage(
    { type: "changeTheme", themeId },
    () => {
      // Update the active card UI
      cardsEl.querySelectorAll(".theme-card").forEach((c) => {
        c.classList.remove("active");
        const nameEl = c.querySelector(".theme-card-name");
        if (nameEl) nameEl.textContent = nameEl.textContent!.replace(" ✓", "");
      });
      const clickedCard = cardsEl.querySelector(`[data-theme-id="${themeId}"]`);
      if (clickedCard) {
        clickedCard.classList.add("active");
        const nameEl = clickedCard.querySelector(".theme-card-name");
        if (nameEl) nameEl.textContent = `${themeName} ✓`;
      }
    },
  );
}

/** Execute one recipe step. */
async function executeStep(
  step: RecipeStep,
  params: Record<string, string>,
  stepsEl: HTMLElement,
  userText: string,
): Promise<{ ok: boolean; detail: string }> {
  switch (step.type) {
    case "wait": {
      appendRecipeStep(stepsEl, step.desc, "done");
      await sleep(step.ms);
      return { ok: true, detail: "Waited" };
    }

    case "waitForTab": {
      const stepEl = appendRecipeStep(stepsEl, step.desc, "running");
      await sleep(1500);
      stepEl.classList.replace("running", "done");
      return { ok: true, detail: "Tab ready" };
    }

    case "createPresentation": {
      const stepEl = appendRecipeStep(stepsEl, step.desc, "running");

      // 1. Get current tab URL to derive the Zoho Show origin
      const tabUrl = await getActiveTabUrl();
      if (!tabUrl) {
        stepEl.classList.replace("running", "failed");
        return { ok: false, detail: "Couldn't get the current tab URL" };
      }
      const origin = getShowOrigin(tabUrl);
      if (!origin) {
        stepEl.classList.replace("running", "failed");
        return { ok: false, detail: "Not on a Zoho Show page" };
      }

      // 2. Let the AI model pick top 3 themes
      const statusEl = document.createElement("div");
      statusEl.className = "agent-step-result";
      statusEl.textContent = "AI is choosing themes…";
      stepEl.appendChild(statusEl);

      const { primary, alternatives, category } = await pickThemesWithAI(userText);
      statusEl.textContent = `Theme: ${primary.name}`;

      // 3. Build URL + sessionStorage payload for the primary theme
      const sessionId = generateUUID();
      const docName = "Untitled Presentation";
      const createUrl = `${origin}/show/new?createUsingTHEMES=true&doc_name=${encodeURIComponent(docName)}&theme_id=${primary.id}&l_id=${sessionId}`;
      const payload = {
        docName,
        themeInfo: { themeId: primary.id },
        themeID: primary.id,
      };

      // 4. Inject sessionStorage + navigate in the same tab
      const result = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
        chrome.runtime.sendMessage(
          { type: "createPresentation", url: createUrl, payload, sessionId },
          (resp) => {
            if (chrome.runtime.lastError || !resp) {
              resolve({ ok: false, error: chrome.runtime.lastError?.message ?? "Failed" });
              return;
            }
            resolve(resp as { ok: boolean; error?: string });
          },
        );
      });

      if (!result.ok) {
        stepEl.classList.replace("running", "failed");
        return { ok: false, detail: result.error ?? "Couldn't create presentation" };
      }

      stepEl.classList.replace("running", "done");
      statusEl.className = "agent-step-result ok";

      // 5. Render theme cards (primary + alternatives)
      const allThemes = [primary, ...alternatives];
      const cardsEl = document.createElement("div");
      cardsEl.className = "theme-cards";

      for (let i = 0; i < allThemes.length; i++) {
        const t = allThemes[i];
        const card = document.createElement("div");
        card.className = `theme-card${i === 0 ? " active" : ""}`;
        card.dataset.themeId = t.id;
        card.innerHTML = `
          <div class="theme-card-name">${t.name}${i === 0 ? " ✓" : ""}</div>
          <div class="theme-card-desc">${t.description}</div>
        `;
        card.addEventListener("click", () => {
          if (card.classList.contains("active")) return;
          changeThemeOnCurrentTab(origin, t.id, t.name, cardsEl);
        });
        cardsEl.appendChild(card);
      }

      stepsEl.appendChild(cardsEl);

      await sleep(2000);
      const altNames = alternatives.map((a) => a.name).join(", ");
      return { ok: true, detail: `I created a new presentation using the "${primary.name}" theme (category: "${category}"). Other options: ${altNames}. Click any alternative to switch themes.` };
    }

    case "changeTheme": {
      const stepEl = appendRecipeStep(stepsEl, step.desc, "running");

      // Use the theme_name extracted during tool selection; fall back to
      // inference only if the router didn't provide it.
      let requestedName = (params.theme_name ?? "").trim().replace(/[^a-zA-Z0-9 -]/g, "");
      if (!requestedName) {
        const nameResponse = await runInference(
          `You extract the theme name from the user's request. Reply with ONLY the theme name, nothing else.`,
          `User says: "${userText}"\n\nExtract the theme name the user wants to switch to:`,
        );
        requestedName = nameResponse.trim().replace(/[^a-zA-Z0-9 -]/g, "");
      }
      const theme = getThemeByName(requestedName);

      if (!theme) {
        stepEl.classList.replace("running", "failed");
        return { ok: false, detail: `Couldn't find a theme named "${requestedName}". Check the name and try again.` };
      }

      // Call the background to execute the theme change
      const result = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
        chrome.runtime.sendMessage(
          { type: "changeTheme", themeId: theme.id },
          (resp) => {
            if (chrome.runtime.lastError || !resp) {
              resolve({ ok: false, error: chrome.runtime.lastError?.message ?? "Failed" });
              return;
            }
            resolve({ ok: true });
          },
        );
      });

      if (!result.ok) {
        stepEl.classList.replace("running", "failed");
        return { ok: false, detail: result.error ?? "Couldn't change theme" };
      }

      stepEl.classList.replace("running", "done");
      return { ok: true, detail: `Changed the presentation theme to "${theme.name}".` };
    }

    case "key": {
      appendRecipeStep(stepsEl, step.desc, "done");
      const action: AgentAction = { type: "key", key: step.key };
      // Use a dummy snapshot; key press doesn't need element targeting
      const obs = await observePage();
      if (!obs.observation) return { ok: false, detail: "Couldn't reach the page" };
      const result = await actOnPage(action, obs.observation.snapshotId);
      return result;
    }

    case "click": {
      const stepEl = appendRecipeStep(stepsEl, step.desc, "running");
      const obs = await observePage();
      if (!obs.observation) {
        stepEl.classList.replace("running", "failed");
        return { ok: false, detail: "Couldn't reach the page" };
      }

      // Resolve the match pattern — handle PARAM: references
      let match = step.match;
      if (typeof match === "string" && match.startsWith("PARAM:")) {
        const paramKey = match.slice(6);
        const paramValue = params[paramKey];
        if (!paramValue) {
          stepEl.classList.replace("running", "failed");
          return { ok: false, detail: `Missing parameter: ${paramKey}` };
        }
        match = paramValue;
      }

      const idx = findElement(obs.observation.elements, match);
      if (idx === undefined) {
        stepEl.classList.replace("running", "failed");
        const matchStr = typeof match === "string" ? match : match.source;
        return { ok: false, detail: `Couldn't find "${matchStr}" on the page` };
      }

      const action: AgentAction = { type: "click", index: idx };
      const result = await actOnPage(action, obs.observation.snapshotId);
      stepEl.classList.replace("running", result.ok ? "done" : "failed");
      if (result.ok) {
        const res = document.createElement("div");
        res.className = "agent-step-result ok";
        res.textContent = result.detail;
        stepEl.appendChild(res);
      }
      return result;
    }

    case "clickSelector": {
      appendRecipeStep(stepsEl, step.desc, "running");
      // Direct selector click — executed via a special action type
      const obs = await observePage();
      if (!obs.observation) return { ok: false, detail: "Couldn't reach the page" };
      // We'll use the general click with index -1 and fallback to selector
      // Actually, we don't have selector support in actions — use element matching as fallback
      return { ok: false, detail: "Selector-based click not implemented" };
    }

    case "type":
    case "typeParam": {
      const stepEl = appendRecipeStep(stepsEl, step.desc, "running");
      const obs = await observePage();
      if (!obs.observation) {
        stepEl.classList.replace("running", "failed");
        return { ok: false, detail: "Couldn't reach the page" };
      }

      const text = step.type === "typeParam" ? (params[step.param] ?? "") : step.text;
      const idx = findElement(obs.observation.elements, step.match);
      if (idx === undefined) {
        stepEl.classList.replace("running", "failed");
        return { ok: false, detail: "Couldn't find the input field" };
      }

      const action: AgentAction = { type: "type", index: idx, text, submit: step.submit };
      const result = await actOnPage(action, obs.observation.snapshotId);
      stepEl.classList.replace("running", result.ok ? "done" : "failed");
      return result;
    }

    default:
      return { ok: false, detail: "Unknown step type" };
  }
}

// ── Tool registry ─────────────────────────────────────────────────────────────
//
// The single source of truth for the assistant's capabilities. Order is not
// significant. The "none" tool is the fallback for plain conversation.

/** Run a recipe-backed tool and shape it into a ToolResult. */
async function runRecipeTool(recipeId: string, ctx: ToolContext): Promise<ToolResult> {
  dlog.log("SP", `[runRecipeTool] recipeId="${recipeId}" userText="${ctx.userText}"`);
  const recipe = RECIPES.find((r) => r.id === recipeId);
  if (!recipe) {
    dlog.error("SP", `[runRecipeTool] recipe "${recipeId}" NOT FOUND in RECIPES`);
    const msg = "That action isn't available right now.";
    setMessageContent(ctx.replyEl, msg);
    return { assistantText: msg };
  }
  const { display, context } = await executeRecipe(recipe, ctx.args, ctx.replyEl, ctx.userText);
  dlog.log("SP", `[runRecipeTool] done → display="${display.slice(0, 100)}" context="${context.slice(0, 100)}"`);
  setMessageContent(ctx.replyEl, display);
  return { assistantText: context, remember: true };
}

const TOOLS: Tool[] = [
  {
    name: "create_presentation",
    description:
      "user wants to create / make / start / build / design a NEW presentation, deck, or slideshow",
    run: (ctx) => runRecipeTool("create-presentation", ctx),
  },
  {
    name: "change_theme",
    description:
      "user wants to change / switch / apply a different theme or template to the CURRENT presentation",
    params: [
      { name: "theme_name", type: "string", description: "the theme name or style the user wants", required: true },
    ],
    run: (ctx) => runRecipeTool("change-theme", ctx),
  },
  {
    name: "screenshot",
    description:
      "user wants to SEE or analyse something VISUAL on the current slide (colors, layout, images, the text shown, charts, diagrams)",
    async run(ctx) {
      dlog.log("SP", `[tool:screenshot] ── RUN ── userText="${ctx.userText}" mode=${ctx.mode}`);
      ctx.setStatus("Capturing the page…");
      const rawUrl = await captureScreenshotViaCDP();
      dlog.log("SP", `[tool:screenshot] screenshot captured, dataUrl length=${rawUrl.length}`);
      ctx.setStatus("Analysing the slide…");
      const image = await downscaleToDataUrl(rawUrl, MODES[ctx.mode].imageMaxDim);
      dlog.log("SP", `[tool:screenshot] downscaled image length=${image.length}`);
      if (ctx.isStopped()) { dlog.log("SP", "[tool:screenshot] stopped"); return null; }
      const reply = await runChat(ctx.userText, image, ctx.mode, ctx.replyEl);
      dlog.log("SP", `[tool:screenshot] ── DONE ── reply length=${reply.length}`);
      setMessageContent(ctx.replyEl, reply);
      return { assistantText: reply };
    },
  },
  {
    name: "doccontext",
    description:
      "user asks about the presentation's DESIGN — what theme(s) or master(s) the document uses, what fonts or colors are in the deck, how many themes/masters exist, or any design property (theme name, font name, color palette) because these belong to the document masters, not a single slide",
    async run(ctx) {
      dlog.log("SP", `[tool:doccontext] ── RUN ── userText="${ctx.userText}"`);
      ctx.setStatus("Reading document data…");

      // Fetch both sources in parallel — masters for doc-wide design, slide for current active state
      const [docResult, slideResult] = await Promise.all([fetchDocContext(), fetchSlideContext()]);
      if (ctx.isStopped()) { dlog.log("SP", "[tool:doccontext] stopped"); return null; }

      if (!docResult) {
        dlog.log("SP", `[tool:doccontext] FAILED: ${lastDocContextError}`);
        const msg = `Couldn't read the document data.\nReason: ${lastDocContextError || "unknown"}\n\nMake sure the Zoho Show editor is open.`;
        setMessageContent(ctx.replyEl, msg);
        return { assistantText: msg };
      }

      dlog.log("SP", `[tool:doccontext] masters=${docResult.masterCount} summary length=${docResult.summary.length}`);
      dlog.log("SP", `[tool:doccontext] slide context: ${slideResult ? `OK (${slideResult.summary.length} chars)` : "unavailable"}`);

      // Build reply deterministically — never rely on the model to enumerate masters,
      // a small model will drop themes when there are many (data loss).
      const masterLines = docResult.parsedMasters
        .map((m, i) =>
          `${i + 1}. **${m.name}**${m.fonts.length ? ` — Fonts: ${m.fonts.join(", ")}` : ""}`
        )
        .join("\n");

      const currentThemeName = slideResult?.metadata?.theme?.name ?? null;
      const currentPart = currentThemeName
        ? `\n\nYour current slide is using **${currentThemeName}**.`
        : "";

      const reply = `This presentation has **${docResult.masterCount}** theme(s):\n\n${masterLines}${currentPart}`;

      dlog.log("SP", `[tool:doccontext] ── DONE ── reply="${reply.slice(0, 120)}…"`);
      setMessageContent(ctx.replyEl, reply);

      // Append one color-palette strip per master
      const body = ctx.replyEl.querySelector(".msg-body");
      if (body) {
        for (const m of docResult.parsedMasters) {
          if (m.colors.length) body.appendChild(renderColorPalette(m.colors));
        }
      }

      return { assistantText: reply };
    },
  },
  {
    name: "slidecontext",
    description:
      "user asks about the CURRENT slide's position or structure — which slide number they are on, the slide index, the slide name, or the slide type/layout — NOT themes, fonts, or colors (those are document-level, use doccontext)",
    async run(ctx) {
      dlog.log("SP", `[tool:slidecontext] ── RUN ── userText="${ctx.userText}"`);
      ctx.setStatus("Reading presentation data…");
      const result = await fetchSlideContext();
      if (ctx.isStopped()) { dlog.log("SP", "[tool:slidecontext] stopped"); return null; }

      if (!result) {
        dlog.log("SP", `[tool:slidecontext] FAILED to get slide data: ${lastSlideContextError}`);
        const msg = `Couldn't read the presentation data.\nReason: ${lastSlideContextError || "unknown"}\n\nMake sure the Zoho Show editor is open and a slide is selected.`;
        setMessageContent(ctx.replyEl, msg);
        return { assistantText: msg };
      }

      dlog.log("SP", `[tool:slidecontext] got slide data, summary length=${result.summary.length}`);
      const enriched = `[Current presentation state:\n${result.summary}]\n\n${ctx.userText}`;
      const reply = await runChat(enriched, undefined, ctx.mode, ctx.replyEl);
      dlog.log("SP", `[tool:slidecontext] ── DONE ── reply length=${reply.length}`);
      setMessageContent(ctx.replyEl, reply);

      if (result.metadata.theme?.colors.length) {
        const paletteEl = renderColorPalette(result.metadata.theme.colors);
        const body = ctx.replyEl.querySelector(".msg-body");
        if (body) body.appendChild(paletteEl);
      }

      return { assistantText: reply };
    },
  },
  {
    name: "none",
    description:
      "general questions, help, explanations, web links, or anything that doesn't need a slide action",
    async run(ctx) {
      dlog.log("SP", `[tool:none] ── RUN ── userText="${ctx.userText}" hasAttachedImage=${!!ctx.attachedImage}`);
      let enriched = ctx.userText;

      const slideResult = await fetchSlideContext();
      if (slideResult) {
        dlog.log("SP", `[tool:none] injecting slide context (${slideResult.summary.length} chars)`);
        enriched = `[Current presentation state:\n${slideResult.summary}]\n\n${enriched}`;
      } else {
        dlog.log("SP", `[tool:none] no slide context available`);
      }

      URL_RE.lastIndex = 0;
      if (URL_RE.test(ctx.userText)) {
        dlog.log("SP", "[tool:none] URL detected in user text, fetching…");
        ctx.setStatus("Reading web page…");
        const fetched = await fetchUrlsInText(ctx.userText);
        dlog.log("SP", `[tool:none] fetched URL content length=${fetched.length}`);
        enriched = slideResult
          ? `[Current presentation state:\n${slideResult.summary}]\n\n${fetched}`
          : fetched;
        if (ctx.isStopped()) { dlog.log("SP", "[tool:none] stopped after URL fetch"); return null; }
      }

      let image: string | undefined;
      if (ctx.attachedImage) {
        dlog.log("SP", "[tool:none] has attached image, downscaling…");
        ctx.setStatus("Analysing the image…");
        image = await downscaleToDataUrl(ctx.attachedImage, MODES[ctx.mode].imageMaxDim);
        dlog.log("SP", `[tool:none] downscaled image length=${image.length}`);
        if (ctx.isStopped()) { dlog.log("SP", "[tool:none] stopped after image downscale"); return null; }
      }

      dlog.log("SP", `[tool:none] calling runChat with enriched text length=${enriched.length}`);
      const reply = await runChat(enriched, image, ctx.mode, ctx.replyEl);
      dlog.log("SP", `[tool:none] ── DONE ── reply length=${reply.length}`);
      setMessageContent(ctx.replyEl, reply);
      return { assistantText: reply };
    },
  },
];

/** The fallback tool used when selection fails or the model is ambiguous. */
const DEFAULT_TOOL = TOOLS.find((t) => t.name === "none")!;

/** Build the tool definitions block for the selection prompt — generated once. */
const TOOL_DEFS_BLOCK = TOOLS.map((t) => {
  const paramObj: Record<string, string> = {};
  if (t.params?.length) {
    for (const p of t.params) paramObj[p.name] = p.description;
  }
  return JSON.stringify({ tool: t.name, description: t.description, ...(t.params?.length ? { args: paramObj } : {}) });
}).join("\n");

/** System prompt for tool selection — single call, JSON output. */
const TOOL_SELECT_SYSTEM = `You are a tool router for a presentation app. Given the user's message, pick the ONE best tool and extract any required arguments.

Tool definitions:
${TOOL_DEFS_BLOCK}

Routing rules (override description if there is ambiguity):
- Any question about theme, fonts, or colors → ALWAYS use doccontext (these come from document masters, not a single slide).
- Any question about slide number, slide index, or which slide is open → use slidecontext.

Reply with a single JSON object: {"tool":"<name>","args":{<extracted values or empty>}}
Output ONLY the JSON object. Nothing else.`;

/** Resolve a tool name from model output, tolerant of casing and partial matches. */
function resolveToolName(raw: string): Tool | null {
  const cleaned = raw.toLowerCase().replace(/[^a-z_]/g, "");
  dlog.log("SP", `[resolveToolName] raw="${raw}" → cleaned="${cleaned}"`);
  if (!cleaned) { dlog.log("SP", "[resolveToolName] empty after cleaning → null"); return null; }
  const match = TOOLS.find((t) => {
    const name = t.name.toLowerCase().replace(/[^a-z_]/g, "");
    return cleaned === name || (cleaned.length >= 4 && (name.startsWith(cleaned) || cleaned.startsWith(name)));
  }) ?? null;
  dlog.log("SP", `[resolveToolName] resolved → ${match?.name ?? "null"}`);
  return match;
}

/** Result of the single-call tool selection: which tool + extracted args. */
interface ToolSelection {
  tool: Tool;
  args: Record<string, string>;
}

/**
 * Single-call tool selection: the model sees every tool definition (with param
 * schemas) and replies with one JSON object naming the tool and its arguments.
 *
 *   User Prompt → LLM Analyzes Tool Definitions → Match / Route → JSON Args
 */
async function selectTool(userText: string): Promise<ToolSelection> {
  dlog.log("SP", `[selectTool] ── BEGIN ── userText="${userText}"`);
  try {
    const response = await runInference(
      TOOL_SELECT_SYSTEM,
      `User says: "${userText}"`,
    );
    dlog.log("SP", `[selectTool] model response: "${response}"`);

    // Parse JSON from the model's output.
    const parsed = extractJsonObject(response);
    if (parsed && typeof parsed.tool === "string") {
      const tool = resolveToolName(parsed.tool as string);
      const args: Record<string, string> = {};
      if (parsed.args && typeof parsed.args === "object") {
        for (const [k, v] of Object.entries(parsed.args as Record<string, unknown>)) {
          if (typeof v === "string") args[k] = v;
        }
      }
      const resolved = tool ?? DEFAULT_TOOL;
      dlog.log("SP", `[selectTool] ── END ── tool="${resolved.name}" args=${JSON.stringify(args)}`);
      return { tool: resolved, args };
    }

    // Fallback: model returned a bare tool name instead of JSON.
    const tool = resolveToolName(response);
    dlog.log("SP", `[selectTool] ── END ── bare-name fallback → "${tool?.name ?? "none"}"`);
    return { tool: tool ?? DEFAULT_TOOL, args: {} };
  } catch (err) {
    dlog.error("SP", "[selectTool] ── ERROR ──", err);
  }
  dlog.log("SP", "[selectTool] ── END ── fell through to DEFAULT (none)");
  return { tool: DEFAULT_TOOL, args: {} };
}


async function sendMessage() {
  const rawText = inputEl.value.trim();
  const hasImage = !!attachedImageDataUrl;
  dlog.log("SP", `[sendMessage] ── BEGIN ── rawText="${rawText}" hasImage=${hasImage} busy=${busy} modelReady=${modelReady} port=${!!port}`);
  if ((!rawText && !hasImage) || busy || !modelReady || !port) {
    dlog.log("SP", "[sendMessage] ── BLOCKED ── precondition failed, returning");
    return;
  }
  const text = rawText || "What's in this image?";

  const activeMode = mode;

  const pendingImage = attachedImageDataUrl;

  dlog.log("SP", `[sendMessage] mode="${activeMode}" ctxTokens=${ctxTokens} activeCtx=${activeCtx} hasAttachedImage=${!!pendingImage} interactionMode="${interactionMode}"`);
  dlog.log("SP", `[sendMessage] chatHistory length=${chatHistory.length}`);

  generating = true;
  stopRequested = false;
  busy = true;
  setReady(false);
  inputEl.value = "";
  autoResizeInput();
  clearAttachedImage();

  appendMessage("user", text, pendingImage);
  chatHistory.push({ role: "user", text });

  const replyEl = appendMessage("assistant", "…");
  replyEl.classList.add("typing");

  const replyBody = replyEl.querySelector(".msg-body") as HTMLElement;

    let selection: ToolSelection = { tool: DEFAULT_TOOL, args: {} };

    try {
      // When the user attaches an image we go straight to chat (the model must
      // look at it). Otherwise the model routes the message to a tool.
      if (!pendingImage) {
        replyBody.textContent = "Understanding your request…";
        dlog.log("SP", "[sendMessage] no image attached → routing through selectTool…");
        selection = await selectTool(text);
      } else {
        dlog.log("SP", "[sendMessage] image attached → skipping tool selection, using DEFAULT (none)");
      }

      const ctx: ToolContext = {
        userText: text,
        mode: activeMode,
        replyEl,
        attachedImage: pendingImage ?? undefined,
        args: selection.args,
        setStatus: (s) => { replyBody.textContent = s; },
        isStopped: () => stopRequested,
      };

      dlog.log("SP", `[sendMessage] selected tool="${selection.tool.name}" args=${JSON.stringify(selection.args)} — now executing tool.run()…`);
      const result = await selection.tool.run(ctx);
    replyEl.classList.remove("typing");

    dlog.log("SP", `[sendMessage] tool.run() finished — result=${result ? `{text: "${result.assistantText.slice(0, 100)}…", remember: ${result.remember ?? false}}` : "null"} stopRequested=${stopRequested}`);

    // A null result means the turn was aborted before producing output.
    if (!result || (stopRequested && result.assistantText === "(stopped)")) {
      dlog.log("SP", "[sendMessage] result null or stopped — dropping user turn");
      replyBody.textContent = "(stopped)";
      chatHistory.pop(); // drop the dangling user turn
      return;
    }

    chatHistory.push({ role: "assistant", text: result.assistantText });

    // Persist tool outcomes into the model session so follow-ups have context.
    if (result.remember && port) {
      dlog.log("SP", "[sendMessage] injecting tool context into session");
      port.postMessage({ cmd: "injectContext", userText: text, assistantText: result.assistantText });
    }
  } catch (err) {
    dlog.error("SP", "[sendMessage] ── ERROR ──", err);
    replyBody.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
    replyEl.classList.remove("typing");
    chatHistory.pop();
  } finally {
    dlog.log("SP", "[sendMessage] ── END ── cleanup");
    generating = false;
    stopRequested = false;
    activeReqId = undefined;
    busy = false;
    stopBtn.disabled = false;
    setReady(true);
    setIdleStatus();
    inputEl.focus();
  }
}

function stopGeneration() {
  if (!generating || stopRequested) return;
  stopRequested = true;
  stopBtn.disabled = true;
  if (port && activeReqId) {
    try {
      port.postMessage({ cmd: "abort", reqId: activeReqId });
    } catch {
      // Port already gone
    }
  }
}

// ── Close dropdowns on outside click ──────────────────────────────────────────

function closeAllDropdowns(e?: MouseEvent) {
  if (e) {
    if (!ctxDropdownBtn.contains(e.target as Node) && !ctxDropdownMenu.contains(e.target as Node)) {
      closeCtxDropdown();
    }
    if (!modeDropdownBtn.contains(e.target as Node) && !modeDropdownMenu.contains(e.target as Node)) {
      closeModeDropdown();
    }
  } else {
    closeCtxDropdown();
    closeModeDropdown();
  }
}

// ── UI events ─────────────────────────────────────────────────────────────────

themeToggle.addEventListener("click", toggleTheme);

newChatBtn.addEventListener("click", () => {
  resetChat();
  clearAttachedImage();
  if (port) {
    try {
      port.postMessage({ cmd: "reset" });
    } catch {
      // Port already gone
    }
  }
  setReady(modelReady);
  inputEl.focus();
});

// Context dropdown toggle
ctxDropdownBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (ctxDropdownMenu.hidden) {
    closeModeDropdown();
    openCtxDropdown();
  } else {
    closeCtxDropdown();
  }
});

// Context dropdown options
ctxDropdownMenu.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest(".ctx-option") as HTMLElement | null;
  if (!btn) return;
  const nextMode = btn.dataset.mode as EffortMode;
  if (isEffortMode(nextMode)) {
    setModeAndCtx(nextMode);
  }
});

// Mode dropdown toggle
modeDropdownBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (modeDropdownMenu.hidden) {
    closeCtxDropdown();
    openModeDropdown();
  } else {
    closeModeDropdown();
  }
});

// Mode dropdown options
modeDropdownMenu.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest(".mode-option") as HTMLElement | null;
  if (!btn) return;
  const nextInteraction = btn.dataset.interaction as "ask" | "autopilot";
  if (nextInteraction === "ask" || nextInteraction === "autopilot") {
    setInteractionMode(nextInteraction);
  }
});

// Close dropdowns on outside click
document.addEventListener("click", closeAllDropdowns);

// ── Attach button → file picker ─────────────────────────────────────────

attachBtn.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) void attachImageFile(file);
});

imagePreviewRemove.addEventListener("click", clearAttachedImage);

// ── Paste image from clipboard ──────────────────────────────────────────

inputEl.addEventListener("paste", (e) => {
  const dt = e.clipboardData;
  if (!dt) return;
  const file = extractImageFromDataTransfer(dt);
  if (file) {
    e.preventDefault();
    void attachImageFile(file);
  }
});

// ── Drag-and-drop image ─────────────────────────────────────────────────

let dragCounter = 0;

function hasImageInDrag(e: DragEvent): boolean {
  if (!e.dataTransfer) return false;
  for (const item of e.dataTransfer.items) {
    if (item.kind === "file" && item.type.startsWith("image/")) return true;
  }
  return false;
}

document.addEventListener("dragenter", (e) => {
  if (!hasImageInDrag(e)) return;
  e.preventDefault();
  dragCounter++;
  if (dragCounter === 1) dropOverlay.hidden = false;
});

document.addEventListener("dragleave", () => {
  dragCounter--;
  if (dragCounter <= 0) {
    dragCounter = 0;
    dropOverlay.hidden = true;
  }
});

document.addEventListener("dragover", (e) => {
  if (!hasImageInDrag(e)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
});

document.addEventListener("drop", (e) => {
  e.preventDefault();
  dragCounter = 0;
  dropOverlay.hidden = true;
  if (!e.dataTransfer) return;
  const file = extractImageFromDataTransfer(e.dataTransfer);
  if (file) void attachImageFile(file);
});

// Input handling
inputEl.addEventListener("input", () => {
  setReady(modelReady);
  autoResizeInput();
});

inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void sendMessage();
  }
});

sendBtn.addEventListener("click", () => void sendMessage());
stopBtn.addEventListener("click", stopGeneration);

// ── Init ──────────────────────────────────────────────────────────────────────

initDebugPanel();
loadTheme();
loadModeAndCtx();
loadInteractionMode();
