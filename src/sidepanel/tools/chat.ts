import type { Tool, ToolContext, ToolResult } from "../types";
import { MODES } from "../../modes";
import { dlog } from "../../debug-log";
import { downscaleToDataUrl } from "../image-utils";

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;
const MAX_URLS = 3;

async function fetchUrlViaWorker(url: string): Promise<{ text?: string; error?: string }> {
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
    if (r.text) sections.push(`[Content from ${urls[i]}]:\n${r.text}`);
    else sections.push(`[Could not fetch ${urls[i]}: ${r.error}]`);
  }
  return sections.join("\n\n") + "\n\n---\n\n" + text;
}

export function createChatTool(
  runChat: (text: string, image: string | undefined, replyEl: HTMLDivElement) => Promise<string>,
  setContent: (el: HTMLDivElement, text: string) => void,
  fetchSlideContext: () => Promise<{ summary: string } | null>,
): Tool {
  return {
    name: "none",
    description: "general questions, help, explanations, web links, or anything that doesn't need a slide action",
    async run(ctx: ToolContext): Promise<ToolResult | null> {
      dlog.log("SP", `[tool:none] run hasImage=${!!ctx.attachedImage}`);
      let enriched = ctx.userText;

      const slideResult = await fetchSlideContext();
      if (slideResult) {
        enriched = `[Current presentation state:\n${slideResult.summary}]\n\n${enriched}`;
      }

      URL_RE.lastIndex = 0;
      if (URL_RE.test(ctx.userText)) {
        ctx.setStatus("Reading web page…");
        const fetched = await fetchUrlsInText(ctx.userText);
        enriched = slideResult
          ? `[Current presentation state:\n${slideResult.summary}]\n\n${fetched}`
          : fetched;
        if (ctx.isStopped()) return null;
      }

      let image: string | undefined;
      if (ctx.attachedImage) {
        ctx.setStatus("Analysing the image…");
        image = await downscaleToDataUrl(ctx.attachedImage, MODES[ctx.mode].imageMaxDim);
        if (ctx.isStopped()) return null;
      }

      const reply = await runChat(enriched, image, ctx.replyEl);
      setContent(ctx.replyEl, reply);
      return { assistantText: reply };
    },
  };
}
