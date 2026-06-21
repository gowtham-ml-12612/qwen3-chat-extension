import type { Tool, ToolContext, ToolResult } from "../types";
import { zohoAPI } from "../../zoho/api";
import { getThemeFromSlideData } from "../../slide-data";
import { dlog } from "../../debug-log";

const ORDINALS: Record<string, number> = {
  first: 0, second: 1, third: 2, fourth: 3, fifth: 4,
  sixth: 5, seventh: 6, eighth: 7, ninth: 8, tenth: 9,
};

function parseSlideIndex(raw: string): number {
  const s = raw.trim().toLowerCase();
  if (s in ORDINALS) return ORDINALS[s];
  // "slide 3" → 0-based index 2
  const withLabel = s.match(/^slide\s+(\d+)$/);
  if (withLabel) return parseInt(withLabel[1], 10) - 1;
  // plain number treated as 1-based ("1" → 0)
  const n = parseInt(s, 10);
  if (!isNaN(n) && n >= 1) return n - 1;
  return 0;
}

export function createSlideinfoTool(
  setContent: (el: HTMLDivElement, text: string) => void,
  renderColorPalette: (colors: { role: string; hex: string }[]) => HTMLElement,
): Tool {
  return {
    name: "slideinfo",
    description: "user asks about a SPECIFIC slide's theme, fonts, or colors by position — e.g. 'what theme is the first slide using?', 'what theme does slide 3 have?', 'what fonts does the second slide use?' — use this when the user names a slide by number or ordinal, NOT for the current slide or the whole document",
    params: [
      {
        name: "slideIndex",
        type: "string",
        description: "which slide the user means: ordinal word ('first','second') or number ('1','2','slide 3')",
        required: true,
      },
    ],
    async run(ctx: ToolContext): Promise<ToolResult | null> {
      const rawIndex = ctx.args.slideIndex ?? "first";
      dlog.log("SP", `[tool:slideinfo] run slideIndex="${rawIndex}"`);
      ctx.setStatus("Reading slide data…");

      const idx = parseSlideIndex(rawIndex);
      const resp = await zohoAPI.getSlideDataByIndex(idx);
      if (ctx.isStopped()) return null;

      if (!resp.ok || !resp.data) {
        const msg = `Couldn't read slide ${idx + 1} data.\nReason: ${resp.error ?? "unknown"}\n\nMake sure the Zoho Show editor is open.`;
        setContent(ctx.replyEl, msg);
        return { assistantText: msg };
      }

      const theme = getThemeFromSlideData(resp.data);
      if (!theme) {
        const msg = `No theme info found for slide ${idx + 1}.`;
        setContent(ctx.replyEl, msg);
        return { assistantText: msg };
      }

      const fontPart = theme.fonts.length ? `\n- Fonts: ${theme.fonts.join(", ")}` : "";
      const reply = `Slide ${idx + 1} is using the **${theme.name}** theme.${fontPart}`;
      setContent(ctx.replyEl, reply);

      if (theme.colors.length) {
        const body = ctx.replyEl.querySelector(".msg-body");
        if (body) body.appendChild(renderColorPalette(theme.colors));
      }

      return { assistantText: reply };
    },
  };
}
