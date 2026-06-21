import type { Tool, ToolContext, ToolResult } from "../types";
import { dlog } from "../../debug-log";

export function createSlidecontextTool(
  runChat: (text: string, image: string | undefined, replyEl: HTMLDivElement) => Promise<string>,
  setContent: (el: HTMLDivElement, text: string) => void,
  renderColorPalette: (colors: { role: string; hex: string }[]) => HTMLElement,
  fetchSlideContext: () => Promise<{ summary: string; metadata: { theme?: { name: string; colors: { role: string; hex: string }[] } } } | null>,
): Tool {
  return {
    name: "slidecontext",
    description: "user asks about the CURRENT slide's position or structure — which slide number they are on, the slide index, the slide name, or the slide type/layout — NOT themes, fonts, or colors (those are document-level, use doccontext)",
    async run(ctx: ToolContext): Promise<ToolResult | null> {
      dlog.log("SP", `[tool:slidecontext] run`);
      ctx.setStatus("Reading presentation data…");
      const result = await fetchSlideContext();
      if (ctx.isStopped()) return null;

      if (!result) {
        const msg = "Couldn't read the presentation data.\n\nMake sure the Zoho Show editor is open and a slide is selected.";
        setContent(ctx.replyEl, msg);
        return { assistantText: msg };
      }

      const enriched = `[Current presentation state:\n${result.summary}]\n\n${ctx.userText}`;
      const reply = await runChat(enriched, undefined, ctx.replyEl);
      setContent(ctx.replyEl, reply);

      if (result.metadata.theme?.colors.length) {
        const body = ctx.replyEl.querySelector(".msg-body");
        if (body) body.appendChild(renderColorPalette(result.metadata.theme.colors));
      }

      return { assistantText: reply };
    },
  };
}
