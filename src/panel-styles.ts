// All panel CSS lives here, exported as a single string injected into the
// Shadow DOM. Keeping it separate from content.ts means style changes don't
// touch UI logic and the main file stays under 600 lines.

export const PANEL_CSS = /* css */ `
  :host {
    --bg-0:#0a0d11; --bg-1:#0f1117; --bg-2:#161a22; --bg-3:#1e2430; --bg-4:#262d3a;
    --text-1:#eceef1; --text-2:#9aa0a6; --text-3:#5f6672;
    --border:rgba(255,255,255,0.07); --border-s:rgba(255,255,255,0.12);
    --accent:#7c9cff; --accent-h:#6b8aee; --accent-d:rgba(124,156,255,0.12);
    --forge:#f0a050; --forge-d:rgba(240,160,80,0.12);
    --red:#f87171; --red-d:rgba(248,113,113,0.12);
    --green:#4ade80; --green-d:rgba(74,222,128,0.12);
    --ctx-yellow:#facc15; --ctx-orange:#fb923c;
    --r-sm:8px; --r-md:12px; --r-lg:16px;
    --font:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    --ease:cubic-bezier(.4,0,.2,1);
  }

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  .panel {
    width: 100%; height: 100%;
    display: flex; flex-direction: column;
    background: var(--bg-1);
    color: var(--text-1);
    font-family: var(--font);
    font-size: 13.5px; line-height: 1.5;
    border-radius: var(--r-lg);
    overflow: hidden;
    box-shadow:
      0 0 0 1px var(--border-s),
      0 8px 30px rgba(0,0,0,0.45),
      0 30px 60px rgba(0,0,0,0.25);
  }

  header {
    padding: 12px 14px 10px;
    background: var(--bg-2);
    border-bottom: 1px solid var(--border);
    cursor: grab;
    user-select: none;
    flex-shrink: 0;
  }
  header:active { cursor: grabbing; }

  .header-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 6px;
  }

  h1 {
    font-size: 14px;
    font-weight: 700;
    color: var(--text-1);
    letter-spacing: -0.01em;
    line-height: 1;
  }

  .hbtns { display: flex; gap: 4px; }

  .ibtn {
    border: 1px solid var(--border-s);
    border-radius: 6px;
    background: var(--bg-3);
    color: var(--text-2);
    width: 28px; height: 28px;
    cursor: pointer;
    font-size: 13px;
    display: flex; align-items: center; justify-content: center;
    font-family: var(--font);
    padding: 0; line-height: 1;
    transition: all 150ms var(--ease);
  }
  .ibtn:hover:not(:disabled) { background: var(--bg-4); color: var(--text-1); }
  .ibtn:active:not(:disabled) { transform: scale(0.92); }
  .ibtn:disabled { opacity: 0.4; cursor: not-allowed; }

  #copy-btn.copied {
    border-color: var(--green-d);
    background: var(--green-d);
    color: var(--green);
  }

  .modes {
    display: flex; gap: 2px;
    padding: 3px; margin: 4px 0 8px;
    background: var(--bg-0);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
  }
  .mode {
    flex: 1; border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--text-3);
    font: 600 11px/1 var(--font);
    padding: 7px 0;
    cursor: pointer;
    transition: all 180ms var(--ease);
  }
  .mode:hover:not(.active):not(:disabled) { color: var(--text-1); background: rgba(255,255,255,0.04); }
  .mode:disabled { cursor: not-allowed; }
  .mode.active { background: var(--accent); color: var(--bg-1); box-shadow: 0 1px 4px rgba(124,156,255,0.25); }
  .mode[data-mode="forge"].active { background: var(--forge); box-shadow: 0 1px 4px rgba(240,160,80,0.25); }

  /* ── Context-window picker ──────────────────────────────────────────────── */
  .ctx-row {
    display: flex; align-items: center; gap: 8px;
    margin: 0 0 8px;
  }
  .ctx-label {
    font: 600 10px/1 var(--font);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--text-3);
    flex-shrink: 0;
    cursor: default;
  }
  .ctx-select {
    flex: 1;
    appearance: none;
    -webkit-appearance: none;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-0);
    color: var(--text-2);
    font: 600 11px/1 var(--font);
    padding: 7px 26px 7px 10px;
    cursor: pointer;
    transition: all 150ms var(--ease);
    /* caret */
    background-image:
      linear-gradient(45deg, transparent 50%, var(--text-3) 50%),
      linear-gradient(135deg, var(--text-3) 50%, transparent 50%);
    background-position:
      calc(100% - 14px) calc(50% - 1px),
      calc(100% - 9px) calc(50% - 1px);
    background-size: 5px 5px, 5px 5px;
    background-repeat: no-repeat;
  }
  .ctx-select:hover:not(:disabled) { color: var(--text-1); border-color: var(--border-s); background-color: var(--bg-1); }
  .ctx-select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-d); }
  .ctx-select:disabled { opacity: 0.45; cursor: not-allowed; }
  .ctx-select option { background: var(--bg-2); color: var(--text-1); }

  #close-btn { color: var(--red); }
  #close-btn:hover { background: var(--red-d); }

  /* ── Status row + context ring ────────────────────────────────────────── */
  .status-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  #status { font-size: 11px; color: var(--text-2); line-height: 1.3; flex: 1; }

  .ctx-ring-wrap {
    position: relative;
    width: 28px; height: 28px;
    flex-shrink: 0;
    opacity: 0;
    transform: scale(0.8);
    transition: opacity 300ms var(--ease), transform 300ms var(--ease);
    pointer-events: none;
  }
  .ctx-ring-wrap.visible {
    opacity: 1;
    transform: scale(1);
    pointer-events: auto;
    cursor: default;
  }

  .ctx-ring {
    width: 100%; height: 100%;
    transform: rotate(-90deg);
  }
  .ctx-ring-bg {
    fill: none;
    stroke: var(--bg-0);
    stroke-width: 3;
  }
  .ctx-ring-fg {
    fill: none;
    stroke: var(--green);
    stroke-width: 3;
    stroke-linecap: round;
    transition: stroke-dashoffset 600ms var(--ease), stroke 400ms var(--ease);
  }

  .ctx-ring-pct {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font: 700 8px/1 var(--font);
    color: var(--text-2);
    pointer-events: none;
  }

  /* Pulse animation while summarising */
  .ctx-ring-wrap.compacting .ctx-ring-fg {
    animation: ctx-pulse 1.2s ease-in-out infinite;
  }
  @keyframes ctx-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
  }

  /* Brief green flash after successful compaction */
  .ctx-ring-wrap.compacted .ctx-ring-fg {
    stroke: var(--green) !important;
    filter: drop-shadow(0 0 4px var(--green));
    transition: filter 300ms var(--ease);
  }

  progress {
    display: block; width: 100%;
    height: 3px; margin-top: 6px;
    accent-color: var(--accent);
    border: none; border-radius: 2px;
    overflow: hidden;
  }
  progress[hidden] { display: none; }
  progress::-webkit-progress-bar { background: var(--bg-0); border-radius: 2px; }
  progress::-webkit-progress-value { background: var(--accent); border-radius: 2px; transition: width 200ms var(--ease); }

  main {
    flex: 1; overflow-y: auto;
    padding: 14px;
    display: flex; flex-direction: column;
    gap: 8px;
    scroll-behavior: smooth;
  }
  main::-webkit-scrollbar { width: 5px; }
  main::-webkit-scrollbar-track { background: transparent; }
  main::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 3px; }
  main::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.16); }

  .msg {
    max-width: 85%;
    padding: 10px 14px;
    border-radius: var(--r-md);
    font-size: 13px; line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
    position: relative;
    animation: msg-in 250ms var(--ease);
  }
  .msg.user {
    align-self: flex-end;
    background: var(--accent);
    color: var(--bg-1);
    border-bottom-right-radius: 4px;
    font-weight: 450;
  }
  .msg.assistant {
    align-self: flex-start;
    background: var(--bg-3);
    border: 1px solid var(--border);
    border-bottom-left-radius: 4px;
  }
  .msg.typing { color: var(--text-2); }
  .msg.typing::after {
    content: '▎';
    display: inline;
    margin-left: 1px;
    color: var(--accent);
    animation: blink 800ms steps(2) infinite;
  }

  .msg.vision { border-color: var(--accent-d); }
  .msg.vision::before {
    content: "⊡ slide analysis";
    display: block;
    font-size: 10px; font-weight: 700;
    color: var(--accent);
    margin-bottom: 6px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .msg-actions {
    position: absolute; top: 6px; right: 6px;
    opacity: 0; pointer-events: none;
    transition: opacity 150ms var(--ease);
  }
  .msg:hover .msg-actions { opacity: 1; pointer-events: auto; }
  .msg-copy {
    width: 24px; height: 24px;
    border: 1px solid var(--border-s);
    border-radius: 5px;
    background: var(--bg-2);
    color: var(--text-3);
    cursor: pointer; font-size: 11px;
    display: flex; align-items: center; justify-content: center;
    transition: all 120ms var(--ease);
    padding: 0; font-family: var(--font);
  }
  .msg-copy:hover { background: var(--bg-4); color: var(--text-1); }

  #welcome {
    flex: 1; display: flex;
    flex-direction: column;
    align-items: center; justify-content: center;
    gap: 8px; text-align: center;
    padding: 40px 24px;
    animation: fade-in 400ms var(--ease);
  }
  #welcome[hidden] { display: none; }
  .welcome-icon { font-size: 32px; opacity: 0.5; color: var(--accent); }
  #welcome h2 { font-size: 15px; font-weight: 600; color: var(--text-2); }
  #welcome p { font-size: 12px; line-height: 1.6; color: var(--text-3); max-width: 250px; }

  footer {
    display: flex; gap: 8px;
    padding: 12px 14px;
    border-top: 1px solid var(--border);
    background: var(--bg-2);
    flex-shrink: 0;
  }

  textarea {
    flex: 1; resize: none;
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    padding: 9px 12px;
    background: var(--bg-1);
    color: var(--text-1);
    font: 13px/1.45 var(--font);
    transition: border-color 150ms var(--ease), box-shadow 150ms var(--ease);
  }
  textarea:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-d); }
  textarea:disabled { opacity: 0.5; cursor: not-allowed; }
  textarea::placeholder { color: var(--text-3); }

  #send-btn {
    border: none;
    border-radius: var(--r-sm);
    padding: 0 18px;
    background: var(--accent);
    color: var(--bg-1);
    font: 600 13px/1 var(--font);
    cursor: pointer; white-space: nowrap;
    transition: all 150ms var(--ease);
  }
  #send-btn:hover:not(:disabled) { background: var(--accent-h); }
  #send-btn:active:not(:disabled) { transform: scale(0.97); }
  #send-btn:disabled { opacity: 0.45; cursor: not-allowed; }

  #stop-btn {
    border: none;
    border-radius: var(--r-sm);
    padding: 0 18px;
    background: var(--red);
    color: #fff;
    font: 600 13px/1 var(--font);
    cursor: pointer; white-space: nowrap;
    transition: all 150ms var(--ease);
  }
  #stop-btn:hover:not(:disabled) { background: #ef4444; }
  #stop-btn:active:not(:disabled) { transform: scale(0.97); }
  #stop-btn:disabled { opacity: 0.5; cursor: progress; }

  #send-btn[hidden], #stop-btn[hidden] { display: none; }

  @keyframes msg-in {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0; }
  }
  @keyframes fade-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  /* ── Resize handles ─────────────────────────────────────────────────────── */
  .panel { position: relative; }

  .rh {
    position: absolute;
    z-index: 10;
  }

  .rh-n, .rh-s { left: 0; right: 0; height: 6px; cursor: ns-resize; }
  .rh-e, .rh-w { top: 0; bottom: 0; width: 6px; cursor: ew-resize; }
  .rh-n  { top: 0; }
  .rh-s  { bottom: 0; }
  .rh-e  { right: 0; }
  .rh-w  { left: 0; }

  .rh-ne, .rh-nw, .rh-se, .rh-sw { width: 12px; height: 12px; }
  .rh-ne { top: 0; right: 0; cursor: nesw-resize; }
  .rh-nw { top: 0; left: 0; cursor: nwse-resize; }
  .rh-se { bottom: 0; right: 0; cursor: nwse-resize; }
  .rh-sw { bottom: 0; left: 0; cursor: nesw-resize; }
`;
