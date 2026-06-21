import { ENGINE_PORT, type EngineEvent } from "../messages";
import type { EffortMode } from "../modes";
import { MODES } from "../modes";
import type { Pending } from "./types";
import { dlog } from "../debug-log";

export interface EngineClient {
  connect(): void;
  postCommand(msg: Record<string, unknown>): void;
  isConnected(): boolean;
  getPort(): chrome.runtime.Port | undefined;
  startLoad(nCtx: number): void;
  runChat(text: string, image: string | undefined, mode: EffortMode, callbacks: ChatCallbacks): string;
  runInference(system: string, user: string, mode: EffortMode): Promise<string>;
  abort(reqId: string): void;
  reset(): void;
  injectContext(userText: string, assistantText: string): void;
}

export interface ChatCallbacks {
  onStatus(text: string): void;
  onDelta(text: string): void;
}

export interface EngineClientOptions {
  onEvent(ev: EngineEvent): void;
  onDisconnect(): void;
  getPending(): Map<string, Pending>;
}

export function createEngineClient(options: EngineClientOptions): EngineClient {
  let port: chrome.runtime.Port | undefined;
  let loadStarted = false;

  function connect() {
    if (port) return;
    dlog.log("SP", "[engine] connecting…");
    port = chrome.runtime.connect({ name: ENGINE_PORT });
    port.onMessage.addListener(options.onEvent as (msg: unknown) => void);
    port.onDisconnect.addListener(() => {
      dlog.warn("SP", "[engine] port disconnected");
      port = undefined;
      loadStarted = false;
      options.onDisconnect();
    });
  }

  function postCommand(msg: Record<string, unknown>) {
    if (!port) throw new Error("Engine not connected");
    port.postMessage(msg);
  }

  function startLoad(nCtx: number) {
    connect();
    if (loadStarted) return;
    loadStarted = true;
    postCommand({ cmd: "load", nCtx });
  }

  function runChat(text: string, image: string | undefined, mode: EffortMode, callbacks: ChatCallbacks): string {
    if (!port) throw new Error("Not connected");
    const reqId = crypto.randomUUID();
    dlog.log("SP", `[engine.runChat] reqId=${reqId} mode=${mode}`);
    const pending = options.getPending();
    pending.set(reqId, {
      onStatus: callbacks.onStatus,
      onDelta: callbacks.onDelta,
      resolve: () => {},
      reject: () => {},
    });
    port.postMessage({ cmd: "chat", reqId, text, mode, image });
    return reqId;
  }

  function runInference(system: string, user: string, mode: EffortMode): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!port) { reject(new Error("Not connected")); return; }
      const reqId = crypto.randomUUID();
      dlog.log("SP", `[engine.runInference] reqId=${reqId}`);
      const pending = options.getPending();
      pending.set(reqId, {
        onStatus: () => {},
        onDelta: () => {},
        resolve: (t) => { pending.delete(reqId); resolve(t); },
        reject: (e) => { pending.delete(reqId); reject(e); },
      });
      port.postMessage({ cmd: "agentStep", reqId, system, user, mode });
    });
  }

  function abort(reqId: string) {
    if (!port) return;
    try { port.postMessage({ cmd: "abort", reqId }); } catch { /* port gone */ }
  }

  function reset() {
    if (!port) return;
    try { port.postMessage({ cmd: "reset" }); } catch { /* port gone */ }
  }

  function injectContext(userText: string, assistantText: string) {
    if (!port) return;
    port.postMessage({ cmd: "injectContext", userText, assistantText });
  }

  return {
    connect,
    postCommand,
    isConnected: () => !!port,
    getPort: () => port,
    startLoad,
    runChat,
    runInference,
    abort,
    reset,
    injectContext,
  };
}
