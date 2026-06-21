import type { Tool, ToolContext, ToolResult } from "../types";
import { THEMES, type PresentationType } from "../../themes";
import { dlog } from "../../debug-log";

/**
 * Groups themes by their suitedFor categories and returns a formatted list.
 */
function formatThemeCatalogue(): string {
  const grouped: Record<string, string[]> = {};
  for (const theme of THEMES) {
    for (const cat of theme.suitedFor) {
      if (!grouped[cat]) grouped[cat] = [];
      if (!grouped[cat].includes(theme.name)) grouped[cat].push(theme.name);
    }
  }

  const lines: string[] = [];
  for (const [cat, names] of Object.entries(grouped)) {
    const label = cat.charAt(0).toUpperCase() + cat.slice(1).replace(/-/g, " ");
    lines.push(`**${label}**: ${names.join(", ")}`);
  }
  return lines.join("\n\n");
}

export const browseThemesTool: Tool = {
  name: "browse_themes",
  description:
    "user wants to BROWSE, LIST, or EXPLORE available themes they can switch to — asking what options/choices/alternatives exist in the theme catalogue, NOT asking about what's currently applied (that's doccontext)",
  async run(ctx: ToolContext): Promise<ToolResult | null> {
    dlog.log("SP", `[tool:browse_themes] run`);
    ctx.setStatus("Listing available themes…");
    if (ctx.isStopped()) return null;

    const total = THEMES.length;
    const catalogue = formatThemeCatalogue();
    const reply = `There are **${total} themes** available. Here they are by category:\n\n${catalogue}\n\nTo apply one, just say "change theme to [name]".`;

    const body = ctx.replyEl.querySelector(".msg-body");
    if (body) body.innerHTML = "";

    // Use the setContent passed in via factory... but since this tool is standalone,
    // we'll render directly
    if (_setContent) {
      _setContent(ctx.replyEl, reply);
    } else {
      const body = ctx.replyEl.querySelector(".msg-body");
      if (body) body.textContent = reply;
    }

    return { assistantText: reply };
  },
};

let _setContent: ((el: HTMLDivElement, text: string) => void) | undefined;

export function setBrowseThemesSetContent(fn: (el: HTMLDivElement, text: string) => void): void {
  _setContent = fn;
}
