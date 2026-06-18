export function stripThinking(text: string): string {
  const REDACTED_OPEN = "\u003credacted_thinking\u003e";
  const REDACTED_CLOSE = "\u003c/redacted_thinking\u003e";
  const THINK_OPEN = "\u003cthink\u003e";
  const THINK_CLOSE = "\u003c/think\u003e";

  for (const marker of [REDACTED_CLOSE, THINK_CLOSE]) {
    const idx = text.lastIndexOf(marker);
    if (idx !== -1) {
      return text.slice(idx + marker.length).trim();
    }
  }

  if (text.includes(REDACTED_OPEN) || text.includes(THINK_OPEN)) {
    return "";
  }

  return text.trim();
}
