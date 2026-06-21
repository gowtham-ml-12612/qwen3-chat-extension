import type { Tool, ToolContext, ToolResult } from "../types";
import { zohoAPI, getShowOrigin } from "../../zoho/api";
import { THEMES, getThemeById, type PresentationType } from "../../themes";
import { dlog } from "../../debug-log";

interface ThemePick {
  id: string;
  name: string;
  description: string;
}

interface ThemeSelectionResult {
  primary: ThemePick;
  alternatives: ThemePick[];
  category: string;
}

const CATEGORY_PROMPT = (() => {
  const grouped: Record<string, string[]> = {};
  for (const theme of THEMES) {
    for (const cat of theme.suitedFor) {
      if (!grouped[cat]) grouped[cat] = [];
      if (!grouped[cat].includes(theme.name)) grouped[cat].push(theme.name);
    }
  }
  return Object.entries(grouped)
    .map(([cat, names]) => `- ${cat}: ${names.join(", ")}`)
    .join("\n");
})();

const CATEGORY_SYSTEM = `You choose the best presentation category for the user's topic. Each category has specific themes listed. Consider the AUDIENCE, TOPIC, and MOOD.

Reply with ONLY one category name. Nothing else.`;

async function pickThemesWithAI(
  userText: string,
  runInference: (system: string, user: string) => Promise<string>,
): Promise<ThemeSelectionResult> {
  const fallback = THEMES[0];

  try {
    const catResponse = await runInference(
      CATEGORY_SYSTEM,
      `User wants: "${userText}"\n\nCategories and their themes:\n${CATEGORY_PROMPT}\n\nBest category:`,
    );
    const chosenCat = catResponse.trim().toLowerCase().replace(/[^a-z-]/g, "") as PresentationType;

    let categoryThemes = THEMES.filter((t) => t.suitedFor.includes(chosenCat));
    if (categoryThemes.length === 0) categoryThemes = THEMES.slice(0, 10);

    const themeList = categoryThemes
      .map((t) => `${t.id} — ${t.name}: ${t.description}`)
      .join("\n");

    const themeResponse = await runInference(
      `You pick the 3 most relevant presentation themes for the user's request. Reply with ONLY 3 theme IDs separated by commas. Nothing else. Example: 123,456,789`,
      `User wants: "${userText}"\n\nThemes:\n${themeList}\n\nBest 3 theme IDs (comma separated):`,
    );

    const ids = themeResponse.trim().split(/[,\s]+/).map((s) => s.replace(/[^0-9]/g, "")).filter(Boolean);
    const picks: ThemePick[] = [];
    for (const id of ids) {
      const theme = getThemeById(id);
      if (theme && !picks.some((p) => p.id === theme.id)) {
        picks.push({ id: theme.id, name: theme.name, description: theme.description });
      }
      if (picks.length >= 3) break;
    }

    for (const t of categoryThemes) {
      if (picks.length >= 3) break;
      if (!picks.some((p) => p.id === t.id)) {
        picks.push({ id: t.id, name: t.name, description: t.description });
      }
    }

    const primary = picks[0] ?? { id: fallback.id, name: fallback.name, description: fallback.description };
    const verifyResponse = await runInference(
      `You verify theme choices. Is the chosen theme appropriate for the user's request? Reply ONLY "yes" or "no".`,
      `User wants: "${userText}"\nChosen theme: "${primary.name}" — ${primary.description}\n\nIs this appropriate? (yes/no):`,
    );

    const verdict = verifyResponse.trim().toLowerCase().replace(/[^a-z]/g, "");
    if (!verdict.startsWith("yes") && picks.length > 1) {
      const [rejected, second, ...rest] = picks;
      return { primary: second, alternatives: [rejected, ...rest].slice(0, 2), category: chosenCat };
    }

    return { primary, alternatives: picks.slice(1, 3), category: chosenCat };
  } catch (err) {
    dlog.error("SP", "[pickThemesWithAI] error", err);
  }

  return {
    primary: { id: fallback.id, name: fallback.name, description: fallback.description },
    alternatives: [],
    category: "general",
  };
}

export const createPresentationTool: Tool = {
  name: "create_presentation",
  description: "user wants to create / make / start / build / design a NEW presentation, deck, or slideshow",
  mutating: true,
  async run(ctx: ToolContext): Promise<ToolResult | null> {
    dlog.log("SP", `[tool:create_presentation] run`);
    const replyBody = ctx.replyEl.querySelector(".msg-body") as HTMLElement;

    ctx.setStatus("Finding the best theme…");

    const tabUrl = await zohoAPI.getActiveTabUrl();
    if (!tabUrl) {
      const msg = "Couldn't get the current tab URL.";
      replyBody.textContent = msg;
      return { assistantText: msg };
    }
    const origin = getShowOrigin(tabUrl);
    if (!origin) {
      const msg = "Not on a Zoho Show page.";
      replyBody.textContent = msg;
      return { assistantText: msg };
    }

    if (ctx.isStopped()) return null;

    // We need a reference to runInference from the tool context
    // This is passed through a module-level setter (see tool registration)
    const { primary, alternatives, category } = await pickThemesWithAI(
      ctx.userText,
      _runInference!,
    );

    if (ctx.isStopped()) return null;

    const sessionId = crypto.randomUUID().toUpperCase();
    const docName = "Untitled Presentation";
    const createUrl = `${origin}/show/new?createUsingTHEMES=true&doc_name=${encodeURIComponent(docName)}&theme_id=${primary.id}&l_id=${sessionId}`;
    const payload = { docName, themeInfo: { themeId: primary.id }, themeID: primary.id };

    const result = await zohoAPI.createPresentation({ url: createUrl, payload, sessionId });

    if (!result.ok) {
      const msg = `Couldn't create presentation: ${result.error ?? "unknown error"}`;
      replyBody.textContent = msg;
      return { assistantText: msg };
    }

    // Render theme cards
    const allThemes = [primary, ...alternatives];
    const cardsEl = document.createElement("div");
    cardsEl.className = "theme-cards";

    for (let i = 0; i < allThemes.length; i++) {
      const t = allThemes[i];
      const card = document.createElement("div");
      card.className = `theme-card${i === 0 ? " active" : ""}`;
      card.dataset.themeId = t.id;
      card.innerHTML = `
        <div class="theme-card-name">${t.name}${i === 0 ? " ✓" : ""}</div>
        <div class="theme-card-desc">${t.description}</div>
      `;
      card.addEventListener("click", () => {
        if (card.classList.contains("active")) return;
        zohoAPI.changeTheme(t.id);
        cardsEl.querySelectorAll(".theme-card").forEach((c) => {
          c.classList.remove("active");
          const nameEl = c.querySelector(".theme-card-name");
          if (nameEl) nameEl.textContent = nameEl.textContent!.replace(" ✓", "");
        });
        card.classList.add("active");
        const nameEl = card.querySelector(".theme-card-name");
        if (nameEl) nameEl.textContent = `${t.name} ✓`;
      });
      cardsEl.appendChild(card);
    }

    replyBody.textContent = "";
    replyBody.appendChild(cardsEl);

    const altNames = alternatives.map((a) => a.name).join(", ");
    const contextText = `[Action performed: Created a new presentation using the "${primary.name}" theme (category: "${category}"). Other options: ${altNames}. Click any alternative to switch themes.]`;
    const displayText = `Done! Created a new presentation with the "${primary.name}" theme.`;
    replyBody.insertBefore(document.createTextNode(displayText), cardsEl);

    return { assistantText: contextText, remember: true };
  },
};

// Module-level inference function setter (avoids circular dependency)
let _runInference: ((system: string, user: string) => Promise<string>) | undefined;

export function setInferenceFunction(fn: (system: string, user: string) => Promise<string>): void {
  _runInference = fn;
}
