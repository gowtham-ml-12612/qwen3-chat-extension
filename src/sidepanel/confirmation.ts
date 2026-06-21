// Confirmation flow for "Ask before acting" interaction mode.
// When interactionMode is "ask", mutating tools require user confirmation
// before executing.

import type { Tool, ToolContext, ToolResult } from "./types";
import type { InteractionMode } from "./state";

export interface ConfirmationUI {
  show(toolName: string, description: string): Promise<boolean>;
}

let confirmationUI: ConfirmationUI | undefined;

export function setConfirmationUI(ui: ConfirmationUI): void {
  confirmationUI = ui;
}

/**
 * Wraps tool execution with a confirmation gate.
 * If interactionMode is "ask" and the tool is marked as mutating,
 * shows a confirmation dialog before proceeding.
 */
export async function executeWithConfirmation(
  tool: Tool,
  ctx: ToolContext,
  interactionMode: InteractionMode,
): Promise<ToolResult | null> {
  if (interactionMode === "ask" && tool.mutating && confirmationUI) {
    const description = buildConfirmationMessage(tool, ctx);
    const confirmed = await confirmationUI.show(tool.name, description);
    if (!confirmed) {
      const msg = "Action cancelled by user.";
      const body = ctx.replyEl.querySelector(".msg-body");
      if (body) body.textContent = msg;
      return { assistantText: msg };
    }
  }
  return tool.run(ctx);
}

function buildConfirmationMessage(tool: Tool, ctx: ToolContext): string {
  switch (tool.name) {
    case "create_presentation":
      return "Create a new presentation? This will navigate away from the current page.";
    case "change_theme":
      return `Change the theme to "${ctx.args.theme_name || "a new theme"}"?`;
    default:
      return `Execute "${tool.name}"? This action will modify your presentation.`;
  }
}

/**
 * Creates the confirmation UI elements and returns the interface.
 * Called once during panel initialization.
 */
export function createConfirmationDialog(container: HTMLElement): ConfirmationUI {
  const overlay = document.createElement("div");
  overlay.className = "confirmation-overlay";
  overlay.hidden = true;

  const dialog = document.createElement("div");
  dialog.className = "confirmation-dialog";

  const msgEl = document.createElement("p");
  msgEl.className = "confirmation-msg";

  const btnRow = document.createElement("div");
  btnRow.className = "confirmation-btns";

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "confirmation-cancel";
  cancelBtn.textContent = "Cancel";

  const confirmBtn = document.createElement("button");
  confirmBtn.className = "confirmation-confirm";
  confirmBtn.textContent = "Proceed";

  btnRow.appendChild(cancelBtn);
  btnRow.appendChild(confirmBtn);
  dialog.appendChild(msgEl);
  dialog.appendChild(btnRow);
  overlay.appendChild(dialog);
  container.appendChild(overlay);

  let resolvePromise: ((value: boolean) => void) | undefined;

  cancelBtn.addEventListener("click", () => {
    overlay.hidden = true;
    resolvePromise?.(false);
  });

  confirmBtn.addEventListener("click", () => {
    overlay.hidden = true;
    resolvePromise?.(true);
  });

  return {
    show(toolName: string, description: string): Promise<boolean> {
      msgEl.textContent = description;
      overlay.hidden = false;
      confirmBtn.focus();
      return new Promise((resolve) => { resolvePromise = resolve; });
    },
  };
}
