import type { EffortMode } from "../modes";
import type { PageElement } from "../actions";

export interface HistoryTurn {
  role: "user" | "assistant";
  text: string;
}

export interface Pending {
  onStatus: (text: string) => void;
  onDelta: (text: string) => void;
  resolve: (text: string) => void;
  reject: (err: Error) => void;
}

export interface ToolParam {
  name: string;
  type: "string";
  description: string;
  required?: boolean;
}

export interface ToolContext {
  userText: string;
  mode: EffortMode;
  replyEl: HTMLDivElement;
  attachedImage?: string;
  args: Record<string, string>;
  setStatus(text: string): void;
  isStopped(): boolean;
}

export interface ToolResult {
  assistantText: string;
  remember?: boolean;
}

export interface Tool {
  name: string;
  description: string;
  params?: ToolParam[];
  mutating?: boolean;
  run(ctx: ToolContext): Promise<ToolResult | null>;
}

export interface ToolSelection {
  tool: Tool;
  args: Record<string, string>;
}

export interface SlideMetadataTheme {
  name: string;
  colors: { role: string; hex: string }[];
}

export interface SlideMetadata {
  theme?: SlideMetadataTheme;
  slideIndex?: number;
  slideName?: string;
}

export interface SlideContextResult {
  summary: string;
  metadata: SlideMetadata;
}

export interface DocContextResult {
  summary: string;
  masterCount: number;
  parsedMasters: MasterInfo[];
}

export interface MasterInfo {
  name: string;
  fonts: string[];
  colors: { role: string; hex: string }[];
}
