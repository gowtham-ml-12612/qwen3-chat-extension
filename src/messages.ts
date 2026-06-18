// Message protocol shared across the three contexts:
//
//   content script  <--Port "engine"-->  service worker  <--runtime msg-->  offscreen
//
// The content script never talks to the offscreen document directly (offscreen
// docs can't use chrome.tabs, so replies must be routed back through the SW).
// The SW assigns each connected content port a numeric `clientId` and relays.

import type { EffortMode } from "./modes";

// ── content → SW (over the long-lived Port) ───────────────────────────────────

export type ClientCmd =
  | {
      cmd: "load";
      /**
       * Requested context window in tokens. When omitted the engine uses its
       * default. When this differs from the currently loaded size the engine
       * reloads the model (the KV-cache can't be resized live).
       */
      nCtx?: number;
    }
  | {
      cmd: "chat";
      reqId: string;
      text: string;
      /** Effort tier driving reasoning / loop depth / image detail / length. */
      mode: EffortMode;
      /**
       * The slide as a base64 JPEG data URL, when this is a vision question.
       * Sent as a string (not raw bytes) because Chrome extension messaging is
       * JSON-serialized — an ArrayBuffer would arrive empty.
       */
      image?: string;
    }
  | { cmd: "abort"; reqId: string }
  // Clear this tab's conversation context in the engine (New chat).
  | { cmd: "reset" };

// ── engine → content (over the Port) ──────────────────────────────────────────

export type EngineEvent =
  | { kind: "progress"; text: string; progress: number }
  | { kind: "ready" }
  | {
      /**
       * Model finished loading. Reports the context size actually in effect,
       * which may be smaller than requested if a larger size hit OOM and the
       * engine fell back. The panel reflects this real value in its dropdown.
       */
      kind: "loaded";
      nCtx: number;
      /** True when the engine fell back to a smaller size than requested. */
      fellBack: boolean;
    }
  | { kind: "loaderror"; message: string }
  | {
      /**
       * Context-window usage report, sent after every turn + compaction.
       * Drives the circular progress ring in the panel.
       *   ratio  — tokens used / history budget (0→1, can briefly exceed 1
       *            before compaction runs).
       *   used   — token count currently occupied (summary + turns).
       *   budget — total token room for conversation history.
       *   phase  — "ok" when under watermark, "compacting" while the
       *            summariser is running, "compacted" right after.
       */
      kind: "context";
      ratio: number;
      used: number;
      budget: number;
      phase: "ok" | "compacting" | "compacted";
    }
  | { kind: "status"; reqId: string; text: string }
  | { kind: "delta"; reqId: string; text: string }
  | { kind: "done"; reqId: string; text: string }
  | { kind: "error"; reqId: string; message: string };

// ── SW → offscreen (runtime.sendMessage) ──────────────────────────────────────

export type ToOffscreen = { to: "offscreen"; clientId: number } & (
  | ClientCmd
  | { cmd: "disconnect" }
);

// ── offscreen → SW (runtime.sendMessage), relayed to the client Port ──────────

export type ToRelay = { to: "relay"; clientId: number } & EngineEvent;

export const ENGINE_PORT = "engine";
