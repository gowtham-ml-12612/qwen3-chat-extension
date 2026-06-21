import { DEFAULT_MODE, isEffortMode, type EffortMode } from "../modes";
import { isContextTokens } from "../models";
import type { HistoryTurn, Pending } from "./types";

const MODE_CTX_MAP: Record<EffortMode, number> = {
  flash: 8192,
  focus: 16384,
  forge: 32768,
  max: 65536,
};

const MODE_STORAGE_KEY = "showPilotMode";
const CTX_STORAGE_KEY = "showPilotCtx";
const THEME_STORAGE_KEY = "showPilotTheme";
const INTERACTION_STORAGE_KEY = "showPilotInteraction";

export type InteractionMode = "ask" | "autopilot";
export type PanelTheme = "light" | "dark";

export interface AppState {
  chatHistory: HistoryTurn[];
  busy: boolean;
  modelReady: boolean;
  loadStarted: boolean;
  generating: boolean;
  stopRequested: boolean;
  activeReqId: string | undefined;
  mode: EffortMode;
  ctxTokens: number;
  activeCtx: number;
  interactionMode: InteractionMode;
  attachedImageDataUrl: string | undefined;
  port: chrome.runtime.Port | undefined;
  pending: Map<string, Pending>;
}

export function createInitialState(): AppState {
  return {
    chatHistory: [],
    busy: false,
    modelReady: false,
    loadStarted: false,
    generating: false,
    stopRequested: false,
    activeReqId: undefined,
    mode: DEFAULT_MODE,
    ctxTokens: MODE_CTX_MAP[DEFAULT_MODE],
    activeCtx: MODE_CTX_MAP[DEFAULT_MODE],
    interactionMode: "autopilot",
    attachedImageDataUrl: undefined,
    port: undefined,
    pending: new Map(),
  };
}

export { MODE_CTX_MAP, MODE_STORAGE_KEY, CTX_STORAGE_KEY, THEME_STORAGE_KEY, INTERACTION_STORAGE_KEY };

export function loadStoredPreferences(
  callback: (prefs: { mode?: EffortMode; ctxTokens?: number; theme?: PanelTheme; interaction?: InteractionMode }) => void,
): void {
  chrome.storage?.local?.get(
    [MODE_STORAGE_KEY, CTX_STORAGE_KEY, THEME_STORAGE_KEY, INTERACTION_STORAGE_KEY],
    (res) => {
      const prefs: { mode?: EffortMode; ctxTokens?: number; theme?: PanelTheme; interaction?: InteractionMode } = {};
      if (isEffortMode(res?.[MODE_STORAGE_KEY])) prefs.mode = res[MODE_STORAGE_KEY];
      if (isContextTokens(res?.[CTX_STORAGE_KEY])) prefs.ctxTokens = res[CTX_STORAGE_KEY];
      const storedTheme = res?.[THEME_STORAGE_KEY];
      if (storedTheme === "dark" || storedTheme === "light") prefs.theme = storedTheme;
      const storedInteraction = res?.[INTERACTION_STORAGE_KEY];
      if (storedInteraction === "ask" || storedInteraction === "autopilot") prefs.interaction = storedInteraction;
      callback(prefs);
    },
  );
}

export function persistMode(mode: EffortMode, ctxTokens: number): void {
  chrome.storage?.local?.set({ [MODE_STORAGE_KEY]: mode, [CTX_STORAGE_KEY]: ctxTokens });
}

export function persistTheme(theme: PanelTheme): void {
  chrome.storage?.local?.set({ [THEME_STORAGE_KEY]: theme });
}

export function persistInteractionMode(interaction: InteractionMode): void {
  chrome.storage?.local?.set({ [INTERACTION_STORAGE_KEY]: interaction });
}
