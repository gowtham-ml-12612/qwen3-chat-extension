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
  /** Context window in tokens — kept modest to bound memory. */
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
