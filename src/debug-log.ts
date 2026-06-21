// Floating debug log panel that renders inside the sidepanel chat UI.
// Draggable, collapsible, with a copy-all button.
//
// Usage:
//   import { dlog, initDebugPanel } from "./debug-log";
//   initDebugPanel();                       // call once on load
//   dlog.log("SP", "selectTool", "picked create_presentation");
//   dlog.warn("SP", "no slide context");
//   dlog.error("SP", "runChat failed", err);

interface LogEntry {
  ts: number;
  source: string;
  level: "log" | "warn" | "error";
  message: string;
}

const MAX_ENTRIES = 1000;
const entries: LogEntry[] = [];

let panel: HTMLElement | null = null;
let content: HTMLElement | null = null;
let toggleBtn: HTMLElement | null = null;
let badge: HTMLElement | null = null;
let expanded = false;
let unreadCount = 0;

function ts(d: number): string {
  const dt = new Date(d);
  const h = String(dt.getHours()).padStart(2, "0");
  const m = String(dt.getMinutes()).padStart(2, "0");
  const s = String(dt.getSeconds()).padStart(2, "0");
  const ms = String(dt.getMilliseconds()).padStart(3, "0");
  return `${h}:${m}:${s}.${ms}`;
}

function stringify(...args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return `${a.name}: ${a.message}`;
      try { return JSON.stringify(a); }
      catch { return String(a); }
    })
    .join(" ");
}

function appendEntry(entry: LogEntry): void {
  if (!content) return;
  const el = document.createElement("div");
  el.className = `dlog-line dlog-${entry.level}`;

  const time = document.createElement("span");
  time.className = "dlog-ts";
  time.textContent = ts(entry.ts);

  const src = document.createElement("span");
  src.className = "dlog-src";
  src.textContent = `[${entry.source}]`;

  const msg = document.createElement("span");
  msg.className = "dlog-msg";
  msg.textContent = entry.message;

  el.appendChild(time);
  el.appendChild(src);
  el.appendChild(msg);

  content.appendChild(el);

  // Auto-prune DOM
  while (content.children.length > MAX_ENTRIES) {
    content.removeChild(content.firstChild!);
  }

  // Auto-scroll if near the bottom
  const nearBottom = content.scrollHeight - content.scrollTop - content.clientHeight < 60;
  if (nearBottom) content.scrollTop = content.scrollHeight;

  // Badge for unread when collapsed
  if (!expanded) {
    unreadCount++;
    if (badge) {
      badge.textContent = unreadCount > 99 ? "99+" : String(unreadCount);
      badge.hidden = false;
    }
  }
}

function pushEntry(source: string, level: "log" | "warn" | "error", args: unknown[]): void {
  const message = stringify(...args);
  const entry: LogEntry = { ts: Date.now(), source, level, message };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();
  appendEntry(entry);
}

export const dlog = {
  log: (source: string, ...args: unknown[]) => pushEntry(source, "log", args),
  warn: (source: string, ...args: unknown[]) => pushEntry(source, "warn", args),
  error: (source: string, ...args: unknown[]) => pushEntry(source, "error", args),
};

export function copyAllLogs(): string {
  return entries
    .map((e) => `${new Date(e.ts).toISOString()} [${e.source}][${e.level.toUpperCase()}] ${e.message}`)
    .join("\n");
}

export function clearLogs(): void {
  entries.length = 0;
  if (content) content.innerHTML = "";
}

// ── UI construction ──────────────────────────────────────────────────────────

function makeDraggable(handle: HTMLElement, target: HTMLElement): void {
  let ox = 0, oy = 0, sx = 0, sy = 0;
  handle.addEventListener("mousedown", (e) => {
    if ((e.target as HTMLElement).tagName === "BUTTON") return;
    e.preventDefault();
    sx = e.clientX; sy = e.clientY;
    const onMove = (ev: MouseEvent) => {
      ox = ev.clientX - sx; oy = ev.clientY - sy;
      sx = ev.clientX; sy = ev.clientY;
      const rect = target.getBoundingClientRect();
      const left = Math.max(0, Math.min(window.innerWidth - 80, rect.left + ox));
      const top = Math.max(0, Math.min(window.innerHeight - 40, rect.top + oy));
      target.style.left = `${left}px`;
      target.style.top = `${top}px`;
      target.style.right = "auto";
      target.style.bottom = "auto";
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

function togglePanel(): void {
  if (!panel) return;
  expanded = !expanded;
  panel.hidden = !expanded;
  if (expanded) {
    unreadCount = 0;
    if (badge) badge.hidden = true;
    if (content) content.scrollTop = content.scrollHeight;
  }
}

export function initDebugPanel(): void {
  if (panel) return;

  // Toggle button
  toggleBtn = document.createElement("button");
  toggleBtn.className = "dlog-toggle";
  toggleBtn.textContent = "Debug";
  toggleBtn.addEventListener("click", togglePanel);

  badge = document.createElement("span");
  badge.className = "dlog-badge";
  badge.hidden = true;
  toggleBtn.appendChild(badge);

  // Panel
  panel = document.createElement("div");
  panel.className = "dlog-panel";
  panel.hidden = true;

  // Header
  const header = document.createElement("div");
  header.className = "dlog-header";
  makeDraggable(header, panel);

  const title = document.createElement("span");
  title.className = "dlog-title";
  title.textContent = "Debug Log";
  header.appendChild(title);

  const btns = document.createElement("div");
  btns.className = "dlog-header-btns";

  const copyBtn = document.createElement("button");
  copyBtn.className = "dlog-btn";
  copyBtn.title = "Copy all";
  copyBtn.textContent = "Copy";
  copyBtn.addEventListener("click", () => {
    const text = copyAllLogs();
    navigator.clipboard.writeText(text).then(() => {
      copyBtn.textContent = "Copied!";
      setTimeout(() => { copyBtn.textContent = "Copy"; }, 1200);
    });
  });

  const clearBtn = document.createElement("button");
  clearBtn.className = "dlog-btn";
  clearBtn.title = "Clear";
  clearBtn.textContent = "Clear";
  clearBtn.addEventListener("click", clearLogs);

  const closeBtn = document.createElement("button");
  closeBtn.className = "dlog-btn dlog-close";
  closeBtn.title = "Close";
  closeBtn.textContent = "\u00d7";
  closeBtn.addEventListener("click", togglePanel);

  btns.appendChild(copyBtn);
  btns.appendChild(clearBtn);
  btns.appendChild(closeBtn);
  header.appendChild(btns);

  // Content
  content = document.createElement("div");
  content.className = "dlog-content";

  panel.appendChild(header);
  panel.appendChild(content);

  document.body.appendChild(toggleBtn);
  document.body.appendChild(panel);

  // Replay buffered entries
  for (const e of entries) appendEntry(e);
}
