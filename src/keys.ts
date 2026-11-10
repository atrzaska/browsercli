// Key-combo parsing ("Control+Shift+a", "Enter", "Meta+v") into CDP key events.
import type { Tab } from "./browser.js";
import { CliError } from "./common.js";

interface KeyDef {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}

const NAMED: Record<string, KeyDef> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  Insert: { key: "Insert", code: "Insert", keyCode: 45 },
  Shift: { key: "Shift", code: "ShiftLeft", keyCode: 16 },
  Control: { key: "Control", code: "ControlLeft", keyCode: 17 },
  Alt: { key: "Alt", code: "AltLeft", keyCode: 18 },
  Meta: { key: "Meta", code: "MetaLeft", keyCode: 91 },
};
for (let i = 1; i <= 12; i++) NAMED[`F${i}`] = { key: `F${i}`, code: `F${i}`, keyCode: 111 + i };

const ALIASES: Record<string, string> = {
  esc: "Escape",
  return: "Enter",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  ctrl: "Control",
  control: "Control",
  cmd: "Meta",
  command: "Meta",
  meta: "Meta",
  super: "Meta",
  option: "Alt",
  opt: "Alt",
  alt: "Alt",
  shift: "Shift",
  del: "Delete",
  space: "Space",
  pgup: "PageUp",
  pgdn: "PageDown",
};

const MODIFIER_BITS: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

// macOS editing shortcuts are handled by the OS menu, not key events, so CDP
// needs explicit editor commands for them to work.
const MAC_COMMANDS: Record<string, string> = { a: "selectAll", c: "copy", x: "cut", v: "paste", z: "undo" };

function lookup(name: string): KeyDef {
  const canonical = NAMED[name] ? name : ALIASES[name.toLowerCase()];
  if (canonical && NAMED[canonical]) return NAMED[canonical];
  const named = Object.keys(NAMED).find((k) => k.toLowerCase() === name.toLowerCase());
  if (named) return NAMED[named];
  if ([...name].length === 1) {
    const upper = name.toUpperCase();
    let code = "";
    if (/[a-z]/i.test(name)) code = `Key${upper}`;
    else if (/[0-9]/.test(name)) code = `Digit${name}`;
    return { key: name, code, keyCode: /[a-z0-9]/i.test(name) ? upper.charCodeAt(0) : 0, text: name };
  }
  throw new CliError("bad_key", `unknown key "${name}"`);
}

export function parseCombo(combo: string): { modifiers: string[]; key: KeyDef } {
  let parts = combo.split("+");
  // "Control++" -> ["Control", "", ""]: the key is "+".
  if (combo.endsWith("+") && combo.length > 1) parts = [...parts.slice(0, -2), "+"];
  const keyName = parts.pop()!;
  if (!keyName) throw new CliError("bad_key", `invalid key combo "${combo}"`);
  const modifiers = parts.map((m) => {
    const def = lookup(m);
    if (!(def.key in MODIFIER_BITS)) throw new CliError("bad_key", `"${m}" is not a modifier`);
    return def.key;
  });
  return { modifiers, key: lookup(keyName) };
}

export async function pressCombo(tab: Tab, combo: string) {
  const { modifiers, key } = parseCombo(combo);
  let bits = 0;
  for (const m of modifiers) {
    bits |= MODIFIER_BITS[m];
    const d = NAMED[m];
    await tab.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      modifiers: bits,
      key: d.key,
      code: d.code,
      windowsVirtualKeyCode: d.keyCode,
    });
  }
  const shift = modifiers.includes("Shift");
  const textSuppressed = modifiers.some((m) => m !== "Shift");
  let keyValue = key.key;
  let text = key.text;
  if (shift && text && text.length === 1 && /[a-z]/.test(text)) {
    keyValue = text.toUpperCase();
    text = keyValue;
  }
  if (textSuppressed) text = undefined;
  const commands: string[] = [];
  if (process.platform === "darwin" && modifiers.includes("Meta")) {
    const k = key.key.toLowerCase();
    if (k === "z" && shift) commands.push("redo");
    else if (MAC_COMMANDS[k]) commands.push(MAC_COMMANDS[k]);
  }
  const base = { modifiers: bits, key: keyValue, code: key.code, windowsVirtualKeyCode: key.keyCode };
  await tab.send("Input.dispatchKeyEvent", {
    ...base,
    type: text ? "keyDown" : "rawKeyDown",
    text,
    unmodifiedText: text,
    commands: commands.length ? commands : undefined,
  });
  await tab.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  for (const m of [...modifiers].reverse()) {
    bits &= ~MODIFIER_BITS[m];
    const d = NAMED[m];
    await tab.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      modifiers: bits,
      key: d.key,
      code: d.code,
      windowsVirtualKeyCode: d.keyCode,
    });
  }
}
