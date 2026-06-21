// Agent content script — the page's eyes and hands for the browser-agent loop.
// The side panel can't touch the page DOM directly (it's a separate document),
// so it routes two requests through the service worker to here:
//
//   sp:collectElements → return the numbered list of interactive elements
//   sp:executeAction   → click / type / scroll / key against element N
//
// Element targeting is by index into the LAST snapshot we returned, so the model
// never deals in pixel coordinates. We resolve the index back to the live node.

import {
  type PageElement,
  type PageObservation,
  type AgentAction,
  type ActionResult,
  MAX_LABEL_LEN,
  MAX_ELEMENTS,
} from "./actions";
import type { ToContent } from "./messages";

// ── Snapshot state ────────────────────────────────────────────────────────────

let snapshotCounter = 0;
let currentSnapshotId = 0;
let currentNodes: HTMLElement[] = [];

const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input:not([type=hidden])",
  "textarea",
  "select",
  "[role=button]",
  "[role=link]",
  "[role=menuitem]",
  "[role=tab]",
  "[role=option]",
  "[role=checkbox]",
  "[role=radio]",
  "[role=switch]",
  "[contenteditable=true]",
  "[contenteditable='']",
  "[tabindex]:not([tabindex='-1'])",
  "[onclick]",
].join(",");

function isVisible(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return false;
  if (rect.bottom < 0 || rect.top > window.innerHeight) return false;
  if (rect.right < 0 || rect.left > window.innerWidth) return false;
  const style = getComputedStyle(el);
  if (style.visibility === "hidden" || style.display === "none") return false;
  if (Number(style.opacity) === 0) return false;
  if (el.hasAttribute("disabled") || el.getAttribute("aria-hidden") === "true") return false;
  return true;
}

function isEditable(el: HTMLElement): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === "textarea") return true;
  if (tag === "input") {
    const type = (el as HTMLInputElement).type;
    return !["button", "submit", "reset", "checkbox", "radio", "file", "image"].includes(type);
  }
  return el.isContentEditable;
}

function labelFor(el: HTMLElement): string {
  const aria = el.getAttribute("aria-label");
  const title = el.getAttribute("title");
  const placeholder = (el as HTMLInputElement).placeholder;
  const value = el.tagName.toLowerCase() === "input" ? (el as HTMLInputElement).value : "";
  const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();

  const raw = aria || text || title || placeholder || value || "";
  const label = raw.slice(0, MAX_LABEL_LEN).trim();
  return label || "(no label)";
}

function roleFor(el: HTMLElement): string | undefined {
  const role = el.getAttribute("role");
  if (role) return role;
  if (el.tagName.toLowerCase() === "input") return (el as HTMLInputElement).type || "text";
  return undefined;
}

function collectElements(): PageObservation {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR),
  ).filter(isVisible);

  const chosen: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();
  for (const el of candidates) {
    let ancestor = el.parentElement;
    let covered = false;
    while (ancestor) {
      if (seen.has(ancestor)) { covered = true; break; }
      ancestor = ancestor.parentElement;
    }
    if (covered) continue;
    seen.add(el);
    chosen.push(el);
    if (chosen.length >= MAX_ELEMENTS) break;
  }

  currentNodes = chosen;
  currentSnapshotId = ++snapshotCounter;

  const elements: PageElement[] = chosen.map((el, i) => ({
    index: i,
    tag: el.tagName.toLowerCase(),
    role: roleFor(el),
    label: labelFor(el),
    editable: isEditable(el) || undefined,
  }));

  return {
    elements,
    url: location.href,
    title: document.title,
    snapshotId: currentSnapshotId,
  };
}

// ── Action execution ──────────────────────────────────────────────────────────

function nodeForIndex(index: number, snapshotId: number): HTMLElement | undefined {
  if (snapshotId !== currentSnapshotId) return undefined;
  return currentNodes[index];
}

function centerOf(el: HTMLElement): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function realisticClick(el: HTMLElement): void {
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" as ScrollBehavior });
  const { x, y } = centerOf(el);
  const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window };
  el.dispatchEvent(new PointerEvent("pointerover", base));
  el.dispatchEvent(new PointerEvent("pointerenter", base));
  el.dispatchEvent(new MouseEvent("mouseover", base));
  el.dispatchEvent(new PointerEvent("pointerdown", { ...base, button: 0 }));
  el.dispatchEvent(new MouseEvent("mousedown", { ...base, button: 0 }));
  (el as HTMLElement).focus?.();
  el.dispatchEvent(new PointerEvent("pointerup", { ...base, button: 0 }));
  el.dispatchEvent(new MouseEvent("mouseup", { ...base, button: 0 }));
  el.dispatchEvent(new MouseEvent("click", { ...base, button: 0 }));
}

function typeInto(el: HTMLElement, text: string, submit: boolean): void {
  el.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
  el.focus();
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea") {
    const field = el as HTMLInputElement | HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(
      tag === "input" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    if (setter) setter.call(field, text);
    else field.value = text;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (el.isContentEditable) {
    el.textContent = text;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
  }
  if (submit) pressKey(el, "Enter");
}

function pressKey(target: HTMLElement, key: string): void {
  const opts: KeyboardEventInit = { key, bubbles: true, cancelable: true, composed: true };
  if (key === "Enter") opts.code = "Enter";
  target.dispatchEvent(new KeyboardEvent("keydown", opts));
  target.dispatchEvent(new KeyboardEvent("keypress", opts));
  target.dispatchEvent(new KeyboardEvent("keyup", opts));
}

function executeAction(action: AgentAction, snapshotId: number): ActionResult {
  try {
    switch (action.type) {
      case "click": {
        const el = nodeForIndex(action.index, snapshotId);
        if (!el) return { ok: false, detail: `Element ${action.index} not found (page changed — re-observing)` };
        realisticClick(el);
        return { ok: true, detail: `Clicked "${labelFor(el)}"`, changed: true };
      }
      case "type": {
        const el = nodeForIndex(action.index, snapshotId);
        if (!el) return { ok: false, detail: `Element ${action.index} not found (page changed — re-observing)` };
        typeInto(el, action.text, action.submit ?? false);
        return { ok: true, detail: `Typed into "${labelFor(el)}"`, changed: true };
      }
      case "key": {
        const target = (document.activeElement as HTMLElement) ?? document.body;
        pressKey(target, action.key);
        return { ok: true, detail: `Pressed ${action.key}`, changed: true };
      }
      case "scroll": {
        const dy = action.direction === "down" ? window.innerHeight * 0.8 : -window.innerHeight * 0.8;
        window.scrollBy({ top: dy, behavior: "instant" as ScrollBehavior });
        return { ok: true, detail: `Scrolled ${action.direction}`, changed: true };
      }
      case "navigate": {
        location.href = action.url;
        return { ok: true, detail: `Navigating to ${action.url}`, changed: true };
      }
      case "respond":
        return { ok: true, detail: "Responded" };
      default:
        return { ok: false, detail: "Unknown action" };
    }
  } catch (err) {
    return { ok: false, detail: `Action failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ── Message handling ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg: ToContent | { type?: string }, _sender, sendResponse) => {
  const m = msg as ToContent;
  if (m?.type === "sp:collectElements") {
    sendResponse({ observation: collectElements() });
    return;
  }
  if (m?.type === "sp:executeAction") {
    sendResponse(executeAction(m.action, m.snapshotId));
    return;
  }
});

console.debug("[Show Pilot] Agent content script loaded.");
