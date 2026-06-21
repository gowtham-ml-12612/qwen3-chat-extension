// Side panel entry point — orchestrates modules.
// This file wires together the engine client, tool registry, UI, and state.

import { ENGINE_PORT, type EngineEvent } from "../messages";
import { isContextTokens } from "../models";
import { MODES, DEFAULT_MODE, isEffortMode, type EffortMode } from "../modes";
import { extractJsonObject } from "../actions";
import type { AgentAction, PageElement } from "../actions";
import { dlog, initDebugPanel } from "../debug-log";
import { summarizeSlideForAI, getSlideMetadata, summarizeDocForAI, getMastersInfo } from "../slide-data";
import { THEMES, getThemeById, getThemeByName } from "../themes";
import { zohoAPI, getShowOrigin } from "../zoho/api";
import { renderMarkdown } from "./markdown";
import { downscaleToDataUrl, readFileAsDataUrl, extractImageFromDataTransfer } from "./image-utils";
import {
  createInitialState,
  MODE_CTX_MAP,
  MODE_STORAGE_KEY,
  CTX_STORAGE_KEY,
  THEME_STORAGE_KEY,
  INTERACTION_STORAGE_KEY,
  loadStoredPreferences,
  persistMode,
  persistTheme,
  persistInteractionMode,
  type InteractionMode,
  type PanelTheme,
} from "./state";
import { registerTools, selectTool, getDefaultTool } from "./tool-registry";
import { createConfirmationDialog, setConfirmationUI, executeWithConfirmation } from "./confirmation";
import type { HistoryTurn, Pending, ToolContext, ToolResult, Tool } from "./types";

// Tool imports
import {
  createPresentationTool,
  setCreatePresentationInference,
  changeThemeTool,
  setChangeThemeInference,
  createScreenshotTool,
  createDoccontextTool,
  createSlidecontextTool,
  createChatTool,
  browseThemesTool,
  setBrowseThemesSetContent,
  createSlideinfoTool,
} from "./tools";

// ── State ─────────────────────────────────────────────────────────────────────

const state = createInitialState();

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

const loadingOverlay = q("loading-overlay");
const loadingPhrase  = q("loading-phrase");
const loadingFill    = q("loading-progress-fill");
const loadingPct     = q("loading-pct");

const ctxDropdownBtn   = q("ctx-dropdown-btn") as HTMLButtonElement;
const ctxDropdownLabel = q("ctx-dropdown-label");
const ctxDropdownMenu  = q("ctx-dropdown-menu");

const modeDropdownBtn  = q("mode-dropdown-btn") as HTMLButtonElement;
const modeDropdownLabel = q("mode-dropdown-label");
const modeDropdownMenu = q("mode-dropdown-menu");

// ── Confirmation UI ───────────────────────────────────────────────────────────

const confirmUI = createConfirmationDialog(document.body);
setConfirmationUI(confirmUI);

// ── Helpers ───────────────────────────────────────────────────────────────────

function setReady(ready: boolean) {
  state.modelReady = ready;
  inputEl.disabled = !ready;
  newChatBtn.disabled = !ready || state.busy;
  attachBtn.disabled = !ready || state.busy;
  sendBtn.disabled = !ready || state.busy || (inputEl.value.trim() === "" && !state.attachedImageDataUrl);
  sendBtn.hidden = state.generating;
  stopBtn.hidden = !state.generating;
}

// ── Loading overlay ───────────────────────────────────────────────────────────

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
    if (loadingCurrentPct >= target) { clearInterval(initInterval); return; }
    loadingCurrentPct = Math.min(loadingCurrentPct + 1, target);
    loadingFill.style.width = `${loadingCurrentPct}%`;
    loadingPct.textContent = `${loadingCurrentPct}%`;
  }, speed);
}

function updateLoadingProgress(progress: number) {
  const target = Math.round(progress * 75);
  const gap = target - loadingCurrentPct;
  const speed = gap > 50 ? 10 : gap > 20 ? 30 : gap > 5 ? 80 : 150;
  stepTo(target, speed);
  if (progress >= 1) {
    clearInterval(phraseInterval);
    loadingPhrase.textContent = INIT_PHRASES[Math.floor(Math.random() * INIT_PHRASES.length)];
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
  setTimeout(() => { loadingOverlay.hidden = true; }, 300);
}

// ── Context-window usage ring ─────────────────────────────────────────────────

const ctxRingWrap = q("ctx-ring-wrap") as HTMLElement;
const ctxRingFg = document.getElementById("ctx-ring-fg") as unknown as SVGCircleElement;
const ctxRingTooltip = q("ctx-ring-tooltip") as HTMLElement;
const ctxRingDetail = q("ctx-ring-detail") as HTMLElement;
const RING_CIRCUMFERENCE = 2 * Math.PI * 15.5;

let ctxLastUsed = 0;
let ctxLastTotal = 0;

function formatTokens(n: number): string {
  if (n >= 1024) return (n / 1024).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

function updateContextRing(
  ratio: number, used: number, _budget: number, total: number,
  phase: "ok" | "compacting" | "compacted",
) {
  ctxLastUsed = used;
  ctxLastTotal = total;
  const fullRatio = total > 0 ? used / total : 0;
  const clamped = Math.max(0, Math.min(fullRatio, 1));
  const visual = used > 0 ? Math.max(0.03, clamped) : 0;
  ctxRingFg.style.strokeDashoffset = `${RING_CIRCUMFERENCE * (1 - visual)}`;

  let color: string;
  if (clamped < 0.5) color = "var(--green)";
  else if (clamped < 0.7) color = "var(--ctx-yellow)";
  else if (clamped < 0.85) color = "var(--ctx-orange)";
  else color = "var(--red)";
  ctxRingFg.style.stroke = color;

  ctxRingWrap.classList.toggle("compacting", phase === "compacting");
  if (phase === "compacted") ctxRingWrap.classList.remove("compacting");

  ctxRingDetail.textContent = `${formatTokens(used)} / ${formatTokens(total)} · ${Math.max(1, Math.round(clamped * 100))}%`;
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

ctxRingWrap.addEventListener("click", (e) => {
  e.stopPropagation();
  const pct = ctxLastTotal > 0 ? Math.max(1, Math.round((ctxLastUsed / ctxLastTotal) * 100)) : 0;
  ctxRingDetail.textContent = `${formatTokens(ctxLastUsed)} / ${formatTokens(ctxLastTotal)} · ${pct}%`;
  ctxRingTooltip.hidden = !ctxRingTooltip.hidden;
});
document.addEventListener("click", () => { ctxRingTooltip.hidden = true; });

// ── Fallback banner ──────────────────────────────────────────────────────────

const fallbackBanner = q("fallback-banner") as HTMLElement;
const fallbackText = q("fallback-text") as HTMLElement;
const fallbackOk = q("fallback-ok") as HTMLButtonElement;
const CTX_MODE_MAP: Record<number, EffortMode> = { 8192: "flash", 16384: "focus", 32768: "forge", 65536: "max" };

function showFallbackBanner(requested: number, actual: number) {
  const reqK = (requested / 1024).toFixed(0);
  const actMode = CTX_MODE_MAP[actual];
  const actLabel = actMode ? MODES[actMode].label : `${(actual / 1024).toFixed(0)}K`;
  fallbackText.textContent = `${reqK}K context didn't fit in memory. Loaded at ${actLabel} instead.`;
  fallbackBanner.hidden = false;
}

fallbackOk.addEventListener("click", () => { fallbackBanner.hidden = true; });

// ── Theme ─────────────────────────────────────────────────────────────────────

function applyTheme(theme: PanelTheme) { document.documentElement.dataset.theme = theme; }
function toggleTheme() {
  const next: PanelTheme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(next);
  persistTheme(next);
}

// ── Mode & Context ────────────────────────────────────────────────────────────

function updateCtxDropdownLabel() {
  ctxDropdownLabel.textContent = `${MODES[state.mode].label} · ${(state.ctxTokens / 1024).toFixed(0)}K`;
}

function reflectCtxOptions() {
  ctxDropdownMenu.querySelectorAll(".ctx-option").forEach((el) => {
    el.classList.toggle("active", (el as HTMLElement).dataset.mode === state.mode);
  });
}

function setModeAndCtx(nextMode: EffortMode) {
  if (nextMode === state.mode && MODE_CTX_MAP[nextMode] === state.ctxTokens) {
    ctxDropdownMenu.hidden = true;
    return;
  }
  state.mode = nextMode;
  state.ctxTokens = MODE_CTX_MAP[nextMode];
  updateCtxDropdownLabel();
  reflectCtxOptions();
  ctxDropdownMenu.hidden = true;
  persistMode(state.mode, state.ctxTokens);

  if (state.ctxTokens !== state.activeCtx && state.port) {
    state.busy = true;
    setReady(false);
    showLoadingOverlay();
    loadingPhrase.textContent = `Switching to ${(state.ctxTokens / 1024).toFixed(0)}K context…`;
    try { state.port.postMessage({ cmd: "load", nCtx: state.ctxTokens }); }
    catch { hideLoadingOverlay(); setReady(state.modelReady); }
  }
}

// ── Interaction mode ──────────────────────────────────────────────────────────

function reflectInteractionMode() {
  modeDropdownLabel.textContent = state.interactionMode === "ask" ? "Ask before acting" : "Autopilot";
  modeDropdownMenu.querySelectorAll(".mode-option").forEach((el) => {
    el.classList.toggle("active", (el as HTMLElement).dataset.interaction === state.interactionMode);
  });
}

function setInteractionMode(next: InteractionMode) {
  state.interactionMode = next;
  reflectInteractionMode();
  modeDropdownMenu.hidden = true;
  persistInteractionMode(next);
}

// ── Image attachment ──────────────────────────────────────────────────────────

async function attachImageFile(file: File) {
  if (!file.type.startsWith("image/")) return;
  try {
    const dataUrl = await readFileAsDataUrl(file);
    state.attachedImageDataUrl = dataUrl;
    imagePreviewImg.src = dataUrl;
    imagePreview.hidden = false;
    setReady(state.modelReady);
  } catch { /* ignore */ }
}

function clearAttachedImage() {
  state.attachedImageDataUrl = undefined;
  imagePreview.hidden = true;
  imagePreviewImg.src = "";
  fileInput.value = "";
}

// ── Markdown rendering ────────────────────────────────────────────────────────

const msgRawText = new WeakMap<HTMLElement, string>();

function setMessageContent(el: HTMLDivElement, text: string) {
  const safeText = typeof text === "string" ? text : String(text ?? "");
  msgRawText.set(el, safeText);
  const existingActions = el.querySelector(".msg-actions");
  const contentEl = el.querySelector(".msg-body") ?? (() => {
    const d = document.createElement("div");
    d.className = "msg-body";
    if (existingActions) el.insertBefore(d, existingActions);
    else el.appendChild(d);
    return d;
  })();
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
  if (role === "assistant") setMessageContent(el, text);
  else body.textContent = text;

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
  state.chatHistory = [];
  messagesEl.innerHTML = "";
  messagesEl.appendChild(welcomeEl);
  welcomeEl.hidden = false;
  resetContextRing();
}

// ── Engine events ─────────────────────────────────────────────────────────────

function onEngineEvent(ev: EngineEvent) {
  if (ev.kind !== "delta") dlog.log("SP", `[engine] kind="${ev.kind}"`);
  switch (ev.kind) {
    case "progress":
      loadingOverlay.hidden = false;
      updateLoadingProgress(ev.progress);
      break;
    case "ready":
      state.busy = false;
      setReady(true);
      hideLoadingOverlay();
      inputEl.focus();
      break;
    case "loaded":
      state.activeCtx = ev.nCtx;
      if (ev.fellBack) {
        const actMode = CTX_MODE_MAP[ev.nCtx];
        if (actMode) {
          state.mode = actMode;
          state.ctxTokens = ev.nCtx;
          updateCtxDropdownLabel();
          reflectCtxOptions();
          persistMode(state.mode, state.ctxTokens);
        }
        showFallbackBanner(ev.requestedCtx, ev.nCtx);
      }
      if (state.modelReady && !state.generating) hideLoadingOverlay();
      break;
    case "loaderror":
      hideLoadingOverlay();
      state.busy = false;
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
      state.pending.get(ev.reqId)?.onStatus(ev.text);
      break;
    case "delta":
      state.pending.get(ev.reqId)?.onDelta(ev.text);
      break;
    case "done": {
      const p = state.pending.get(ev.reqId);
      state.pending.delete(ev.reqId);
      p?.resolve(ev.text);
      break;
    }
    case "error": {
      const p = state.pending.get(ev.reqId);
      state.pending.delete(ev.reqId);
      p?.reject(new Error(ev.message));
      break;
    }
  }
}

// ── Engine connection ─────────────────────────────────────────────────────────

function connectEngine() {
  if (state.port) return;
  state.port = chrome.runtime.connect({ name: ENGINE_PORT });
  state.port.onMessage.addListener(onEngineEvent as (msg: unknown) => void);
  state.port.onDisconnect.addListener(() => {
    state.port = undefined;
    state.loadStarted = false;
    state.modelReady = false;
    for (const p of state.pending.values()) p.reject(new Error("Engine disconnected"));
    state.pending.clear();
    setReady(false);
    loadingOverlay.hidden = false;
    loadingPhrase.textContent = "Disconnected — reopen panel to reconnect";
    loadingFill.style.width = "0%";
    loadingPct.textContent = "";
  });
}

function startLoad() {
  connectEngine();
  if (state.loadStarted) return;
  state.loadStarted = true;
  state.busy = true;
  setReady(false);
  showLoadingOverlay();
  state.port!.postMessage({ cmd: "load", nCtx: state.ctxTokens });
}

// ── Inference helpers ─────────────────────────────────────────────────────────

function runInference(system: string, user: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!state.port) { reject(new Error("Not connected")); return; }
    const reqId = crypto.randomUUID();
    dlog.log("SP", `[runInference] reqId=${reqId} system="${system.slice(0, 80)}…" user="${user.slice(0, 120)}…"`);
    state.pending.set(reqId, {
      onStatus: () => {},
      onDelta: () => {},
      resolve: (t) => {
        state.pending.delete(reqId);
        dlog.log("SP", `[runInference] reqId=${reqId} → "${t.slice(0, 200)}${t.length > 200 ? "…" : ""}"`);
        resolve(t);
      },
      reject: (e) => {
        state.pending.delete(reqId);
        dlog.error("SP", `[runInference] reqId=${reqId} ERROR:`, e);
        reject(e);
      },
    });
    try {
      state.port.postMessage({ cmd: "agentStep", reqId, system, user, mode: state.mode });
    } catch (err) {
      state.pending.delete(reqId);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function runChat(text: string, image: string | undefined, replyEl: HTMLDivElement): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!state.port) { reject(new Error("Not connected")); return; }
    const reqId = crypto.randomUUID();
    state.activeReqId = reqId;
    dlog.log("SP", `[runChat] reqId=${reqId} hasImage=${!!image} textLen=${text.length} text="${text.slice(0, 150)}…"`);
    const clearActive = () => { if (state.activeReqId === reqId) state.activeReqId = undefined; };
    state.pending.set(reqId, {
      onStatus: (t) => {
        replyEl.classList.add("typing");
        const body = replyEl.querySelector(".msg-body");
        if (body) body.textContent = t;
        messagesEl.scrollTop = messagesEl.scrollHeight;
      },
      onDelta: (t) => {
        if (t) { replyEl.classList.remove("typing"); setMessageContent(replyEl, t); }
        else {
          replyEl.classList.add("typing");
          const body = replyEl.querySelector(".msg-body");
          if (body) body.textContent = "Thinking…";
        }
        messagesEl.scrollTop = messagesEl.scrollHeight;
      },
      resolve: (t) => {
        clearActive();
        dlog.log("SP", `[runChat] reqId=${reqId} DONE → "${t.slice(0, 300)}${t.length > 300 ? "…" : ""}"`);
        resolve(t);
      },
      reject: (e) => {
        clearActive();
        dlog.error("SP", `[runChat] reqId=${reqId} ERROR:`, e);
        reject(e);
      },
    });
    try {
      state.port.postMessage({ cmd: "chat", reqId, text, mode: state.mode, image });
    } catch (err) {
      state.pending.delete(reqId);
      clearActive();
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

// ── Slide/doc context fetchers ────────────────────────────────────────────────

async function fetchSlideContext() {
  const attempt = async () => {
    const resp = await zohoAPI.getSlideData();
    if (!resp.ok || !resp.data) return null;
    return {
      summary: summarizeSlideForAI(resp.data, { includeColors: true }),
      metadata: getSlideMetadata(resp.data),
    };
  };
  const first = await attempt();
  if (first) return first;
  await new Promise((r) => setTimeout(r, 800));
  return attempt();
}

// ── Color palette rendering ───────────────────────────────────────────────────

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

// ── Tool setup ────────────────────────────────────────────────────────────────

setCreatePresentationInference(runInference);
setChangeThemeInference(runInference);
setBrowseThemesSetContent(setMessageContent);

const tools: Tool[] = [
  createPresentationTool,
  changeThemeTool,
  browseThemesTool,
  createScreenshotTool(runChat, setMessageContent),
  createDoccontextTool(setMessageContent, renderColorPalette, fetchSlideContext),
  createSlidecontextTool(runChat, setMessageContent, renderColorPalette, fetchSlideContext),
  createSlideinfoTool(setMessageContent, renderColorPalette),
  createChatTool(runChat, setMessageContent, fetchSlideContext),
];

registerTools(tools);

// ── Send message ──────────────────────────────────────────────────────────────

async function sendMessage() {
  const rawText = inputEl.value.trim();
  const hasImage = !!state.attachedImageDataUrl;
  dlog.log("SP", `[sendMessage] text="${rawText}" hasImage=${hasImage} busy=${state.busy} ready=${state.modelReady}`);
  if ((!rawText && !hasImage) || state.busy || !state.modelReady || !state.port) return;
  const text = rawText || "What's in this image?";

  const pendingImage = state.attachedImageDataUrl;

  state.generating = true;
  state.stopRequested = false;
  state.busy = true;
  setReady(false);
  inputEl.value = "";
  inputEl.style.height = "auto";
  clearAttachedImage();

  appendMessage("user", text, pendingImage);
  state.chatHistory.push({ role: "user", text });

  const replyEl = appendMessage("assistant", "…");
  replyEl.classList.add("typing");
  const replyBody = replyEl.querySelector(".msg-body") as HTMLElement;

  let selection = { tool: getDefaultTool(), args: {} as Record<string, string> };

  try {
    if (!pendingImage) {
      replyBody.textContent = "Understanding your request…";
      selection = await selectTool(text, runInference, state.mode);
      dlog.log("SP", `[sendMessage] routed to tool="${selection.tool.name}" args=${JSON.stringify(selection.args)}`);
    } else {
      dlog.log("SP", `[sendMessage] image attached → using default tool (none)`);
    }

    const ctx: ToolContext = {
      userText: text,
      mode: state.mode,
      replyEl,
      attachedImage: pendingImage ?? undefined,
      args: selection.args,
      setStatus: (s) => { replyBody.textContent = s; },
      isStopped: () => state.stopRequested,
    };

    const result = await executeWithConfirmation(selection.tool, ctx, state.interactionMode);
    replyEl.classList.remove("typing");

    if (!result || (state.stopRequested && result.assistantText === "(stopped)")) {
      dlog.log("SP", `[sendMessage] stopped or null result`);
      replyBody.textContent = "(stopped)";
      state.chatHistory.pop();
      return;
    }

    dlog.log("SP", `[sendMessage] tool done, remember=${result.remember ?? false} textLen=${result.assistantText.length} reply="${result.assistantText.slice(0, 300)}${result.assistantText.length > 300 ? "…" : ""}"`);

    state.chatHistory.push({ role: "assistant", text: result.assistantText });

    if (result.remember && state.port) {
      dlog.log("SP", `[sendMessage] injecting context into session`);
      state.port.postMessage({ cmd: "injectContext", userText: text, assistantText: result.assistantText });
    }
  } catch (err) {
    dlog.error("SP", `[sendMessage] error:`, err);
    replyBody.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
    replyEl.classList.remove("typing");
    state.chatHistory.pop();
  } finally {
    state.generating = false;
    state.stopRequested = false;
    state.activeReqId = undefined;
    state.busy = false;
    stopBtn.disabled = false;
    setReady(true);
    loadingOverlay.hidden = true;
    inputEl.focus();
  }
}

function stopGeneration() {
  if (!state.generating || state.stopRequested) return;
  state.stopRequested = true;
  stopBtn.disabled = true;
  if (state.port && state.activeReqId) {
    try { state.port.postMessage({ cmd: "abort", reqId: state.activeReqId }); } catch { /* */ }
  }
}

// ── UI event wiring ───────────────────────────────────────────────────────────

themeToggle.addEventListener("click", toggleTheme);

newChatBtn.addEventListener("click", () => {
  resetChat();
  clearAttachedImage();
  if (state.port) { try { state.port.postMessage({ cmd: "reset" }); } catch { /* */ } }
  setReady(state.modelReady);
  inputEl.focus();
});

ctxDropdownBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  modeDropdownMenu.hidden = true;
  ctxDropdownMenu.hidden = !ctxDropdownMenu.hidden;
});

ctxDropdownMenu.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest(".ctx-option") as HTMLElement | null;
  if (!btn) return;
  const nextMode = btn.dataset.mode as EffortMode;
  if (isEffortMode(nextMode)) setModeAndCtx(nextMode);
});

modeDropdownBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  ctxDropdownMenu.hidden = true;
  modeDropdownMenu.hidden = !modeDropdownMenu.hidden;
});

modeDropdownMenu.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest(".mode-option") as HTMLElement | null;
  if (!btn) return;
  const next = btn.dataset.interaction as InteractionMode;
  if (next === "ask" || next === "autopilot") setInteractionMode(next);
});

document.addEventListener("click", (e) => {
  if (!ctxDropdownBtn.contains(e.target as Node) && !ctxDropdownMenu.contains(e.target as Node)) {
    ctxDropdownMenu.hidden = true;
  }
  if (!modeDropdownBtn.contains(e.target as Node) && !modeDropdownMenu.contains(e.target as Node)) {
    modeDropdownMenu.hidden = true;
  }
});

attachBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => { if (fileInput.files?.[0]) void attachImageFile(fileInput.files[0]); });
imagePreviewRemove.addEventListener("click", clearAttachedImage);

inputEl.addEventListener("paste", (e) => {
  const dt = e.clipboardData;
  if (!dt) return;
  const file = extractImageFromDataTransfer(dt);
  if (file) { e.preventDefault(); void attachImageFile(file); }
});

// Drag-and-drop
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
document.addEventListener("dragleave", () => { dragCounter--; if (dragCounter <= 0) { dragCounter = 0; dropOverlay.hidden = true; } });
document.addEventListener("dragover", (e) => { if (hasImageInDrag(e)) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"; } });
document.addEventListener("drop", (e) => {
  e.preventDefault(); dragCounter = 0; dropOverlay.hidden = true;
  if (!e.dataTransfer) return;
  const file = extractImageFromDataTransfer(e.dataTransfer);
  if (file) void attachImageFile(file);
});

inputEl.addEventListener("input", () => {
  setReady(state.modelReady);
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + "px";
});
inputEl.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendMessage(); } });
sendBtn.addEventListener("click", () => void sendMessage());
stopBtn.addEventListener("click", stopGeneration);

// ── Init ──────────────────────────────────────────────────────────────────────

initDebugPanel();

loadStoredPreferences((prefs) => {
  if (prefs.mode) state.mode = prefs.mode;
  if (prefs.ctxTokens) { state.ctxTokens = prefs.ctxTokens; state.activeCtx = prefs.ctxTokens; }
  if (prefs.theme) applyTheme(prefs.theme);
  if (prefs.interaction) state.interactionMode = prefs.interaction;
  updateCtxDropdownLabel();
  reflectCtxOptions();
  reflectInteractionMode();
  startLoad();
});
