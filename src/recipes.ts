// Recipe-driven task execution for Zoho Show.
//
// Instead of having the small local model autonomously decide what buttons to
// click (which leads to hallucination and confusion), we define hard-coded
// step-by-step procedures for common tasks. The model's only job is to classify
// the user's intent and extract parameters — it never decides which element to
// interact with.
//
// Each step targets elements by **label matching** (substring or regex) against
// the already-collected element list from the content script. No screenshot or
// model vision is needed during execution — just cheap text matching.

// ── Step types ────────────────────────────────────────────────────────────────

export type RecipeStep =
  | { type: "click"; match: string | RegExp; desc: string }
  | { type: "clickSelector"; selector: string; desc: string }
  | { type: "type"; match: string | RegExp; text: string; submit?: boolean; desc: string }
  | { type: "typeParam"; match: string | RegExp; param: string; submit?: boolean; desc: string }
  | { type: "key"; key: string; desc: string }
  | { type: "wait"; ms: number; desc: string }
  | { type: "waitForTab"; desc: string }
  | { type: "createPresentation"; desc: string }
  | { type: "changeTheme"; desc: string };

// ── Recipe definition ─────────────────────────────────────────────────────────

export interface Recipe {
  id: string;
  /** Human-readable name shown in the UI while running. */
  label: string;
  /** Regex that matches user messages triggering this recipe. */
  trigger: RegExp;
  /** Named parameters extracted from the user message via capture groups. */
  paramNames?: string[];
  /** The hard-coded steps to execute in order. */
  steps: RecipeStep[];
  /** Message shown to user on successful completion. */
  doneMessage: string;
}

// ── Recipes ───────────────────────────────────────────────────────────────────

export const RECIPES: Recipe[] = [
  {
    id: "create-presentation",
    label: "Creating a new presentation",
    trigger: /\b(create|make|start|new|build|design)\b.*\b(presenta?\w+|ppt|deck|slide ?show|slides)\b/i,
    steps: [
      { type: "createPresentation", desc: "Creating your presentation" },
    ],
    doneMessage: "Done! Your new presentation is loading in the editor.",
  },
  {
    id: "change-theme",
    label: "Changing the presentation theme",
    trigger: /\b(change|switch|apply|set|use)\b.*\b(theme|template|look|style)\b/i,
    steps: [
      { type: "changeTheme", desc: "Changing the theme" },
    ],
    doneMessage: "Done! The theme has been applied.",
  },
];

