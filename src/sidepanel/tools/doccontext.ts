import type { Tool, ToolContext, ToolResult, DocContextResult } from "../types";
import { zohoAPI } from "../../zoho/api";
import { summarizeDocForAI, getMastersInfo } from "../../slide-data";
import { dlog } from "../../debug-log";

export function createDoccontextTool(
  setContent: (el: HTMLDivElement, text: string) => void,
  renderColorPalette: (colors: { role: string; hex: string }[]) => HTMLElement,
  fetchSlideContext: () => Promise<{ summary: string; metadata: { theme?: { name: string } } } | null>,
): Tool {
  return {
    name: "doccontext",
    description: "user asks about the presentation's DESIGN — what theme(s) or master(s) the document uses, what fonts or colors are in the deck, how many themes/masters exist, or any design property (theme name, font name, color palette) because these belong to the document masters, not a single slide",
    async run(ctx: ToolContext): Promise<ToolResult | null> {
      dlog.log("SP", `[tool:doccontext] run`);
      ctx.setStatus("Reading document data…");

      const [docResp, slideResult] = await Promise.all([
        zohoAPI.getDocData(),
        fetchSlideContext(),
      ]);
      if (ctx.isStopped()) return null;

      if (!docResp.ok || !Array.isArray(docResp.data)) {
        const msg = `Couldn't read the document data.\nReason: ${docResp.error ?? "unknown"}\n\nMake sure the Zoho Show editor is open.`;
        setContent(ctx.replyEl, msg);
        return { assistantText: msg };
      }

      const parsedMasters = getMastersInfo(docResp.data);
      const masterCount = docResp.data.length;

      const masterLines = parsedMasters
        .map((m, i) =>
          `${i + 1}. **${m.name}**${m.fonts.length ? ` — Fonts: ${m.fonts.join(", ")}` : ""}`,
        )
        .join("\n");

      const currentThemeName = slideResult?.metadata?.theme?.name ?? null;
      const currentPart = currentThemeName
        ? `\n\nYour current slide is using **${currentThemeName}**.`
        : "";

      const reply = `This presentation has **${masterCount}** theme(s):\n\n${masterLines}${currentPart}`;
      setContent(ctx.replyEl, reply);

      const body = ctx.replyEl.querySelector(".msg-body");
      if (body) {
        for (const m of parsedMasters) {
          if (m.colors.length) body.appendChild(renderColorPalette(m.colors));
        }
      }

      return { assistantText: reply };
    },
  };
}
