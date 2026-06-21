import type { Tool, ToolSelection } from "./types";
import { extractJsonObject } from "../actions";
import { dlog } from "../debug-log";
import type { EffortMode } from "../modes";

let tools: Tool[] = [];

export function registerTool(tool: Tool): void {
  tools.push(tool);
}

export function registerTools(newTools: Tool[]): void {
  tools = newTools;
}

export function getTools(): Tool[] {
  return tools;
}

export function getDefaultTool(): Tool {
  return tools.find((t) => t.name === "none") ?? tools[tools.length - 1];
}

export function buildToolDefsBlock(): string {
  return tools.map((t) => {
    const paramObj: Record<string, string> = {};
    if (t.params?.length) {
      for (const p of t.params) paramObj[p.name] = p.description;
    }
    return JSON.stringify({
      tool: t.name,
      description: t.description,
      ...(t.params?.length ? { args: paramObj } : {}),
    });
  }).join("\n");
}

export function buildToolSelectSystem(): string {
  return `You are a tool router for a presentation app. Given the user's message, pick the ONE best tool and extract any required arguments.

Tool definitions:
${buildToolDefsBlock()}

Routing rules (override description if there is ambiguity):
- "what themes does this doc/presentation use?" or "what fonts/colors are applied?" → doccontext (what's CURRENTLY in the document).
- "what other themes are available?" or "what options/choices do I have?" or "list themes" or "show me themes" → browse_themes (the full CATALOGUE of themes to switch to).
- Any question about a SPECIFIC slide by name/number/ordinal ("first slide", "slide 3", "second slide") → slideinfo. Extract the slideIndex arg (e.g. "first", "second", "3", "slide 2").
- Any question about slide number, slide index, or which slide is open → slidecontext.
- "change/switch/apply theme to X" → change_theme.

Reply with a single JSON object: {"tool":"<name>","args":{<extracted values or empty>}}
Output ONLY the JSON object. Nothing else.`;
}

function resolveToolName(raw: string): Tool | null {
  const cleaned = raw.toLowerCase().replace(/[^a-z_]/g, "");
  if (!cleaned) return null;
  return tools.find((t) => {
    const name = t.name.toLowerCase().replace(/[^a-z_]/g, "");
    return cleaned === name || (cleaned.length >= 4 && (name.startsWith(cleaned) || cleaned.startsWith(name)));
  }) ?? null;
}

export async function selectTool(
  userText: string,
  runInference: (system: string, user: string, mode: EffortMode) => Promise<string>,
  mode: EffortMode,
): Promise<ToolSelection> {
  dlog.log("SP", `[selectTool] userText="${userText}"`);
  const defaultTool = getDefaultTool();
  try {
    const response = await runInference(
      buildToolSelectSystem(),
      `User says: "${userText}"`,
      mode,
    );
    dlog.log("SP", `[selectTool] response: "${response}"`);

    const parsed = extractJsonObject(response);
    if (parsed && typeof parsed.tool === "string") {
      const tool = resolveToolName(parsed.tool as string);
      const args: Record<string, string> = {};
      if (parsed.args && typeof parsed.args === "object") {
        for (const [k, v] of Object.entries(parsed.args as Record<string, unknown>)) {
          if (typeof v === "string") args[k] = v;
        }
      }
      const resolved = tool ?? defaultTool;
      dlog.log("SP", `[selectTool] → tool="${resolved.name}" args=${JSON.stringify(args)}`);
      return { tool: resolved, args };
    }

    const tool = resolveToolName(response);
    return { tool: tool ?? defaultTool, args: {} };
  } catch (err) {
    dlog.error("SP", "[selectTool] error", err);
  }
  return { tool: defaultTool, args: {} };
}
