import type { Tool, ToolContext, ToolResult } from "../types";
import { zohoAPI } from "../../zoho/api";
import { MODES } from "../../modes";
import { dlog } from "../../debug-log";
import { downscaleToDataUrl } from "../image-utils";

export function createScreenshotTool(
  runChat: (text: string, image: string | undefined, replyEl: HTMLDivElement) => Promise<string>,
  setContent: (el: HTMLDivElement, text: string) => void,
): Tool {
  return {
    name: "screenshot",
    description: "user wants to SEE or analyse something VISUAL on the current slide (colors, layout, images, the text shown, charts, diagrams)",
    async run(ctx: ToolContext): Promise<ToolResult | null> {
      dlog.log("SP", `[tool:screenshot] run`);
      ctx.setStatus("Capturing the page…");
      const rawUrl = await zohoAPI.captureScreenshot();
      ctx.setStatus("Analysing the slide…");
      const image = await downscaleToDataUrl(rawUrl, MODES[ctx.mode].imageMaxDim);
      if (ctx.isStopped()) return null;
      const reply = await runChat(ctx.userText, image, ctx.replyEl);
      setContent(ctx.replyEl, reply);
      return { assistantText: reply };
    },
  };
}
