import type { Tool, ToolContext, ToolResult } from "../types";
import { zohoAPI } from "../../zoho/api";
import { getThemeByName, selectTheme } from "../../themes";
import { dlog } from "../../debug-log";

export const changeThemeTool: Tool = {
  name: "change_theme",
  description: "user wants to change / switch / apply a different theme or template to the CURRENT presentation",
  params: [
    { name: "theme_name", type: "string", description: "the theme name or style the user wants", required: true },
  ],
  mutating: true,
  async run(ctx: ToolContext): Promise<ToolResult | null> {
    dlog.log("SP", `[tool:change_theme] run args=${JSON.stringify(ctx.args)}`);
    ctx.setStatus("Changing the theme…");

    let requestedName = (ctx.args.theme_name ?? "").trim().replace(/[^a-zA-Z0-9 -]/g, "");
    if (!requestedName) {
      // Fallback: try to infer from inference (requires module-level fn)
      if (_runInference) {
        const nameResponse = await _runInference(
          `You extract the theme name from the user's request. Reply with ONLY the theme name, nothing else.`,
          `User says: "${ctx.userText}"\n\nExtract the theme name the user wants to switch to:`,
        );
        requestedName = nameResponse.trim().replace(/[^a-zA-Z0-9 -]/g, "");
      }
    }

    const theme = getThemeByName(requestedName) ?? selectTheme(requestedName);
    if (!theme) {
      const msg = `Couldn't find a theme matching "${requestedName}". Try browsing available themes first.`;
      ctx.replyEl.querySelector(".msg-body")!.textContent = msg;
      return { assistantText: msg };
    }

    if (ctx.isStopped()) return null;

    const result = await zohoAPI.changeTheme(theme.id);
    if (!result.ok) {
      const msg = `Couldn't change theme: ${result.error ?? "unknown error"}`;
      ctx.replyEl.querySelector(".msg-body")!.textContent = msg;
      return { assistantText: msg };
    }

    const msg = `Changed the presentation theme to "${theme.name}".`;
    ctx.replyEl.querySelector(".msg-body")!.textContent = msg;
    return { assistantText: `[Action performed: ${msg}]`, remember: true };
  },
};

let _runInference: ((system: string, user: string) => Promise<string>) | undefined;

export function setInferenceFunction(fn: (system: string, user: string) => Promise<string>): void {
  _runInference = fn;
}
