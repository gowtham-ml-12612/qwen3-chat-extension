// Service worker: thin coordinator. It no longer runs any model (that moved to
// the offscreen document). Its jobs are:
//   1. Toggle the floating panel when the toolbar icon is clicked.
//   2. Capture the current Zoho Show slide in the page's MAIN world.
//   3. Own the offscreen document lifecycle and relay messages between each
//      content-script port and the offscreen engine.

import { ENGINE_PORT, type EngineEvent, type ToRelay } from "./messages";

// ── Offscreen document lifecycle ──────────────────────────────────────────────

let creating: Promise<void> | undefined;

async function ensureOffscreen(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: "offscreen.html",
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification: "Runs the local Qwen3.5 model (WebAssembly + WebGPU) for chat and slide analysis.",
      })
      .catch((err) => {
        // A racing caller may have already created it — that's fine.
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("single offscreen")) throw err;
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
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

// ── Content port relay ────────────────────────────────────────────────────────

let nextClientId = 1;
const clients = new Map<number, chrome.runtime.Port>();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== ENGINE_PORT) return;
  const clientId = nextClientId++;
  clients.set(clientId, port);

  port.onMessage.addListener(async (msg) => {
    try {
      await ensureOffscreen();
    } catch (err) {
      const event: EngineEvent = {
        kind: "loaderror",
        message: err instanceof Error ? err.message : String(err),
      };
      port.postMessage(event);
      return;
    }
    void sendToOffscreen({ to: "offscreen", clientId, ...msg });
  });

  port.onDisconnect.addListener(() => {
    clients.delete(clientId);
    void sendToOffscreen({ to: "offscreen", clientId, cmd: "disconnect" });
    // Free the model's memory once nobody is using it anymore.
    if (clients.size === 0) {
      chrome.offscreen.hasDocument().then((has) => {
        if (has && clients.size === 0) chrome.offscreen.closeDocument().catch(() => {});
      });
    }
  });
});

// ── Toolbar click → toggle the panel ──────────────────────────────────────────

chrome.action.onClicked.addListener((tab) => {
  if (tab.id !== undefined) {
    chrome.tabs.sendMessage(tab.id, { type: "toggle" }).catch(() => {
      // Content script not present (e.g. chrome:// pages).
    });
  }
});

// ── Slide capture (Zoho Show), runs in the page's MAIN world ──────────────────
// Bypasses the page CSP so it can reach Zoho Show's global `DownloadUtil`.
// Passing a callback (and no execute flag) returns the JPEG data URL instead of
// triggering a file download.
function captureSlideInPage(): Promise<{ dataUrl?: string; error?: string }> {
  return new Promise((resolve) => {
    interface ZohoDownloadUtil { downloadAsImage: (...args: unknown[]) => void }
    const util = (window as unknown as { DownloadUtil?: ZohoDownloadUtil }).DownloadUtil;
    if (!util || typeof util.downloadAsImage !== "function") {
      resolve({ error: "DownloadUtil not found — open a Zoho Show slide, then try again" });
      return;
    }

    let settled = false;
    const finish = (r: { dataUrl?: string; error?: string }) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    try {
      util.downloadAsImage(
        "SLIDE",
        undefined,
        (url: string) => finish({ dataUrl: url }),
        undefined,
        { imageFormat: "jpeg" },
      );
    } catch (e) {
      finish({ error: String(e) });
    }

    setTimeout(() => finish({ error: "Timed out waiting for the slide to render" }), 13000);
  });
}

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

    function onUpdate(id: number, info: chrome.tabs.TabChangeInfo) {
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

// ── Runtime messages: offscreen→client relay, keepalive, slide/url/google fetch

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Engine events coming back from the offscreen doc → forward to the client.
  if (msg?.to === "relay") {
    const { to, clientId, ...event } = msg as ToRelay;
    void to;
    const port = clients.get(clientId);
    if (port) {
      try {
        port.postMessage(event);
      } catch {
        // Client disconnected mid-stream; drop the rest.
        clients.delete(clientId);
      }
    }
    return;
  }

  // Offscreen heartbeat — receiving it is enough to keep the SW alive.
  if (msg?.to === "keepalive") return;

  // URL fetch request from a content script.
  if (msg?.type === "fetchUrl" && typeof msg.url === "string") {
    fetchUrl(msg.url).then(sendResponse).catch(() => sendResponse({ error: "Fetch failed" }));
    return true;
  }

  // Google AI Mode research request.
  if (msg?.type === "googleAI" && typeof msg.query === "string") {
    fetchGoogleAI(msg.query).then(sendResponse).catch(() => sendResponse({ error: "Google AI fetch failed" }));
    return true;
  }

  // Slide capture request from a content script.
  if (msg?.type === "getSlideImage") {
    const tabId = sender.tab?.id;
    if (tabId === undefined) {
      sendResponse({ error: "No active tab" });
      return;
    }
    chrome.scripting
      .executeScript({ target: { tabId }, world: "MAIN", func: captureSlideInPage })
      .then((results) => sendResponse(results[0]?.result ?? { error: "No result from page" }))
      .catch((err) => sendResponse({ error: err?.message ? String(err.message) : String(err) }));
    return true; // async response
  }
});
