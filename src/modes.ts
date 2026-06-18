// Effort modes — one agent, three deliberation budgets ("thinking levels").
//
// All three modes use the SAME agent and (eventually) the same action tools.
// The mode only changes how hard the model works: whether it reasons before
// answering, how many verify→correct rounds it may run, how much image detail
// it gets, and how long its replies can be. The biggest latency lever is
// `maxIterations` — the verify loop — which is where Forge spends its time.
//
// Today there are no action tools and no acceptance criteria yet, so the
// offscreen verifier always accepts and every mode runs a single pass. The
// visible differences right now are reasoning, answer length, and image detail.
// When write-tools land, the very same dial governs how many correction rounds
// Forge runs — no restructuring required.

export type EffortMode = "flash" | "focus" | "forge";

export interface ModeConfig {
  /** Stable id; also the value persisted to storage. */
  id: EffortMode;
  /** Label shown in the segmented control. */
  label: string;
  /** Tooltip describing the trade-off. */
  hint: string;
  /** Reason (Qwen "thinking") before answering. Slower, more accurate. */
  thinking: boolean;
  /**
   * Max verify→correct rounds the agent may run.
   *   1 → single shot, no loop (Flash/Focus today).
   *  >1 → iterate until the verifier accepts or this budget is spent (Forge).
   */
  maxIterations: number;
  /** Longest edge (px) the captured slide is downscaled to before vision. */
  imageMaxDim: number;
  /** Upper bound on generated tokens (includes reasoning when thinking is on). */
  maxTokens: number;
}

export const MODES: Record<EffortMode, ModeConfig> = {
  flash: {
    id: "flash",
    label: "Flash",
    hint: "Fastest — replies immediately, no self-check",
    thinking: false,
    maxIterations: 1,
    imageMaxDim: 1024,
    maxTokens: 320,
  },
  focus: {
    id: "focus",
    label: "Focus",
    hint: "Balanced — one careful pass (default)",
    thinking: false,
    maxIterations: 1,
    imageMaxDim: 1600,
    maxTokens: 768,
  },
  forge: {
    id: "forge",
    label: "Forge",
    hint: "Deepest — reasons and verifies until it matches your prompt",
    thinking: true,
    maxIterations: 5,
    // Depth here comes from reasoning + the verify loop, not raw pixels: a
    // bigger image makes the wasm vision encoder OOM/abort. Kept within the
    // same memory-safe envelope as Focus (see models.ts imageMaxTokens).
    imageMaxDim: 1600,
    maxTokens: 1536,
  },
};

export const DEFAULT_MODE: EffortMode = "focus";

export const EFFORT_MODES: EffortMode[] = ["flash", "focus", "forge"];

export function isEffortMode(value: unknown): value is EffortMode {
  return value === "flash" || value === "focus" || value === "forge";
}
