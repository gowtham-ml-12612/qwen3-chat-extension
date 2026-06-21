// Centralized Zoho Show API abstraction.
// All interactions with Zoho Show's internal APIs go through here.
// When Zoho changes their internals, fix this one file.

import type { AgentAction, PageObservation } from "../actions";
import type { AgentObserveResponse, AgentActResponse } from "../messages";

export interface ZohoCreatePresentationParams {
  url: string;
  payload: Record<string, unknown>;
  sessionId: string;
}

function sendMessageToBackground<T>(msg: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError || !resp) {
        reject(new Error(chrome.runtime.lastError?.message ?? "No response"));
        return;
      }
      resolve(resp as T);
    });
  });
}

export const zohoAPI = {
  async getSlideData(): Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string }> {
    return sendMessageToBackground({ type: "getSlideData" });
  },

  async getDocData(): Promise<{ ok: boolean; data?: unknown[]; error?: string }> {
    return sendMessageToBackground({ type: "getDocData" });
  },

  async getSlideDataByIndex(slideIndex: number): Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string }> {
    return sendMessageToBackground({ type: "getSlideDataByIndex", slideIndex });
  },

  async createPresentation(params: ZohoCreatePresentationParams): Promise<{ ok: boolean; error?: string }> {
    return sendMessageToBackground({
      type: "createPresentation",
      url: params.url,
      payload: params.payload,
      sessionId: params.sessionId,
    });
  },

  async changeTheme(themeId: string): Promise<{ ok: boolean; error?: string }> {
    return sendMessageToBackground({ type: "changeTheme", themeId });
  },

  async getActiveTabUrl(): Promise<string | undefined> {
    try {
      const resp = await sendMessageToBackground<{ url?: string }>({ type: "getActiveTabUrl" });
      return resp.url;
    } catch {
      return undefined;
    }
  },

  async captureScreenshot(): Promise<string> {
    const resp = await sendMessageToBackground<{ dataUrl?: string; error?: string }>({ type: "cdpScreenshot" });
    if (!resp.dataUrl) throw new Error(resp.error ?? "Screenshot failed");
    return resp.dataUrl;
  },

  async fetchUrl(url: string): Promise<{ text?: string; error?: string }> {
    return sendMessageToBackground({ type: "fetchUrl", url });
  },

  async observePage(): Promise<AgentObserveResponse> {
    return sendMessageToBackground({ type: "agentObserve" });
  },

  async actOnPage(action: AgentAction, snapshotId: number): Promise<AgentActResponse> {
    return sendMessageToBackground({ type: "agentAct", action, snapshotId });
  },
};

// Zoho Show domain detection
const SHOW_ORIGIN_RE = /^show\.(zoho\.(com|in|eu|com\.au|com\.cn)|localzoho\.com)$/;

export function getShowOrigin(tabUrl: string): string | undefined {
  try {
    const url = new URL(tabUrl);
    if (SHOW_ORIGIN_RE.test(url.hostname)) return url.origin;
    const match = url.hostname.match(/(?:^|\.)zoho\.(com|in|eu|com\.au|com\.cn)$/);
    if (match) return `https://show.zoho.${match[1]}`;
    if (url.hostname.includes("localzoho.com")) return `https://show.localzoho.com`;
  } catch { /* invalid URL */ }
  return undefined;
}
