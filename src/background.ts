// Service worker: thin coordinator. It no longer runs any model (that moved to
// the offscreen document). Its jobs are:
//   1. Open the Chrome Side Panel when the toolbar icon is clicked.
//   2. Capture screenshots via CDP (chrome.debugger) for slide analysis.
//   3. Own the offscreen document lifecycle and relay messages between each
//      panel/content-script port and the offscreen engine.
//
// OLD FLOW (commented out): Toggle floating panel + Zoho DownloadUtil capture.

import { ENGINE_PORT, type EngineEvent, type ToRelay } from "./messages";
import type {
  AgentObserveResponse,
  AgentActResponse,
  ToContent,
  FromContent,
} from "./messages";
import type { AgentAction, PageObservation } from "./actions";

// ── Offscreen document lifecycle ──────────────────────────────────────────────

let creating: Promise<void> | undefined;

async function ensureOffscreen(): Promise<void> {
  const has = await chrome.offscreen.hasDocument();
  if (has) return;
  console.log("[BG][ensureOffscreen] no offscreen doc, creating…");
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: "offscreen.html",
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification: "Runs the local Qwen3.5 model (WebAssembly + WebGPU) for chat and slide analysis.",
      })
      .then(() => { console.log("[BG][ensureOffscreen] offscreen doc created"); })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("single offscreen")) throw err;
        console.log("[BG][ensureOffscreen] offscreen doc already exists (race)");
      })
      .finally(() => {
        creating = undefined;
      });
  }
  await creating;
}

// Deliver a command to the offscreen doc, retrying while its message listener
// hasn't attached yet right after creation (the bundle takes a moment to parse).
async function sendToOffscreen(message: unknown): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await chrome.runtime.sendMessage(message);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("Receiving end does not exist")) return;
      if (attempt === 0) console.log("[BG][sendToOffscreen] offscreen not ready yet, retrying…");
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  console.warn("[BG][sendToOffscreen] gave up after 20 attempts");
}

// ── Content port relay ────────────────────────────────────────────────────────

let nextClientId = 1;
const clients = new Map<number, chrome.runtime.Port>();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== ENGINE_PORT) return;
  const clientId = nextClientId++;
  clients.set(clientId, port);
  console.log(`[BG][onConnect] new client port clientId=${clientId} totalClients=${clients.size}`);

  port.onMessage.addListener(async (msg) => {
    console.log(`[BG][port.onMessage] clientId=${clientId} cmd="${msg?.cmd}" reqId=${msg?.reqId ?? "n/a"}`);
    try {
      await ensureOffscreen();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[BG][port.onMessage] ensureOffscreen failed: ${errMsg}`);
      const event: EngineEvent = {
        kind: "loaderror",
        message: errMsg,
      };
      port.postMessage(event);
      return;
    }
    void sendToOffscreen({ to: "offscreen", clientId, ...msg });
  });

  port.onDisconnect.addListener(() => {
    console.log(`[BG][onDisconnect] clientId=${clientId} remainingClients=${clients.size - 1}`);
    clients.delete(clientId);
    void sendToOffscreen({ to: "offscreen", clientId, cmd: "disconnect" });
    if (clients.size === 0) {
      console.log("[BG][onDisconnect] no clients remaining, closing offscreen doc");
      chrome.offscreen.hasDocument().then((has) => {
        if (has && clients.size === 0) chrome.offscreen.closeDocument().catch(() => {});
      });
    }
  });
});

// ── Side panel: only available on Zoho Show domains ──────────────────────────
// The panel is disabled by default and enabled per-tab only when the URL matches
// a Zoho Show domain. Navigating away or switching to a non-Show tab hides it.

const SHOW_URL_RE = /^https?:\/\/show\.(zoho\.(com|in|eu|com\.au|com\.cn)|localzoho\.com)\//;

// Read the hashed panel path from the built manifest (Parcel renames it).
const PANEL_PATH: string =
  (chrome.runtime.getManifest() as { side_panel?: { default_path?: string } }).side_panel?.default_path
  || "sidepanel.html";

function isShowUrl(url: string | undefined): boolean {
  return !!url && SHOW_URL_RE.test(url);
}

// Globally disable the panel — overrides the manifest default_path so Chrome
// doesn't use it as a window-level fallback when switching to non-Show tabs.
chrome.sidePanel.setOptions({ enabled: false }).catch(() => {});
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

async function syncPanelForTab(tabId: number, url: string | undefined): Promise<void> {
  if (isShowUrl(url)) {
    await chrome.sidePanel.setOptions({ tabId, path: PANEL_PATH, enabled: true }).catch(() => {});
  } else {
    await chrome.sidePanel.setOptions({ tabId, enabled: false }).catch(() => {});
  }
}

// When a tab's URL changes, enable/disable the panel for that tab.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "complete") {
    void syncPanelForTab(tabId, tab.url);
  }
});

// When the user switches tabs, sync the panel state for the newly active tab.
chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId).then((tab) => {
    void syncPanelForTab(tabId, tab.url);
  }).catch(() => {});
});

// Toolbar click → open the side panel (only works when enabled for the tab).
chrome.action.onClicked.addListener((tab) => {
  if (tab.id !== undefined && tab.windowId !== undefined) {
    chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  }
});

// ── OLD: Toolbar click → toggle the floating panel (commented out) ───────────
// chrome.action.onClicked.addListener((tab) => {
//   if (tab.id !== undefined) {
//     chrome.tabs.sendMessage(tab.id, { type: "toggle" }).catch(() => {
//       // Content script not present (e.g. chrome:// pages).
//     });
//   }
// });

// ── CDP Screenshot capture (new approach) ─────────────────────────────────────
// Uses chrome.debugger (Chrome DevTools Protocol) to capture a screenshot of the
// active tab. Works on any page, not just Zoho Show. No dependency on page internals.

async function captureScreenshotCDP(tabId: number): Promise<{ dataUrl?: string; error?: string }> {
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("Another debugger is already attached")) {
      return { error: `Failed to attach debugger: ${msg}` };
    }
  }

  try {
    const result = await chrome.debugger.sendCommand(
      { tabId },
      "Page.captureScreenshot",
      { format: "jpeg", quality: 85 },
    ) as { data: string };

    if (!result?.data) {
      return { error: "CDP returned no screenshot data" };
    }

    return { dataUrl: `data:image/jpeg;base64,${result.data}` };
  } catch (err) {
    return { error: `Screenshot failed: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      // Already detached or tab closed
    }
  }
}

// ── OLD: Slide capture (Zoho Show), runs in the page's MAIN world (commented out)
// Bypasses the page CSP so it can reach Zoho Show's global `DownloadUtil`.
// Passing a callback (and no execute flag) returns the JPEG data URL instead of
// triggering a file download.
//
// function captureSlideInPage(): Promise<{ dataUrl?: string; error?: string }> {
//   return new Promise((resolve) => {
//     interface ZohoDownloadUtil { downloadAsImage: (...args: unknown[]) => void }
//     const util = (window as unknown as { DownloadUtil?: ZohoDownloadUtil }).DownloadUtil;
//     if (!util || typeof util.downloadAsImage !== "function") {
//       resolve({ error: "DownloadUtil not found — open a Zoho Show slide, then try again" });
//       return;
//     }
//
//     let settled = false;
//     const finish = (r: { dataUrl?: string; error?: string }) => {
//       if (settled) return;
//       settled = true;
//       resolve(r);
//     };
//
//     try {
//       util.downloadAsImage(
//         "SLIDE",
//         undefined,
//         (url: string) => finish({ dataUrl: url }),
//         undefined,
//         { imageFormat: "jpeg" },
//       );
//     } catch (e) {
//       finish({ error: String(e) });
//     }
//
//     setTimeout(() => finish({ error: "Timed out waiting for the slide to render" }), 13000);
//   });
// }

// ── URL fetch: two-tier strategy ─────────────────────────────────────────────
//
// Tier 1 — direct fetch() from the service worker. Fast and lightweight but
//          some sites block requests without a real browser User-Agent / cookies.
// Tier 2 — open the URL in a hidden background tab, let the browser fully load
//          it (JS rendering, cookies, anti-bot passes), then extract
//          document.body.innerText via chrome.scripting. Always works but slower.
//
// We try Tier 1 first and fall back to Tier 2 on failure.

const MAX_FETCH_BYTES = 512_000;
const MAX_TEXT_CHARS  = 6_000;

function capText(raw: string): string {
  const text = raw.trim();
  if (!text) return "(page returned no readable text)";
  return text.length > MAX_TEXT_CHARS
    ? text.slice(0, MAX_TEXT_CHARS) + "\n…(truncated)"
    : text;
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|article)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Tier 1: lightweight direct fetch
async function fetchViaNetwork(url: string): Promise<{ text?: string; error?: string }> {
  try {
    const res = await fetch(url, {
      headers: { Accept: "text/html, text/plain, application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { error: `HTTP ${res.status} ${res.statusText}` };

    const ct = res.headers.get("content-type") ?? "";
    const raw = (await res.text()).slice(0, MAX_FETCH_BYTES);

    const text = ct.includes("text/html") || ct.includes("application/xhtml")
      ? htmlToText(raw)
      : raw.trim();

    return { text: capText(text) };
  } catch {
    return { error: "network-fail" };
  }
}

// Tier 2: background tab + DOM extraction
function waitForTabComplete(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdate);
      reject(new Error("Page load timed out"));
    }, timeoutMs);

    function onUpdate(id: number, info: chrome.tabs.OnUpdatedInfo) {
      if (id !== tabId || info.status !== "complete") return;
      chrome.tabs.onUpdated.removeListener(onUpdate);
      clearTimeout(timer);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(onUpdate);

    // If the tab finished loading before the listener was added
    chrome.tabs.get(tabId).then((t) => {
      if (t.status === "complete") {
        chrome.tabs.onUpdated.removeListener(onUpdate);
        clearTimeout(timer);
        resolve();
      }
    }).catch(() => {/* tab may be gone, timeout will handle it */});
  });
}

async function fetchViaTab(url: string): Promise<{ text?: string; error?: string }> {
  let tabId: number | undefined;
  try {
    const tab = await chrome.tabs.create({ url, active: false });
    tabId = tab.id;
    if (tabId === undefined) return { error: "Could not create background tab" };

    await waitForTabComplete(tabId, 20_000);

    // Small delay for JS-heavy pages to finish rendering after "complete" fires
    await new Promise((r) => setTimeout(r, 800));

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.body?.innerText ?? "",
    });

    const text = results?.[0]?.result ?? "";
    return { text: capText(text) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (tabId !== undefined) chrome.tabs.remove(tabId).catch(() => {});
  }
}

// Combined: try fast fetch, fall back to tab extraction
async function fetchUrl(url: string): Promise<{ text?: string; error?: string }> {
  const fast = await fetchViaNetwork(url);
  if (fast.text) return fast;
  return fetchViaTab(url);
}

// ── Google AI Mode research ──────────────────────────────────────────────────
// Opens google.com/search?udm=50 in a background tab and waits for the AI
// response to stream in and stabilise before scraping it. This gives the model
// Google's AI-synthesized answer as research context.

const GOOGLE_AI_MAX_CHARS = 8_000;

async function fetchGoogleAI(query: string): Promise<{ text?: string; error?: string }> {
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&udm=50`;
  let tabId: number | undefined;
  try {
    const tab = await chrome.tabs.create({ url, active: false });
    tabId = tab.id;
    if (tabId === undefined) return { error: "Could not create tab" };

    await waitForTabComplete(tabId, 15_000);

    // Google AI Mode streams its response after the page "completes". We inject
    // a script that polls until the page text stabilises (content stops growing
    // for a few consecutive checks), then returns the text.
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: async () => {
        const maxWait = 30_000;
        const interval = 1_500;
        let elapsed = 0;
        let lastLen = 0;
        let stable = 0;

        while (elapsed < maxWait) {
          await new Promise((r) => setTimeout(r, interval));
          elapsed += interval;
          const len = (document.body?.innerText ?? "").length;
          if (len === lastLen && len > 200) {
            stable++;
            if (stable >= 3) break;
          } else {
            stable = 0;
            lastLen = len;
          }
        }

        return document.body?.innerText ?? "";
      },
    });

    const raw = results?.[0]?.result ?? "";
    const text = raw.trim();
    if (!text) return { text: "(Google AI returned no content)" };
    return {
      text: text.length > GOOGLE_AI_MAX_CHARS
        ? text.slice(0, GOOGLE_AI_MAX_CHARS) + "\n…(truncated)"
        : text,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (tabId !== undefined) chrome.tabs.remove(tabId).catch(() => {});
  }
}

// ── Browser-agent: observe + act on the active tab ───────────────────────────
//
// The side panel drives the agent loop but can't touch the page, so it asks us
// to (1) observe — screenshot + collect interactive elements — and (2) act —
// run a resolved action. We relay element/action work to the active tab's
// content script and keep the CDP screenshot here.

// Cache the last tab the user explicitly activated. When the Chrome side panel
// has keyboard focus, `currentWindow` resolution in the service worker can be
// ambiguous and return an empty array — the fallback keeps things working.
let _lastActiveTabId: number | undefined;
chrome.tabs.onActivated.addListener(({ tabId }) => {
  _lastActiveTabId = tabId;
});

async function activeTabId(): Promise<number | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab?.id ?? _lastActiveTabId;
}

// Get the content script file path from the built manifest (Parcel hashes it).
function getContentScriptFile(): string {
  const manifest = chrome.runtime.getManifest() as {
    content_scripts?: { js?: string[] }[];
  };
  return manifest.content_scripts?.[0]?.js?.[0] ?? "content.js";
}

// Inject the content script into a tab that was already open when the extension
// loaded/reloaded. Returns true on success, false if injection failed.
async function injectContentScript(tabId: number): Promise<boolean> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [getContentScriptFile()],
    });
    // Give the script a moment to set up its message listener.
    await new Promise((r) => setTimeout(r, 150));
    return true;
  } catch {
    return false;
  }
}

function sendToContent<T extends FromContent>(tabId: number, message: ToContent): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (resp) => {
      if (chrome.runtime.lastError || !resp) {
        reject(new Error(chrome.runtime.lastError?.message ?? "Content script not reachable"));
        return;
      }
      resolve(resp as T);
    });
  });
}

// Try to send a message; if the content script isn't there, inject it and retry.
async function sendToContentWithInject<T extends FromContent>(
  tabId: number,
  message: ToContent,
): Promise<T> {
  try {
    return await sendToContent<T>(tabId, message);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (!msg.includes("Receiving end does not exist") && !msg.includes("not reachable")) {
      throw err;
    }
    // Content script not present — inject it and retry once.
    const ok = await injectContentScript(tabId);
    if (!ok) throw new Error(`Could not inject the agent into this page: ${err instanceof Error ? err.message : String(err)}`);
    return await sendToContent<T>(tabId, message);
  }
}

async function agentObserve(): Promise<AgentObserveResponse> {
  const tabId = await activeTabId();
  if (tabId === undefined) return { error: "No active tab found" };

  // Collect elements first (cheap), then screenshot the same visual state.
  let observation: PageObservation;
  try {
    const resp = await sendToContentWithInject<{ observation: PageObservation }>(tabId, {
      type: "sp:collectElements",
    });
    observation = resp.observation;
  } catch (err) {
    return { error: `Couldn't read the page: ${err instanceof Error ? err.message : String(err)}` };
  }

  const shot = await captureScreenshotCDP(tabId);
  if (shot.error) return { observation, error: shot.error };
  return { observation, dataUrl: shot.dataUrl };
}

async function agentAct(action: AgentAction, snapshotId: number): Promise<AgentActResponse> {
  const tabId = await activeTabId();
  if (tabId === undefined) return { ok: false, detail: "No active tab found" };
  try {
    return await sendToContentWithInject<AgentActResponse>(tabId, {
      type: "sp:executeAction",
      action,
      snapshotId,
    });
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

// ── Runtime messages: offscreen→client relay, keepalive, slide/url/google fetch

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Engine events coming back from the offscreen doc → forward to the client.
  if (msg?.to === "relay") {
    const { to, clientId, ...event } = msg as ToRelay;
    void to;
    const evKind = (event as EngineEvent).kind;
    if (evKind !== "delta") {
      console.log(`[BG][relay] clientId=${clientId} kind="${evKind}" clientExists=${clients.has(clientId)}`);
    }
    const port = clients.get(clientId);
    if (port) {
      try {
        port.postMessage(event);
      } catch {
        console.warn(`[BG][relay] postMessage failed for clientId=${clientId} — removing`);
        clients.delete(clientId);
      }
    }
    return;
  }

  if (msg?.to === "keepalive") return;

  // Log all non-relay, non-keepalive messages
  const msgType = msg?.type ?? msg?.to ?? "unknown";
  console.log(`[BG][onMessage] type="${msgType}"`, msg?.type === "fetchUrl" ? `url="${msg.url}"` : "");

  if (msg?.type === "fetchUrl" && typeof msg.url === "string") {
    fetchUrl(msg.url).then((r) => { console.log(`[BG][fetchUrl] result: ${r.text ? `text(${r.text.length})` : `error: ${r.error}`}`); sendResponse(r); }).catch(() => sendResponse({ error: "Fetch failed" }));
    return true;
  }

  if (msg?.type === "googleAI" && typeof msg.query === "string") {
    console.log(`[BG][googleAI] query="${msg.query}"`);
    fetchGoogleAI(msg.query).then(sendResponse).catch(() => sendResponse({ error: "Google AI fetch failed" }));
    return true;
  }

  if (msg?.type === "cdpScreenshot") {
    console.log("[BG][cdpScreenshot] capturing…");
    chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(async (tabs) => {
      const tabId = tabs[0]?.id ?? _lastActiveTabId;
      if (tabId === undefined) {
        console.warn("[BG][cdpScreenshot] no active tab");
        sendResponse({ error: "No active tab found" });
        return;
      }
      const result = await captureScreenshotCDP(tabId);
      console.log(`[BG][cdpScreenshot] result: ${result.dataUrl ? `dataUrl(${result.dataUrl.length})` : `error: ${result.error}`}`);
      sendResponse(result);
    }).catch((err) => {
      console.error("[BG][cdpScreenshot] error:", err);
      sendResponse({ error: err instanceof Error ? err.message : String(err) });
    });
    return true;
  }

  if (msg?.type === "agentObserve") {
    console.log("[BG][agentObserve] observing…");
    agentObserve().then((resp) => {
      console.log(`[BG][agentObserve] result: elements=${resp.observation?.elements.length ?? 0} hasScreenshot=${!!resp.dataUrl} error=${resp.error ?? "none"}`);
      sendResponse(resp);
    }).catch((err) => {
      console.error("[BG][agentObserve] error:", err);
      sendResponse({ error: err instanceof Error ? err.message : String(err) });
    });
    return true;
  }

  if (msg?.type === "agentAct") {
    console.log(`[BG][agentAct] action=`, JSON.stringify(msg.action), `snapshotId=${msg.snapshotId}`);
    agentAct(msg.action, msg.snapshotId).then((resp) => {
      console.log(`[BG][agentAct] result: ok=${resp.ok} detail="${resp.detail}"`);
      sendResponse(resp);
    }).catch((err) => {
      console.error("[BG][agentAct] error:", err);
      sendResponse({ ok: false, detail: err instanceof Error ? err.message : String(err) });
    });
    return true;
  }

  if (msg?.type === "createPresentation" && msg.url && msg.payload) {
    console.log(`[BG][createPresentation] url="${msg.url}" sessionId=${msg.sessionId}`);
    activeTabId().then(async (tabId) => {
      if (tabId === undefined) {
        sendResponse({ error: "No active tab" });
        return;
      }
      try {
        const { url, payload, sessionId } = msg;
        // Inject script to set sessionStorage and navigate in the same tab
        await chrome.scripting.executeScript({
          target: { tabId },
          func: (createUrl: string, jsonPayload: string, lId: string) => {
            const zsnflpObj: Record<string, unknown> = {};
            zsnflpObj[lId] = JSON.parse(jsonPayload);
            window.sessionStorage.setItem("zsnflp", JSON.stringify(zsnflpObj));
            window.location.href = createUrl;
          },
          args: [url, JSON.stringify(payload), sessionId],
        });
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ error: err instanceof Error ? err.message : String(err) });
      }
    });
    return true;
  }


  if (msg?.type === "getActiveTabUrl") {
    console.log("[BG][getActiveTabUrl] fetching…");
    activeTabId().then(async (tabId) => {
      if (tabId === undefined) {
        sendResponse({ url: undefined });
        return;
      }
      const tab = await chrome.tabs.get(tabId);
      sendResponse({ url: tab.url });
    }).catch(() => sendResponse({ url: undefined }));
    return true;
  }


  if (msg?.type === "changeTheme" && typeof msg.themeId === "string") {
    console.log(`[BG][changeTheme] themeId="${msg.themeId}"`);
    activeTabId().then(async (tabId) => {
      if (tabId === undefined) {
        sendResponse({ ok: false, error: "No active tab" });
        return;
      }
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          func: (tid: string) => {
            try {
              const $ = (window as unknown as Record<string, unknown>).$ as Record<string, unknown>;
              const listing = $.ListingDialog as Record<string, unknown>;
              (listing.changeTheme as (id: string) => void)(tid);
              return { ok: true };
            } catch (e: unknown) {
              return { ok: false, error: (e as Error).message };
            }
          },
          args: [msg.themeId],
        });
        sendResponse(results?.[0]?.result ?? { ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
    return true;
  }

  if (msg?.type === "getSlideData") {
    console.log("[BG][getSlideData] fetching from active tab…");
    activeTabId().then(async (tabId) => {
      if (tabId === undefined) {
        sendResponse({ ok: false, error: "No active tab" });
        return;
      }
      try {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          func: () => {
            try {
              // Try multiple access paths for SlideHandler
              const win = window as unknown as Record<string, unknown>;
              const $ = win.$ as Record<string, unknown> | undefined;

              // Path 1: $.SlideHandler.getSelectedSlideData()
              if ($) {
                const handler = $.SlideHandler as Record<string, unknown> | undefined;
                if (handler && typeof handler.getSelectedSlideData === "function") {
                  return { ok: true, data: handler.getSelectedSlideData() };
                }
              }

              // Path 2: window.SlideHandler (direct global)
              const directHandler = win.SlideHandler as Record<string, unknown> | undefined;
              if (directHandler && typeof directHandler.getSelectedSlideData === "function") {
                return { ok: true, data: directHandler.getSelectedSlideData() };
              }

              // Path 3: $.SlideEditor.slideHandler (nested)
              if ($) {
                const editor = $.SlideEditor as Record<string, unknown> | undefined;
                if (editor) {
                  const sh = editor.slideHandler as Record<string, unknown> | undefined;
                  if (sh && typeof sh.getSelectedSlideData === "function") {
                    return { ok: true, data: sh.getSelectedSlideData() };
                  }
                }
              }

              // Debug: report what IS available on $
              const keys = $ ? Object.keys($).filter((k) =>
                k.toLowerCase().includes("slide") || k.toLowerCase().includes("handler")
              ).slice(0, 10) : [];
              return {
                ok: false,
                error: `SlideHandler not found. $ exists: ${!!$}. Slide-related keys on $: [${keys.join(", ")}]`,
              };
            } catch (e: unknown) {
              return { ok: false, error: (e as Error).message };
            }
          },
        });
        sendResponse(result?.result ?? { ok: false, error: "No result from page" });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
    return true;
  }

  if (msg?.type === "getSlideDataByIndex") {
    const slideIndex = (msg as { type: string; slideIndex: number }).slideIndex;
    console.log(`[BG][getSlideDataByIndex] index=${slideIndex}`);
    activeTabId().then(async (tabId) => {
      if (tabId === undefined) {
        sendResponse({ ok: false, error: "No active tab" });
        return;
      }
      try {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          args: [slideIndex],
          func: (idx: number) => {
            try {
              const win = window as unknown as Record<string, unknown>;
              const $ = win.$ as Record<string, unknown> | undefined;
              if ($) {
                const SlideClass = $.Slide as { get?: (ref: unknown) => Record<string, unknown> } | undefined;
                const docData = $.docData as { getSlideByIndex?: (i: number) => unknown } | undefined;
                if (SlideClass?.get && docData?.getSlideByIndex) {
                  const slideRef = docData.getSlideByIndex(idx);
                  const slideData = SlideClass.get(slideRef);
                  return { ok: true, data: { themeInfo: slideData?.themeInfo } };
                }
              }
              return { ok: false, error: "$.Slide.get or $.docData.getSlideByIndex not found" };
            } catch (e: unknown) {
              return { ok: false, error: (e as Error).message };
            }
          },
        });
        sendResponse(result?.result ?? { ok: false, error: "No result from page" });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
    return true;
  }

  if (msg?.type === "getDocData") {
    console.log("[BG][getDocData] fetching $.docData.masters from active tab…");
    activeTabId().then(async (tabId) => {
      if (tabId === undefined) {
        sendResponse({ ok: false, error: "No active tab" });
        return;
      }
      try {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          func: () => {
            try {
              const win = window as unknown as Record<string, unknown>;
              const $ = win.$ as Record<string, unknown> | undefined;

              // Primary path: $.docData.masters
              if ($) {
                const docData = $.docData as Record<string, unknown> | undefined;
                if (docData && Array.isArray(docData.masters)) {
                  return { ok: true, data: docData.masters };
                }
              }

              // Fallback: window.docData.masters
              const winDocData = win.docData as Record<string, unknown> | undefined;
              if (winDocData && Array.isArray(winDocData.masters)) {
                return { ok: true, data: winDocData.masters };
              }

              const keys = $ ? Object.keys($).filter((k) =>
                k.toLowerCase().includes("doc") || k.toLowerCase().includes("master")
              ).slice(0, 10) : [];
              return {
                ok: false,
                error: `$.docData.masters not found. $ exists: ${!!$}. Doc-related keys on $: [${keys.join(", ")}]`,
              };
            } catch (e: unknown) {
              return { ok: false, error: (e as Error).message };
            }
          },
        });
        sendResponse(result?.result ?? { ok: false, error: "No result from page" });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
    return true;
  }
});
