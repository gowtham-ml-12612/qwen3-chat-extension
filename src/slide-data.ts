// Utilities for parsing slide data from $.SlideHandler.getSelectedSlideData().
// Only extracts metadata the AI can act on — shapes and render geometry are excluded.

// ── Types ────────────────────────────────────────────────────────────────────

export interface ThemeColor {
  role: string;
  hex: string;
}

export interface SlideThemeInfo {
  name: string;
  themeId: string;
  fonts: string[];
  colors: ThemeColor[];
}

export interface SlideMetadata {
  slideId: string;
  slideName: string;
  slideIndex: number;
  slideType: string;
  docType: string;
  theme: SlideThemeInfo | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function rgbToHex(rgb: unknown): string | null {
  if (!Array.isArray(rgb) || rgb.length < 3) return null;
  return "#" + rgb.slice(0, 3).map((v: unknown) =>
    typeof v === "number" ? Math.round(v).toString(16).padStart(2, "0") : "00"
  ).join("");
}

// ── Extractors ────────────────────────────────────────────────────────────────

/**
 * Parse themeInfo from the slide data.
 * Path: data.themeInfo.theme OR data.mainMaster.themeInfo.theme
 */
export function getThemeFromSlideData(data: Record<string, unknown>): SlideThemeInfo | null {
  const findThemeObj = (root: unknown): Record<string, unknown> | null => {
    if (!root || typeof root !== "object") return null;
    const info = root as Record<string, unknown>;
    const theme = info.theme;
    if (!theme || typeof theme !== "object") return null;
    return theme as Record<string, unknown>;
  };

  const themeObj =
    findThemeObj(data.themeInfo) ??
    findThemeObj((data.mainMaster as Record<string, unknown>)?.themeInfo) ??
    null;

  if (!themeObj) return null;

  const name = typeof themeObj.name === "string" ? themeObj.name : "";
  const themeId = typeof themeObj.themeId === "string" ? themeObj.themeId : "";

  // Fonts: try Zoho Show's PPTX-style majorFont/minorFont paths first,
  // then fall back to the flat latin[] array format as a safety net.
  const fonts: string[] = [];
  const fs = themeObj.fontScheme as Record<string, unknown> | undefined;
  if (fs) {
    const majorLatin = (fs.majorFont as Record<string, unknown> | undefined)?.latin as Record<string, unknown> | undefined;
    const minorLatin = (fs.minorFont as Record<string, unknown> | undefined)?.latin as Record<string, unknown> | undefined;
    if (typeof majorLatin?.typeface === "string" && majorLatin.typeface) fonts.push(majorLatin.typeface);
    if (typeof minorLatin?.typeface === "string" && minorLatin.typeface && minorLatin.typeface !== majorLatin?.typeface) {
      fonts.push(minorLatin.typeface);
    }

    // Flat array fallback: { fontFamily: { name } }[]
    if (fonts.length === 0 && Array.isArray(fs.latin)) {
      for (const entry of fs.latin as unknown[]) {
        const e = entry as Record<string, unknown>;
        const ff = e?.fontFamily as Record<string, unknown> | undefined;
        if (typeof ff?.name === "string") fonts.push(ff.name);
      }
    }

    if (fonts.length === 0) {
      console.log("[slide-data] fontScheme found but no fonts extracted — raw:", JSON.stringify(fs).slice(0, 300));
    }
  }

  // Colors from colorScheme.colorStyle
  const colors: ThemeColor[] = [];
  const cs = themeObj.colorScheme as Record<string, unknown> | undefined;
  if (cs) {
    const style = cs.colorStyle as Record<string, unknown> | undefined;
    if (style) {
      // Match Zoho Show's Color Scheme panel: omit dark1/light1 (text/background
      // base colors — always black/white) and show the same 8 palette colors.
      const roles = [
        "dark2", "light2",
        "accent1", "accent2", "accent3", "accent4", "accent5", "accent6",
      ];
      for (const role of roles) {
        const hex = rgbToHex(style[role]);
        if (hex) colors.push({ role, hex });
      }
    }
  }

  return { name, themeId, fonts, colors };
}

/** Extract core slide metadata (no shape content). */
export function getSlideMetadata(data: Record<string, unknown>): SlideMetadata {
  const slide = data.slide as Record<string, unknown> | undefined;
  const slideData = slide?.data as Record<string, unknown> | undefined;

  return {
    slideId: (typeof data.slideId === "string" ? data.slideId
      : typeof slideData?.id === "string" ? slideData.id : ""),
    slideName: typeof slideData?.name === "string" ? slideData.name : "",
    slideIndex: typeof data.slideIndex === "number" ? data.slideIndex : -1,
    slideType: typeof data.slideType === "string" ? data.slideType : "",
    docType: typeof data.docType === "string" ? data.docType : "",
    theme: getThemeFromSlideData(data),
  };
}

// ── Document-level types ──────────────────────────────────────────────────────

export interface MasterInfo {
  name: string;
  themeId: string;
  fonts: string[];
  colors: ThemeColor[];
}

// ── AI context string ─────────────────────────────────────────────────────────

/**
 * Build a structured, readable summary for AI context injection.
 *
 * Output format:
 *   Slide: slide1 (index 0)
 *   Theme: Geometric
 *   Fonts: Dosis, Metrophobic
 *   Colors: dark1=#2e172f, accent1=#4a51bd, accent2=#c220c5, ...
 */
/**
 * @param includeColors - include raw hex palette in the text (false when colours
 *   are already shown as UI swatches and the model should not echo them)
 */
export function summarizeSlideForAI(
  data: Record<string, unknown>,
  { includeColors = false }: { includeColors?: boolean } = {},
): string {
  const meta = getSlideMetadata(data);
  const lines: string[] = [];

  if (meta.slideIndex >= 0) {
    lines.push(`Slide: ${meta.slideName || "untitled"} (index ${meta.slideIndex})`);
  }

  if (meta.theme) {
    const t = meta.theme;
    lines.push(`Theme: ${t.name}`);
    if (t.fonts.length) lines.push(`Fonts: ${t.fonts.join(", ")}`);
    if (includeColors && t.colors.length) {
      lines.push(`Colors: ${t.colors.map((c) => `${c.role}=${c.hex}`).join(", ")}`);
    }
  }

  return lines.length > 0 ? lines.join("\n") : "No slide metadata available";
}

/**
 * Parse each entry in $.docData.masters into a flat MasterInfo summary.
 * Reuses getThemeFromSlideData since every master carries themeInfo at its root.
 */
export function getMastersInfo(masters: unknown[]): MasterInfo[] {
  if (!Array.isArray(masters)) return [];
  return masters.map((m) => {
    const theme = getThemeFromSlideData(m as Record<string, unknown>);
    return {
      name: theme?.name ?? "(unnamed)",
      themeId: theme?.themeId ?? "",
      fonts: theme?.fonts ?? [],
      colors: theme?.colors ?? [],
    };
  });
}

/**
 * Build a compact AI context string for the full document master set.
 *
 * @param includeColors - include raw hex palette in the text (false when colours
 *   are already shown as UI swatches and the model should not echo them)
 *
 * Output format (includeColors=false):
 *   Document masters (2):
 *   1. Geometric | Fonts: Dosis, Metrophobic
 *   2. B&D-Powerpoint Template_16x9 | Fonts: Montserrat-Bold, Open Sans
 */
export function summarizeDocForAI(
  masters: unknown[],
  { includeColors = false }: { includeColors?: boolean } = {},
): string {
  const parsed = getMastersInfo(masters);
  if (parsed.length === 0) return "No masters available";

  const lines: string[] = [`Document masters (${parsed.length}):`];
  parsed.forEach((m, i) => {
    const parts: string[] = [`${i + 1}. ${m.name || "(unnamed)"}`];
    if (m.fonts.length) parts.push(`Fonts: ${m.fonts.join(", ")}`);
    if (includeColors && m.colors.length) {
      parts.push(`Colors: ${m.colors.map((c) => `${c.role}=${c.hex}`).join(", ")}`);
    }
    lines.push(parts.join(" | "));
  });
  return lines.join("\n");
}
