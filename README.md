# Qwen Chat — Zoho Show AI Assistant

A Chrome extension that runs **Qwen3.5-4B** (vision + text) locally in the browser via [wllama](https://github.com/nicehash/wllama) (llama.cpp compiled to WebAssembly with WebGPU offload). No API keys, no server — everything runs on-device.

## Features

- **Local inference** — the model runs entirely in your browser (offscreen document + WebGPU)
- **Slide analysis** — captures the current Zoho Show slide and answers questions about it
- **Three effort modes** — Flash (fast), Focus (balanced), Forge (deep reasoning with verify loop)
- **Context management** — engine-owned sessions with rolling summarization when the context window fills up
- **Streaming chat** in a draggable floating panel with Shadow DOM isolation

## Architecture

```
content.ts        → Floating panel UI (injected into Zoho Show pages)
background.ts     → Service worker relay + slide capture via MAIN world injection
offscreen.ts      → wllama engine (model loading, inference, session management)
messages.ts       → Typed message protocol across all three contexts
models.ts         → Model configuration (repo, quant, context size)
modes.ts          → Effort mode definitions (Flash / Focus / Forge)
prompts.ts        → System prompt + summarization prompt templates
session.ts        → Per-tab session state (turns, compaction policy, token budgeting)
panel-styles.ts   → All panel CSS (design tokens, components, animations)
stripThinking.ts  → Strip <think> tags from model output
```

## Setup

```bash
npm install
npm run build
```

Load `dist/` as an unpacked extension at `chrome://extensions` (enable Developer mode).

## Development

```bash
npm run dev       # watch mode (rebuild on change)
npm run lint      # ESLint
npm run format    # Prettier
```

Reload the extension after changes. The model (~2.5 GB) downloads on first use and is cached locally.

## Model

Default: **Qwen3.5-4B** (`Q4_K_M` quantization) from `unsloth/Qwen3.5-4B-GGUF` with a separate `mmproj-F16.gguf` vision projector. Change it in `src/models.ts`.
