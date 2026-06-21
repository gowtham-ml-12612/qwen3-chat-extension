// Browser-agent action protocol — the shared contract between the model's
// output, the orchestrator (side panel), and the executor (content script).
//
// The model never gets raw pixel coordinates. Instead the page is reduced to a
// numbered list of interactive elements (Set-of-Marks style); the model picks an
// element by `index`, which the content script resolves back to a live DOM node.
// This is dramatically more reliable for a small local model than asking it to
// guess (x, y) from a screenshot.

// ── Interactive element descriptor ────────────────────────────────────────────
//
// One entry per actionable DOM node the content script finds. `index` is the
// stable handle the model references; everything else is context for the model
// to choose well. The live DOM node + its rect are kept only in the content
// script (keyed by index within a snapshot) and never serialized to the model.

export interface PageElement {
  /** Stable handle within a snapshot; what the model references. */
  index: number;
  /** Lowercased tag name (button, a, input, …). */
  tag: string;
  /** ARIA role or input type, when meaningful. */
  role?: string;
  /** Visible text / aria-label / placeholder / title, trimmed + capped. */
  label: string;
  /** True when the element is an editable field (input/textarea/contenteditable). */
  editable?: boolean;
}

/** A page observation: what the model sees before deciding the next action. */
export interface PageObservation {
  /** Indexed interactive elements, top frame, in DOM order. */
  elements: PageElement[];
  /** Current document URL. */
  url: string;
  /** Document title. */
  title: string;
  /** Monotonic id of this snapshot; passed back on execute to detect staleness. */
  snapshotId: number;
}

// ── Actions the model may emit ────────────────────────────────────────────────

export type AgentAction =
  | { type: "click"; index: number }
  | { type: "type"; index: number; text: string; submit?: boolean }
  | { type: "key"; key: string }
  | { type: "scroll"; direction: "up" | "down" }
  | { type: "navigate"; url: string }
  | { type: "respond"; text: string };

/** Actions that change page state — gated behind confirmation in "ask" mode. */
const MUTATING_ACTIONS = new Set<AgentAction["type"]>([
  "click",
  "type",
  "key",
  "navigate",
]);

export function isMutating(action: AgentAction): boolean {
  return MUTATING_ACTIONS.has(action.type);
}

/** Result of executing one action, reported back to the orchestrator. */
export interface ActionResult {
  ok: boolean;
  /** Short human-readable note ("Clicked \"File\"", "Element 4 not found"). */
  detail: string;
  /** True when the page navigated / mutated enough that a fresh observe is wise. */
  changed?: boolean;
}

// ── Output parsing ────────────────────────────────────────────────────────────
//
// The model is asked to emit a single JSON object: { thought, action: {…} }.
// Small models are sloppy — they wrap it in prose, fence it, or add trailing
// commentary. We extract the first balanced {...} that parses as JSON, then
// validate it into a typed action. On any failure we fall back to treating the
// whole text as a plain `respond`, so the loop degrades to a chat answer rather
// than crashing.

export interface ParsedStep {
  thought: string;
  action: AgentAction;
}

export function parseAgentStep(raw: string): ParsedStep {
  const obj = extractJsonObject(raw);
  if (obj) {
    const action = coerceAction(obj.action ?? obj);
    if (action) {
      const thought = typeof obj.thought === "string" ? obj.thought.trim() : "";
      return { thought, action };
    }
  }
  // No usable action — treat the model's text as a direct answer.
  return { thought: "", action: { type: "respond", text: stripFences(raw).trim() || "(no answer)" } };
}

/** Find and parse the first balanced JSON object in the text. */
export function extractJsonObject(raw: string): Record<string, unknown> | undefined {
  const text = stripFences(raw);
  const start = text.indexOf("{");
  if (start === -1) return undefined;

  // Walk forward tracking brace depth, skipping over string literals, to find
  // the matching close brace of the first object.
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const slice = text.slice(start, i + 1);
        try {
          const parsed = JSON.parse(slice);
          return typeof parsed === "object" && parsed !== null
            ? (parsed as Record<string, unknown>)
            : undefined;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/** Strip ```json fences and surrounding whitespace. */
function stripFences(raw: string): string {
  return raw.replace(/```(?:json)?/gi, "").trim();
}

/** Validate a loosely-typed object into a known AgentAction, or undefined. */
function coerceAction(value: unknown): AgentAction | undefined {
  if (!value || typeof value !== "object") return undefined;
  const a = value as Record<string, unknown>;
  const type = typeof a.type === "string" ? a.type.toLowerCase() : "";

  switch (type) {
    case "click": {
      const index = toIndex(a.index);
      return index === undefined ? undefined : { type: "click", index };
    }
    case "type": {
      const index = toIndex(a.index);
      const text = typeof a.text === "string" ? a.text : undefined;
      if (index === undefined || text === undefined) return undefined;
      return { type: "type", index, text, submit: a.submit === true };
    }
    case "key": {
      const key = typeof a.key === "string" ? a.key : undefined;
      return key ? { type: "key", key } : undefined;
    }
    case "scroll": {
      const dir = a.direction === "up" ? "up" : "down";
      return { type: "scroll", direction: dir };
    }
    case "navigate": {
      const url = typeof a.url === "string" ? a.url : undefined;
      return url ? { type: "navigate", url } : undefined;
    }
    case "respond":
    case "answer":
    case "done": {
      const text = typeof a.text === "string" ? a.text : typeof a.answer === "string" ? a.answer : "";
      return { type: "respond", text };
    }
    default:
      return undefined;
  }
}

function toIndex(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

// ── Limits ────────────────────────────────────────────────────────────────────

/** Hard ceiling on loop iterations, regardless of mode, as a runaway guard. */
export const MAX_AGENT_STEPS = 15;

/** Longest element label we keep — enough to identify, short enough to be cheap. */
export const MAX_LABEL_LEN = 80;

/** Cap on elements sent to the model per observation, to bound prompt size. */
export const MAX_ELEMENTS = 60;
