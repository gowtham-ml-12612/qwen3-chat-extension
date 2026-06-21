// Single multimodal model — Qwen3.5-4B (text + vision) run via wllama
// (llama.cpp compiled to WebAssembly, with WebGPU offload). This one model
// replaces the previous two-model WebLLM setup (Qwen2.5-3B for text +
// Phi-3.5-vision for slides), so there is no model swapping and no quadrant
// pipeline: the model both chats and reads slides natively.
//
// The GGUF + vision projector (mmproj) come from the unsloth repo. Qwen3.5
// needs the separate mmproj file and only runs on llama.cpp-compatible
// backends — which is exactly wllama.

export interface ModelConfig {
  /** Hugging Face GGUF repo. */
  repo: string;
  /** Main-model quantization tag; matches exactly one file in the repo. */
  quant: string;
  /** Vision projector (mmproj) file enabling image input. */
  mmprojFile: string;
  /** Friendly label shown in the panel. */
  label: string;
  /**
   * Default context window in tokens — kept modest to bound memory. This is the
   * size used on first load; the user can pick a larger one from the panel (see
   * CONTEXT_SIZES), which triggers a full model reload because the KV-cache is
   * allocated once at load time and can't be resized live.
   */
  nCtx: number;
  /**
   * Load-time ceiling on tokens spent encoding one image. This is a cap, not a
   * floor: lower-effort modes simply send smaller images and use fewer tokens.
   * Kept at a memory-safe value — pushing this (and the per-mode image size)
   * too high makes the wasm vision encoder abort (OOM) on large slides.
   */
  imageMaxTokens: number;
}

export const MODEL: ModelConfig = {
  repo: "unsloth/Qwen3.5-4B-GGUF",
  quant: "Q4_K_M",
  mmprojFile: "mmproj-F16.gguf",
  label: "Qwen3.5 · 4B",
  nCtx: 8192,
  imageMaxTokens: 1280,
};

export const MODEL_LABEL = MODEL.label;

// ── Context-window sizes the user can switch between ──────────────────────────
//
// Switching context size is NOT a live toggle: wllama allocates the KV-cache
// once, when the model loads, and exposes no way to resize it on a running
// model. So picking a different size here tears down and reloads the model.
//
// Each step up multiplies cost on two axes:
//   • KV-cache RAM grows linearly  (2× size → ~2× memory held for the session)
//   • attention compute grows quadratically (2× size → ~4× work per token)
// In the WASM offscreen sandbox (a hard ~2–4 GB ceiling) the larger sizes can
// fail to allocate — which is why the engine falls back to a smaller size on
// an out-of-memory load rather than leaving the panel broken.

export interface ContextSizeOption {
  /** Context window in tokens; passed to wllama as n_ctx. */
  tokens: number;
  /** Short label shown in the dropdown. */
  label: string;
  /** Tooltip describing the trade-off / risk. */
  hint: string;
}

// Ordered small → large. The first entry must equal MODEL.nCtx (the default),
// and acts as the safe fallback target for the one above it on OOM.
export const CONTEXT_SIZES: ContextSizeOption[] = [
  {
    tokens: 8192,
    label: "8K · Standard",
    hint: "Safe default — lowest memory, most responsive",
  },
  {
    tokens: 16384,
    label: "16K · Extended",
    hint: "~2× memory, ~4× attention cost — longer memory, still fits most devices",
  },
  {
    tokens: 32768,
    label: "32K · Deep",
    hint: "~4× memory — may fail to load on low-RAM devices (falls back automatically)",
  },
  {
    tokens: 65536,
    label: "64K · Maximum",
    hint: "~8× memory — requires 8GB+ RAM, falls back automatically on failure",
  },
];

export const DEFAULT_CONTEXT_TOKENS = MODEL.nCtx;

// Invariant: the first (smallest) entry must equal the model's default context
// size, since it's the ultimate OOM fallback target. Catch misconfigurations at
// load time rather than silently misbehaving at runtime.
if (CONTEXT_SIZES[0].tokens !== MODEL.nCtx) {
  throw new Error(
    `CONTEXT_SIZES[0].tokens (${CONTEXT_SIZES[0].tokens}) must equal MODEL.nCtx (${MODEL.nCtx})`,
  );
}

/** Valid token values, for storage validation. */
const CONTEXT_TOKEN_SET = new Set(CONTEXT_SIZES.map((c) => c.tokens));

export function isContextTokens(value: unknown): value is number {
  return typeof value === "number" && CONTEXT_TOKEN_SET.has(value);
}

/**
 * The next smaller context size to fall back to after an out-of-memory load,
 * or undefined when already at the smallest. Used by the engine to recover
 * gracefully instead of leaving the model unloaded.
 */
export function fallbackContextTokens(tokens: number): number | undefined {
  const idx = CONTEXT_SIZES.findIndex((c) => c.tokens === tokens);
  if (idx <= 0) return undefined;
  return CONTEXT_SIZES[idx - 1].tokens;
}
