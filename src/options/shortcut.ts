import type { MessageKey } from "../shared/i18n";
import { TOGGLE_COMMAND } from "../shared/messages";

// Shortcut recording for browsers that let extensions change their own shortcuts (Firefox).
// Chrome/Edge do not; there the user is sent to chrome://extensions/shortcuts instead.

export interface KeyInput {
  readonly code: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

/** Why a key combination was refused; each is a message key the UI translates. */
export type ShortcutError = Extract<MessageKey, "keyUnusable" | "keySuper" | "keyNeedsModifier" | "keyTooMany">;

export type Recorded = { readonly shortcut: string } | { readonly pending: true } | { readonly error: ShortcutError };

const MODIFIER_CODES = /^(Shift|Control|Alt|Meta|OS)(Left|Right)?$/;
const NAMED_KEYS: Readonly<Record<string, string>> = {
  Comma: "Comma", Period: "Period", Space: "Space", Home: "Home", End: "End", PageUp: "PageUp",
  PageDown: "PageDown", Insert: "Insert", Delete: "Delete", ArrowUp: "Up", ArrowDown: "Down",
  ArrowLeft: "Left", ArrowRight: "Right",
};

/** Maps a physical key (layout-independent, so macOS Option+A stays "A") to browser syntax. */
function keyName(code: string): string | undefined {
  const letter = /^Key([A-Z])$/.exec(code)?.[1];
  const digit = /^Digit([0-9])$/.exec(code)?.[1];
  const fn = /^F([1-9]|1[0-2])$/.test(code) ? code : undefined;
  return letter ?? digit ?? fn ?? NAMED_KEYS[code];
}

/** Turns a keydown into the shortcut string accepted by commands.update, or explains why not. */
export function shortcutFromKey(e: KeyInput, isMac: boolean): Recorded {
  if (MODIFIER_CODES.test(e.code)) return { pending: true };
  const key = keyName(e.code);
  if (!key) return { error: "keyUnusable" };
  if (e.metaKey && !isMac) return { error: "keySuper" };

  const primary = [e.ctrlKey && (isMac ? "MacCtrl" : "Ctrl"), e.metaKey && "Command", e.altKey && "Alt"].filter(
    (m): m is string => typeof m === "string",
  );
  const modifiers = [...primary, ...(e.shiftKey ? ["Shift"] : [])];
  const isFunctionKey = /^F\d+$/.test(key);
  if (primary.length === 0 && !(isFunctionKey && modifiers.length === 0)) {
    return { error: "keyNeedsModifier" };
  }
  if (modifiers.length > 2) return { error: "keyTooMany" };
  return { shortcut: [...modifiers, key].join("+") };
}

export const isMacPlatform = () => /Mac|iPhone|iPad/.test(navigator.platform);

/** Firefox-only parts of the commands API; absent from Chrome and from @types/chrome. */
interface EditableCommands {
  update(detail: { name: string; shortcut: string }): Promise<void>;
  reset(name: string): Promise<void>;
}

export function editableCommands(): EditableCommands | undefined {
  const api = chrome.commands as unknown as Partial<EditableCommands>;
  return typeof api.update === "function" && typeof api.reset === "function" ? (api as EditableCommands) : undefined;
}

/** The shortcut actually assigned by the browser; empty when the default key was already taken. */
export async function currentShortcut(): Promise<string> {
  const commands = await chrome.commands.getAll();
  return commands.find((c) => c.name === TOGGLE_COMMAND)?.shortcut ?? "";
}
