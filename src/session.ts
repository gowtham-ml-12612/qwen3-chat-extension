// Per-conversation context manager (engine-owned, one per connected tab).
//
// It holds a rolling window of recent turns plus a running summary of everything
// older, and decides WHEN the window must be compacted to stay within the
// model's context budget. This module is pure state + policy — it never calls
// the model. The offscreen engine performs the actual summarization when
// `planCompaction` reports there's something to fold.

export interface Turn {
  role: "user" | "assistant";
  text: string;
}

export interface Session {
  /** Compact summary of turns that have been folded out of the window. */
  summary: string;
  /** Recent turns kept verbatim, oldest → newest. */
  turns: Turn[];
}

// Always keep at least this many of the most recent turns verbatim.
const MIN_RECENT_TURNS = 6;

// Compaction policy. Trigger early — when the conversation passes WATERMARK of
// its token budget — so the model still has room to write a good summary, then
// compact down to TARGET so we don't summarize again on the very next turn
// (avoids thrashing the model + KV cache every message).
export const COMPACTION_WATERMARK = 0.75;
export const COMPACTION_TARGET = 0.6;

export function createSession(): Session {
  return { summary: "", turns: [] };
}

export function appendTurn(session: Session, role: Turn["role"], text: string): void {
  session.turns.push({ role, text });
}

// Rough token estimate — enough for budgeting with a safety margin. Qwen
// averages ~3.3–4 chars/token for English; we divide low to overestimate, so we
// compact a little early rather than overflow.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.3) + 4; // +4 ≈ per-message role/format overhead
}

function turnsTokens(turns: Turn[]): number {
  let total = 0;
  for (const t of turns) total += estimateTokens(t.text);
  return total;
}

export function sessionTokens(session: Session): number {
  const summary = session.summary ? estimateTokens(session.summary) : 0;
  return summary + turnsTokens(session.turns);
}

export interface CompactionPlan {
  /** Oldest turns to fold into the summary. Empty when nothing should be done. */
  fold: Turn[];
  /** Turns to keep verbatim after compaction. */
  keep: Turn[];
}

// Decide what to compact so the session fits `budget` tokens, keeping at least
// MIN_RECENT_TURNS recent turns verbatim. Returns an empty `fold` when we
// already fit or there aren't enough turns to fold.
export function planCompaction(session: Session, budget: number): CompactionPlan {
  if (sessionTokens(session) <= budget) return { fold: [], keep: session.turns };

  const turns = session.turns;
  const maxFoldable = Math.max(0, turns.length - MIN_RECENT_TURNS);
  const summaryTok = session.summary ? estimateTokens(session.summary) : 0;

  let foldCount = 0;
  while (foldCount < maxFoldable) {
    foldCount++;
    if (summaryTok + turnsTokens(turns.slice(foldCount)) <= budget) break;
  }

  return { fold: turns.slice(0, foldCount), keep: turns.slice(foldCount) };
}

export function applyCompaction(session: Session, newSummary: string, keep: Turn[]): void {
  session.summary = newSummary;
  session.turns = keep;
}

// Flatten turns into a plain transcript for the summarizer prompt.
export function renderTranscript(turns: Turn[]): string {
  return turns.map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text}`).join("\n");
}
