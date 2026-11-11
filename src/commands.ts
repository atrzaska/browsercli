// Verb implementations executed inside the daemon.
import { join } from "node:path";
import type { Protocol } from "devtools-protocol";
import { Browser, formatRemote, shortId, type Tab } from "./browser.js";
import type { CDPEvent } from "./cdp.js";
import { CliError, HOME, sleep, untrusted, type Capture, type Flags } from "./common.js";
import { pressCombo } from "./keys.js";
import { Recorder } from "./recorder.js";
import { diffLines, findNodes, renderSnapshot } from "./snapshot.js";

export interface Ctx {
  browser: Browser;
  args: string[];
  flags: Flags;
}

export interface Output {
  text?: string;
  data?: unknown;
  capture?: Capture;
}

type Handler = (c: Ctx) => Promise<Output>;

const DEFAULT_WAIT_TIMEOUT = 30_000;

// ---------- flag/arg helpers ----------

function str(f: Flags, k: string): string | undefined {
  const v = f[k];
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v[0];
  return undefined;
}

function list(f: Flags, k: string): string[] {
  const v = f[k];
  if (Array.isArray(v)) return v;
  if (typeof v === "string") return [v];
  return [];
}

const bool = (f: Flags, k: string) => f[k] === true || f[k] === "true";

function num(f: Flags, k: string, def: number): number {
  const v = str(f, k);
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new CliError("bad_args", `--${k} must be a number`);
  return n;
}

function arg(c: Ctx, i: number, name: string): string {
  const v = c.args[i];
  if (v === undefined) throw new CliError("bad_args", `missing ${name}`);
  return v;
}

function oneOf<T extends string>(v: string | undefined, allowed: readonly T[], name: string): T {
  if (v && (allowed as readonly string[]).includes(v)) return v as T;
  throw new CliError("bad_args", `${name} must be one of: ${allowed.join(", ")}`);
}

// ---------- tab / page helpers ----------

async function getTab(c: Ctx, opts: { allowDialog?: boolean } = {}): Promise<Tab> {
  const targetId = await c.browser.resolveTarget(str(c.flags, "tab"));
  const tab = await c.browser.tab(targetId);
  if (tab.dialog && !opts.allowDialog) {
    throw new CliError(
      "dialog_open",
      `a JavaScript ${tab.dialog.type} dialog is blocking the page: ${JSON.stringify(tab.dialog.message)}\n` +
        "run `browsercli dialog accept` or `browsercli dialog dismiss`",
    );
  }
  return tab;
}

async function evaluate<T = any>(tab: Tab, expression: string, timeoutMs?: number): Promise<T> {
  const r = await tab.send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true, userGesture: true, replMode: true },
    timeoutMs,
  );
  if (r.exceptionDetails) throw jsError(r.exceptionDetails);
  return r.result.value as T;
}

function jsError(d: Protocol.Runtime.ExceptionDetails): CliError {
  return new CliError("js_error", d.exception?.description ?? d.text);
}

async function callOn<T = any>(tab: Tab, objectId: string, fn: string, ...args: unknown[]): Promise<T> {
  const r = await tab.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: fn,
    arguments: args.map((value) => ({ value })),
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (r.exceptionDetails) throw jsError(r.exceptionDetails);
  return r.result.value as T;
}

const REF_RE = /^@?(e\d+)$/;

// Resolves a snapshot ref (@e3 / e3) or, as a fallback, a CSS selector.
async function resolveElement(tab: Tab, ref: string): Promise<string> {
  const m = REF_RE.exec(ref);
  if (m) {
    const backendNodeId = tab.refs.get(m[1]);
    const stale = new CliError(
      "stale_ref",
      `ref @${m[1]} is stale (page navigated or element removed); run \`browsercli snapshot\` and retry`,
    );
    if (backendNodeId === undefined) throw stale;
    try {
      const { object } = await tab.send("DOM.resolveNode", { backendNodeId });
      if (!object.objectId) throw stale;
      return object.objectId;
    } catch {
      throw stale;
    }
  }
  const r = await tab.send("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(ref)})` });
  if (r.exceptionDetails) throw new CliError("bad_selector", `invalid ref or CSS selector: ${ref}`);
  if (!r.result.objectId) throw new CliError("not_found", `no element matches ${ref}`);
  return r.result.objectId;
}

async function centerOf(tab: Tab, objectId: string): Promise<{ x: number; y: number }> {
  await tab.send("DOM.scrollIntoViewIfNeeded", { objectId }).catch(() => {});
  let quads: number[][] = [];
  try {
    ({ quads } = await tab.send("DOM.getContentQuads", { objectId }));
  } catch {
    // fall through
  }
  const area = (q: number[]) =>
    Math.abs((q[0] * q[3] - q[1] * q[2] + q[2] * q[5] - q[3] * q[4] + q[4] * q[7] - q[5] * q[6] + q[6] * q[1] - q[7] * q[0]) / 2);
  const q = quads.find((q) => area(q) > 1);
  if (!q) throw new CliError("not_visible", "element has no visible box (hidden, zero-size or detached)");
  return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 };
}

async function mouseClick(tab: Tab, x: number, y: number, clickCount: number) {
  await tab.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  for (let i = 1; i <= clickCount; i++) {
    await tab.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: i });
    await tab.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: i });
  }
}

const dialogNote = (tab: Tab) =>
  tab.dialog
    ? `\n→ a JavaScript ${tab.dialog.type} dialog opened: ${JSON.stringify(tab.dialog.message)}; run \`browsercli dialog accept|dismiss\``
    : "";

// Input and evaluation calls block while a JavaScript dialog is open, so
// resolve as soon as one appears. Returns true if a dialog interrupted.
async function raceDialog(tab: Tab, p: Promise<unknown>): Promise<boolean> {
  let off = () => {};
  const opened = new Promise<boolean>((r) => {
    off = tab.onEvent((e) => e.method === "Page.javascriptDialogOpening" && r(true));
  });
  p.catch(() => {}); // the blocked call may reject later; that's expected
  try {
    return await Promise.race([p.then(() => false), opened]);
  } finally {
    off();
  }
}

// Chrome withholds trusted mouse input from hidden (background) tabs for ~5s,
// so those get DOM-dispatched events instead of CDP input.
const isHidden = (tab: Tab) => evaluate<boolean>(tab, `document.visibilityState === "hidden"`).catch(() => false);
const SYNTHETIC_NOTE = " (synthetic events: tab is in the background)";

const SYNTHETIC_CLICK_FN = `function(count) {
  this.scrollIntoView({ block: "center", inline: "center" });
  const r = this.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) throw new Error("element has no visible box (hidden, zero-size or detached)");
  const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
  const ptr = { ...base, pointerId: 1, pointerType: "mouse", isPrimary: true };
  this.dispatchEvent(new PointerEvent("pointerover", ptr));
  this.dispatchEvent(new MouseEvent("mouseover", base));
  for (let i = 1; i <= count; i++) {
    this.dispatchEvent(new PointerEvent("pointerdown", { ...ptr, buttons: 1 }));
    this.dispatchEvent(new MouseEvent("mousedown", { ...base, buttons: 1, detail: i }));
    if (typeof this.focus === "function") this.focus();
    this.dispatchEvent(new PointerEvent("pointerup", ptr));
    this.dispatchEvent(new MouseEvent("mouseup", { ...base, detail: i }));
    this.dispatchEvent(new MouseEvent("click", { ...base, detail: i }));
  }
  if (count === 2) this.dispatchEvent(new MouseEvent("dblclick", { ...base, detail: 2 }));
}`;

const SYNTHETIC_HOVER_FN = `function() {
  this.scrollIntoView({ block: "center", inline: "center" });
  const r = this.getBoundingClientRect();
  const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  const ptr = { ...base, pointerId: 1, pointerType: "mouse", isPrimary: true };
  this.dispatchEvent(new PointerEvent("pointerover", ptr));
  this.dispatchEvent(new PointerEvent("pointerenter", { ...ptr, bubbles: false }));
  this.dispatchEvent(new MouseEvent("mouseover", base));
  this.dispatchEvent(new MouseEvent("mouseenter", { ...base, bubbles: false }));
  this.dispatchEvent(new PointerEvent("pointermove", ptr));
  this.dispatchEvent(new MouseEvent("mousemove", base));
}`;

// Scrolls the nearest scrollable ancestor of el (or of the viewport center).
const SYNTHETIC_SCROLL_EXPR = (dx: number, dy: number, hasEl: boolean) => `function() {
  let el = ${hasEl ? "this" : "document.elementFromPoint(innerWidth / 2, innerHeight / 2)"};
  const canScroll = (e) => {
    const s = getComputedStyle(e);
    return (${dy} !== 0 && /(auto|scroll|overlay)/.test(s.overflowY) && e.scrollHeight > e.clientHeight) ||
      (${dx} !== 0 && /(auto|scroll|overlay)/.test(s.overflowX) && e.scrollWidth > e.clientWidth);
  };
  while (el && el !== document.body && el !== document.documentElement && !canScroll(el)) el = el.parentElement;
  if (el && el !== document.body && el !== document.documentElement) el.scrollBy(${dx}, ${dy});
  else window.scrollBy(${dx}, ${dy});
}`;

async function clickElement(tab: Tab, objectId: string, count: number): Promise<string> {
  if (await isHidden(tab)) {
    await callOn(tab, objectId, SYNTHETIC_CLICK_FN, count);
    return SYNTHETIC_NOTE;
  }
  const { x, y } = await centerOf(tab, objectId);
  await mouseClick(tab, x, y, count);
  return "";
}

// Runs an action and, if it kicked off a main-frame navigation, waits for the load.
async function withNavWatch(tab: Tab, action: () => Promise<void>): Promise<string> {
  let started = false;
  let newDoc = false;
  let sameDoc = false;
  let loaded = false;
  let onLoad!: () => void;
  const loadP = new Promise<void>((r) => (onLoad = r));
  const off = tab.onEvent((e: CDPEvent) => {
    if (
      (e.method === "Page.frameStartedLoading" || e.method === "Page.frameRequestedNavigation") &&
      e.params.frameId === tab.mainFrameId
    ) {
      started = true;
    } else if (e.method === "Page.frameNavigated" && !e.params.frame.parentId) {
      newDoc = true;
    } else if (e.method === "Page.navigatedWithinDocument" && e.params.frameId === tab.mainFrameId) {
      sameDoc = true;
    } else if (e.method === "Page.loadEventFired") {
      loaded = true;
      onLoad();
    }
  });
  try {
    if (await raceDialog(tab, action())) return dialogNote(tab);
    await sleep(150);
    if (tab.dialog) return dialogNote(tab);
    // SPA routers also fire frameStartedLoading; only wait if a document is coming.
    if (started && !sameDoc && !loaded) await Promise.race([loadP, sleep(10_000)]);
  } finally {
    off();
  }
  if (!newDoc && !sameDoc) return "";
  const url = await evaluate<string>(tab, "location.href").catch(() => "");
  return newDoc
    ? `\n→ page navigated to ${url}; refs invalidated, run \`browsercli snapshot\``
    : `\n→ URL changed to ${url} (same document; existing refs still valid, run \`browsercli snapshot\` for new content)`;
}

// Triggers a navigation and waits for load. Returns false if it timed out.
async function navigateAndWait(
  tab: Tab,
  trigger: () => Promise<{ sameDocument?: boolean } | void>,
  timeoutMs: number,
): Promise<boolean> {
  let done!: () => void;
  const finished = new Promise<void>((r) => (done = r));
  const off = tab.onEvent((e) => {
    if (e.method === "Page.loadEventFired") done();
    else if (e.method === "Page.navigatedWithinDocument" && e.params.frameId === tab.mainFrameId) done();
    else if (e.method === "Page.frameNavigated" && !e.params.frame.parentId && e.params.type === "BackForwardCacheRestore") done();
  });
  try {
    const r = await trigger();
    if (r && r.sameDocument) return true;
    return await Promise.race([finished.then(() => true), sleep(timeoutMs).then(() => false)]);
  } finally {
    off();
  }
}

async function pageInfo(tab: Tab): Promise<{ url: string; title: string }> {
  return evaluate(tab, "({ url: location.href, title: document.title })").catch(() => ({ url: "", title: "" }));
}

function normalizeUrl(u: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u) || /^(about|data|javascript|blob|chrome|mailto):/i.test(u)) return u;
  if (/^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(u)) return `http://${u}`;
  return `https://${u}`;
}

async function navigate(tab: Tab, url: string, timeoutMs: number): Promise<string> {
  const loaded = await navigateAndWait(
    tab,
    async () => {
      const r = await tab.send("Page.navigate", { url });
      if (r.errorText) throw new CliError("navigation_failed", `${url}: ${r.errorText}`);
      return { sameDocument: !r.loaderId };
    },
    timeoutMs,
  );
  const info = await pageInfo(tab);
  return `${info.url} — ${JSON.stringify(info.title)}${loaded ? "" : " (still loading)"}`;
}

async function waitForInitialLoad(tab: Tab, requestedUrl: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  const blank = requestedUrl === "about:blank";
  while (Date.now() < deadline) {
    const ok = await evaluate<boolean>(
      tab,
      `document.readyState === "complete" && (${blank} || location.href !== "about:blank")`,
    ).catch(() => false);
    if (ok) return;
    await sleep(100);
  }
}

async function axTree(tab: Tab) {
  const { nodes } = await tab.send("Accessibility.getFullAXTree", {});
  return nodes;
}

async function backendIdOf(tab: Tab, objectId: string): Promise<number> {
  const { node } = await tab.send("DOM.describeNode", { objectId });
  return node.backendNodeId;
}

const FILL_KIND_FN = `function() {
  const tag = this.tagName ? this.tagName.toLowerCase() : "";
  if (tag === "select") return "select";
  if (tag === "input" && (this.type === "checkbox" || this.type === "radio")) return "check";
  if (tag === "input" || tag === "textarea") return "text";
  if (this.isContentEditable) return "editable";
  return "other";
}`;

const CLEAR_FN = `function() {
  this.focus();
  if (this.isContentEditable) {
    const r = document.createRange(); r.selectNodeContents(this);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    document.execCommand("delete");
    return;
  }
  const proto = this instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(this, "");
  this.dispatchEvent(new Event("input", { bubbles: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
}`;

const SELECT_FN = `function(values) {
  if (this.tagName.toLowerCase() !== "select") throw new Error("element is not a <select>");
  const opts = [...this.options];
  const matches = opts.filter((o) => values.includes(o.value) || values.includes(o.label.trim()) || values.includes(o.text.trim()));
  if (!matches.length) return [];
  // Deselecting the current option of a single <select> makes the browser
  // reselect the first one, so set the value directly instead.
  if (this.multiple) for (const o of opts) o.selected = matches.includes(o);
  else this.value = matches[0].value;
  this.dispatchEvent(new Event("input", { bubbles: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
  return opts.filter((o) => o.selected).map((o) => o.value);
}`;

const CHECKED_FN = `function() {
  if (typeof this.checked === "boolean") return this.checked;
  return this.getAttribute("aria-checked") === "true" || this.getAttribute("aria-pressed") === "true";
}`;

async function fillElement(tab: Tab, objectId: string, value: string): Promise<string> {
  const kind = await callOn<string>(tab, objectId, FILL_KIND_FN);
  if (kind === "select") {
    const picked = await callOn<string[]>(tab, objectId, SELECT_FN, [value]);
    if (!picked.length) throw new CliError("not_found", `no option matching ${JSON.stringify(value)}`);
    return `selected ${JSON.stringify(picked)}`;
  }
  if (kind === "check") {
    await setChecked(tab, objectId, !["false", "0", "off", "no", ""].includes(value.toLowerCase()));
    return "set checked state";
  }
  if (kind === "other") throw new CliError("not_fillable", "element is not an input, textarea, select or contenteditable");
  await tab.send("DOM.focus", { objectId }).catch(() => {});
  await callOn(tab, objectId, CLEAR_FN);
  if (value) await tab.send("Input.insertText", { text: value });
  await callOn(tab, objectId, `function() { this.dispatchEvent(new Event("change", { bubbles: true })); }`);
  if (kind === "text") {
    const actual = await callOn<string>(tab, objectId, `function() { return this.value; }`);
    return actual === value ? "filled" : `filled (field now contains ${JSON.stringify(actual)})`;
  }
  // Rich-text editors may turn emoji into images or add trailing content, so
  // only check that the typed text (minus emoji) made it in.
  const actual = await callOn<string>(tab, objectId, READ_EDITABLE_FN);
  return comparableText(actual).includes(comparableText(value))
    ? "filled"
    : `filled, but the editor now contains ${JSON.stringify(actual.trim())}`;
}

// Editor text as rendered: images count as their alt text, blocks as newlines.
const READ_EDITABLE_FN = `function() {
  const parts = [];
  const walk = (n) => {
    if (n.nodeType === Node.TEXT_NODE) return void parts.push(n.data);
    if (n.nodeType !== Node.ELEMENT_NODE) return;
    if (n.tagName === "IMG") return void parts.push(n.alt || n.getAttribute("aria-label") || "");
    if (n.tagName === "BR") return void parts.push("\\n");
    for (const c of n.childNodes) walk(c);
    if (/^(P|DIV|LI)$/.test(n.tagName)) parts.push("\\n");
  };
  walk(this);
  return parts.join("");
}`;

// Drops emoji (as characters or :shortcodes:) and normalizes whitespace.
function comparableText(s: string): string {
  return s
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\u200d\ufe0f]/gu, "")
    .replace(/:[a-z0-9_+-]+:/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function setChecked(tab: Tab, objectId: string, want: boolean) {
  if ((await callOn<boolean>(tab, objectId, CHECKED_FN)) === want) return;
  await clickElement(tab, objectId, 1);
  if ((await callOn<boolean>(tab, objectId, CHECKED_FN)) !== want) {
    await callOn(tab, objectId, "function() { this.click(); }");
  }
  if ((await callOn<boolean>(tab, objectId, CHECKED_FN)) !== want) {
    throw new CliError("action_failed", `could not ${want ? "check" : "uncheck"} the element`);
  }
}

function formatCookie(c: Protocol.Network.Cookie): string {
  const parts = [`${c.name}=${c.value}`, `domain=${c.domain}`, `path=${c.path}`];
  if (c.expires > 0) parts.push(`expires=${new Date(c.expires * 1000).toISOString()}`);
  if (c.httpOnly) parts.push("httpOnly");
  if (c.secure) parts.push("secure");
  if (c.sameSite) parts.push(`sameSite=${c.sameSite}`);
  return parts.join("; ");
}

const truncate = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1) + "…" : s);

const ACT_NOTE = (tab: Tab) => ` (tab ${shortId(tab.targetId)})`;

// ---------- verbs ----------

const tabVerbs: Record<string, Handler> = {
  async list(c) {
    const pages = await c.browser.pages();
    const cur = c.browser.currentTargetId;
    const data = pages.map((p) => ({ id: p.id, targetId: p.targetId, title: p.title, url: p.url, current: p.targetId === cur }));
    const text = pages.length
      ? untrusted(data.map((p) => `${p.current ? "*" : " "} ${p.id}  ${JSON.stringify(p.title)}  ${truncate(p.url, 120)}`).join("\n"))
      : "no tabs";
    return { text, data };
  },

  async new(c) {
    const url = normalizeUrl(c.args[1] ?? "about:blank");
    const conn = await c.browser.connection();
    const { targetId } = await conn.send("Target.createTarget", { url, background: true, newWindow: bool(c.flags, "window") });
    c.browser.currentTargetId = targetId;
    const tab = await c.browser.tab(targetId);
    await waitForInitialLoad(tab, url, num(c.flags, "timeout", DEFAULT_WAIT_TIMEOUT));
    const info = await pageInfo(tab);
    return {
      text: `opened tab ${shortId(targetId)} (now selected): ${info.url} — ${JSON.stringify(info.title)}`,
      data: { id: shortId(targetId), targetId, ...info },
    };
  },

  async switch(c) {
    const id = c.args[1] ?? str(c.flags, "tab");
    if (!id) throw new CliError("bad_args", "usage: browsercli tab switch ID");
    const targetId = await c.browser.resolveTarget(id);
    const conn = await c.browser.connection();
    await conn.send("Target.activateTarget", { targetId });
    c.browser.currentTargetId = targetId;
    const tab = await c.browser.tab(targetId);
    const info = await pageInfo(tab);
    return { text: `selected tab ${shortId(targetId)}: ${info.url} — ${JSON.stringify(info.title)}`, data: { id: shortId(targetId), targetId, ...info } };
  },

  async close(c) {
    const targetId = await c.browser.resolveTarget(c.args[1] ?? str(c.flags, "tab"));
    const conn = await c.browser.connection();
    await c.browser.detach(targetId);
    await conn.send("Target.closeTarget", { targetId });
    if (c.browser.currentTargetId === targetId) c.browser.currentTargetId = undefined;
    return { text: `closed tab ${shortId(targetId)}`, data: { id: shortId(targetId), targetId } };
  },
};

export const verbs: Record<string, Handler> = {
  async status(c) {
    const data: Record<string, unknown> = {
      pid: process.pid,
      connected: c.browser.connected,
      endpoint: c.browser.endpoint,
      currentTab: c.browser.currentTargetId ? shortId(c.browser.currentTargetId) : null,
    };
    if (c.browser.connected) {
      const conn = await c.browser.connection();
      const v = await conn.send("Browser.getVersion");
      data.browser = v.product;
    }
    const lines = [
      `daemon pid ${data.pid}`,
      c.browser.connected ? `connected to ${data.browser} at ${data.endpoint}` : "not connected (connects on first command)",
      `selected tab: ${data.currentTab ?? "none"}`,
    ];
    return { text: lines.join("\n"), data };
  },

  async connect(c) {
    const port = str(c.flags, "port");
    c.browser.opts = {
      ws: str(c.flags, "ws"),
      port: port ? Number(port) : undefined,
      userDataDir: str(c.flags, "user-data-dir"),
    };
    c.browser.disconnect();
    c.browser.currentTargetId = undefined;
    const conn = await c.browser.connection();
    const v = await conn.send("Browser.getVersion");
    return { text: `connected to ${v.product} at ${c.browser.endpoint}`, data: { browser: v.product, endpoint: c.browser.endpoint } };
  },

  async disconnect(c) {
    c.browser.disconnect();
    return { text: "disconnected" };
  },

  async tab(c) {
    const sub = c.args[0] ?? "list";
    const h = tabVerbs[sub];
    if (!h) throw new CliError("bad_args", "usage: browsercli tab list|new|switch|close");
    return h(c);
  },

  async open(c) {
    const url = normalizeUrl(arg(c, 0, "URL"));
    const tabFlag = str(c.flags, "tab");
    if (bool(c.flags, "new") || (!tabFlag && !c.browser.currentTargetId)) {
      return tabVerbs.new({ ...c, args: ["new", url] });
    }
    const tab = await getTab(c);
    c.browser.currentTargetId = tab.targetId;
    const res = await navigate(tab, url, num(c.flags, "timeout", DEFAULT_WAIT_TIMEOUT));
    return { text: `opened ${res}${ACT_NOTE(tab)}` };
  },

  async back(c) {
    return history(c, -1);
  },
  async forward(c) {
    return history(c, 1);
  },

  async reload(c) {
    const tab = await getTab(c);
    const loaded = await navigateAndWait(tab, async () => void (await tab.send("Page.reload", {})), num(c.flags, "timeout", DEFAULT_WAIT_TIMEOUT));
    const info = await pageInfo(tab);
    return { text: `reloaded ${info.url}${loaded ? "" : " (still loading)"}` };
  },

  async snapshot(c) {
    const tab = await getTab(c);
    let rootBackendNodeId: number | undefined;
    const scope = str(c.flags, "scope");
    if (scope) rootBackendNodeId = await backendIdOf(tab, await resolveElement(tab, scope));
    const nodes = await axTree(tab);
    const lines = renderSnapshot(tab, nodes, {
      interactiveOnly: bool(c.flags, "interactive-only"),
      maxDepth: str(c.flags, "depth") !== undefined ? num(c.flags, "depth", 0) : undefined,
      rootBackendNodeId,
    });
    const key = JSON.stringify([c.flags["interactive-only"], c.flags.depth, scope]);
    const prev = tab.lastSnapshots.get(key);
    tab.lastSnapshots.set(key, lines);
    const info = await pageInfo(tab);
    const header = `page: ${info.url} — ${JSON.stringify(info.title)} (tab ${shortId(tab.targetId)})`;
    if (bool(c.flags, "diff")) {
      if (!prev) return { text: `${header}\nno previous snapshot of this document with these options; full snapshot:\n${untrusted(lines.join("\n"))}`, data: { ...info, lines } };
      const d = diffLines(prev, lines);
      return { text: `${header}\n${d.length ? untrusted(d.join("\n")) : "no changes"}`, data: { ...info, diff: d } };
    }
    return { text: `${header}\n${untrusted(lines.join("\n"))}`, data: { ...info, lines } };
  },

  async text(c) {
    const tab = await getTab(c);
    const text = await evaluate<string>(tab, "document.body ? document.body.innerText : ''");
    return { text: untrusted(text), data: { text } };
  },

  async find(c) {
    const query = arg(c, 0, "QUERY");
    const by = oneOf(str(c.flags, "by") ?? "text", ["text", "role"] as const, "--by");
    const tab = await getTab(c);
    const matches = findNodes(tab, await axTree(tab), query, by);
    return {
      text: matches.length ? untrusted(matches.map((m) => `- ${m.line}`).join("\n")) : `no elements match ${JSON.stringify(query)}`,
      data: matches,
    };
  },

  async get(c) {
    const what = oneOf(str(c.flags, "what"), ["text", "html", "value", "url", "title", "count", "box"] as const, "--what");
    const tab = await getTab(c);
    const ref = str(c.flags, "ref");
    let value: unknown;
    if (what === "url") value = await evaluate(tab, "location.href");
    else if (what === "title") value = await evaluate(tab, "document.title");
    else if (what === "count") {
      const sel = str(c.flags, "selector") ?? ref;
      if (!sel) throw new CliError("bad_args", "--what count needs --selector CSS");
      value = await evaluate(tab, `document.querySelectorAll(${JSON.stringify(sel)}).length`);
    } else if (!ref) {
      if (what === "text") value = await evaluate(tab, "document.body ? document.body.innerText : ''");
      else if (what === "html") value = await evaluate(tab, "document.documentElement.outerHTML");
      else throw new CliError("bad_args", `--what ${what} needs --ref REF`);
    } else {
      const id = await resolveElement(tab, ref);
      const fns = {
        text: "function() { return this.innerText ?? this.textContent; }",
        html: "function() { return this.outerHTML; }",
        value: "function() { return this.value; }",
        box: "function() { const r = this.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }",
      };
      value = await callOn(tab, id, fns[what]);
    }
    const asText = typeof value === "string" ? value : JSON.stringify(value);
    return { text: what === "count" ? asText : untrusted(asText), data: { value } };
  },

  async is(c) {
    const what = oneOf(str(c.flags, "what"), ["visible", "enabled", "checked"] as const, "--what");
    const ref = str(c.flags, "ref") ?? c.args[0];
    if (!ref) throw new CliError("bad_args", "missing --ref REF");
    const tab = await getTab(c);
    const id = await resolveElement(tab, ref);
    const fns = {
      visible: `function() {
        const s = getComputedStyle(this);
        return this.getClientRects().length > 0 && s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0;
      }`,
      enabled: `function() { return !this.disabled && this.getAttribute("aria-disabled") !== "true" && !this.closest("fieldset:disabled"); }`,
      checked: CHECKED_FN,
    };
    const value = await callOn<boolean>(tab, id, fns[what]);
    return { text: String(value), data: { value } };
  },

  async screenshot(c) {
    const tab = await getTab(c);
    const out = str(c.flags, "out") ?? "";
    const ext = /\.jpe?g$/i.test(out) ? "jpeg" : /\.webp$/i.test(out) ? "webp" : "png";
    const params: Protocol.Page.CaptureScreenshotRequest = { format: ext as "png" | "jpeg" | "webp" };
    const ref = str(c.flags, "ref");
    if (ref) {
      const id = await resolveElement(tab, ref);
      await tab.send("DOM.scrollIntoViewIfNeeded", { objectId: id }).catch(() => {});
      const box = await callOn<{ x: number; y: number; width: number; height: number }>(
        tab,
        id,
        "function() { const r = this.getBoundingClientRect(); return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height }; }",
      );
      if (box.width < 1 || box.height < 1) throw new CliError("not_visible", "element has no visible box");
      params.clip = { ...box, scale: 1 };
      params.captureBeyondViewport = true;
    } else if (bool(c.flags, "full")) {
      const m = await tab.send("Page.getLayoutMetrics");
      params.clip = { x: 0, y: 0, width: m.cssContentSize.width, height: m.cssContentSize.height, scale: 1 };
      params.captureBeyondViewport = true;
    }
    const { data } = await tab.send("Page.captureScreenshot", params);
    return { capture: { base64: data, ext: ext === "jpeg" ? "jpg" : ext } };
  },

  async pdf(c) {
    const tab = await getTab(c);
    try {
      const { data } = await tab.send("Page.printToPDF", { printBackground: true }, 60_000);
      return { capture: { base64: data, ext: "pdf" } };
    } catch (e) {
      throw new CliError("pdf_failed", `PDF export failed: ${(e as Error).message} (Chrome only supports this for some pages/modes)`);
    }
  },

  async console(c) {
    const tab = await getTab(c, { allowDialog: true });
    const entries = tab.console.slice(-num(c.flags, "limit", 50));
    if (bool(c.flags, "clear")) tab.console = [];
    const text = entries.length
      ? untrusted(entries.map((e) => `[${e.level}] ${e.text}`).join("\n"))
      : "no console messages (messages are captured once a tab is attached)";
    return { text, data: entries };
  },

  async network(c) {
    const tab = await getTab(c, { allowDialog: true });
    const entries = tab.network.slice(-num(c.flags, "limit", 50));
    const text = entries.length
      ? untrusted(entries.map((e) => `${e.failed ? `FAILED(${e.failed})` : e.status ?? "…"} ${e.method} ${e.url}${e.type ? ` (${e.type})` : ""}`).join("\n"))
      : "no requests recorded (requests are captured once a tab is attached)";
    return { text, data: entries };
  },

  async cookies(c) {
    const sub = oneOf(c.args[0] ?? "get", ["get", "set", "delete"] as const, "cookies action");
    const tab = await getTab(c);
    const url = str(c.flags, "url") ?? (await evaluate<string>(tab, "location.href"));
    if (sub === "get") {
      const { cookies } = await tab.send("Network.getCookies", { urls: [url] });
      return { text: cookies.length ? untrusted(cookies.map(formatCookie).join("\n")) : "no cookies", data: cookies };
    }
    const name = arg(c, 1, "cookie NAME");
    if (sub === "set") {
      const value = arg(c, 2, "cookie VALUE");
      const expires = str(c.flags, "expires");
      const { success } = await tab.send("Network.setCookie", {
        name,
        value,
        url: str(c.flags, "domain") ? undefined : url,
        domain: str(c.flags, "domain"),
        path: str(c.flags, "path"),
        secure: bool(c.flags, "secure") || undefined,
        httpOnly: bool(c.flags, "http-only") || undefined,
        sameSite: str(c.flags, "same-site") as Protocol.Network.CookieSameSite | undefined,
        expires: expires ? Number(expires) : undefined,
      });
      if (!success) throw new CliError("cookie_failed", "Chrome rejected the cookie");
      return { text: `set cookie ${name}` };
    }
    await tab.send("Network.deleteCookies", {
      name,
      url: str(c.flags, "domain") ? undefined : url,
      domain: str(c.flags, "domain"),
      path: str(c.flags, "path"),
    });
    return { text: `deleted cookie ${name}` };
  },

  async storage(c) {
    const sub = oneOf(c.args[0] ?? "get", ["get", "set", "clear"] as const, "storage action");
    const area = oneOf(str(c.flags, "area") ?? "local", ["local", "session"] as const, "--area");
    const store = `${area}Storage`;
    const tab = await getTab(c);
    if (sub === "get") {
      const key = c.args[1];
      const value = key
        ? await evaluate(tab, `${store}.getItem(${JSON.stringify(key)})`)
        : await evaluate(tab, `Object.fromEntries(Object.entries(${store}))`);
      return { text: untrusted(typeof value === "string" ? value : JSON.stringify(value, null, 2)), data: { value } };
    }
    if (sub === "set") {
      const key = arg(c, 1, "KEY");
      const value = arg(c, 2, "VALUE");
      await evaluate(tab, `${store}.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`);
      return { text: `set ${area}Storage[${JSON.stringify(key)}]` };
    }
    await evaluate(tab, `${store}.clear()`);
    return { text: `cleared ${area}Storage` };
  },

  async click(c) {
    const ref = arg(c, 0, "REF");
    const tab = await getTab(c);
    const id = await resolveElement(tab, ref);
    let note = "";
    const nav = await withNavWatch(tab, async () => {
      note = await clickElement(tab, id, bool(c.flags, "double") ? 2 : 1);
    });
    return { text: `clicked ${ref}${note}${nav}` };
  },

  async hover(c) {
    const ref = arg(c, 0, "REF");
    const tab = await getTab(c);
    const id = await resolveElement(tab, ref);
    if (await isHidden(tab)) {
      await callOn(tab, id, SYNTHETIC_HOVER_FN);
      return { text: `hovering ${ref}${SYNTHETIC_NOTE}` };
    }
    const { x, y } = await centerOf(tab, id);
    await tab.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    return { text: `hovering ${ref}` };
  },

  async focus(c) {
    const ref = arg(c, 0, "REF");
    const tab = await getTab(c);
    await tab.send("DOM.focus", { objectId: await resolveElement(tab, ref) });
    return { text: `focused ${ref}` };
  },

  async clear(c) {
    const ref = arg(c, 0, "REF");
    const tab = await getTab(c);
    const id = await resolveElement(tab, ref);
    const kind = await callOn<string>(tab, id, FILL_KIND_FN);
    if (kind !== "text" && kind !== "editable") throw new CliError("not_fillable", "element is not a text field");
    await callOn(tab, id, CLEAR_FN);
    return { text: `cleared ${ref}` };
  },

  async check(c) {
    const ref = arg(c, 0, "REF");
    const tab = await getTab(c);
    await setChecked(tab, await resolveElement(tab, ref), true);
    return { text: `checked ${ref}` };
  },

  async uncheck(c) {
    const ref = arg(c, 0, "REF");
    const tab = await getTab(c);
    await setChecked(tab, await resolveElement(tab, ref), false);
    return { text: `unchecked ${ref}` };
  },

  async fill(c) {
    const ref = arg(c, 0, "REF");
    const value = arg(c, 1, "VALUE");
    const tab = await getTab(c);
    const msg = await fillElement(tab, await resolveElement(tab, ref), value);
    return { text: `${ref}: ${msg}` };
  },

  async "fill-form"(c) {
    let spec: unknown;
    try {
      spec = JSON.parse(arg(c, 0, "JSON"));
    } catch (e) {
      if (e instanceof CliError) throw e;
      throw new CliError("bad_args", 'fill-form expects JSON like {"e3": "text", "e5": true, "e7": ["a", "b"]}');
    }
    const entries: [string, unknown][] = Array.isArray(spec)
      ? spec.map((f: { ref: string; value: unknown }) => [f.ref, f.value])
      : Object.entries(spec as object);
    const tab = await getTab(c);
    const lines: string[] = [];
    for (const [ref, value] of entries) {
      const id = await resolveElement(tab, ref);
      if (typeof value === "boolean") {
        await setChecked(tab, id, value);
        lines.push(`${ref}: ${value ? "checked" : "unchecked"}`);
      } else if (Array.isArray(value)) {
        const picked = await callOn<string[]>(tab, id, SELECT_FN, value.map(String));
        lines.push(`${ref}: selected ${JSON.stringify(picked)}`);
      } else {
        lines.push(`${ref}: ${await fillElement(tab, id, String(value ?? ""))}`);
      }
    }
    return { text: lines.join("\n") };
  },

  async press(c) {
    const key = arg(c, 0, "KEY");
    const tab = await getTab(c);
    const ref = str(c.flags, "ref");
    if (ref) await tab.send("DOM.focus", { objectId: await resolveElement(tab, ref) });
    const nav = await withNavWatch(tab, () => pressCombo(tab, key));
    return { text: `pressed ${key}${nav}` };
  },

  async scroll(c) {
    const dir = oneOf(str(c.flags, "direction") ?? "down", ["up", "down", "left", "right"] as const, "--direction");
    const amount = num(c.flags, "amount", 600);
    const tab = await getTab(c);
    const ref = str(c.flags, "ref");
    const id = ref ? await resolveElement(tab, ref) : undefined;
    const deltaX = dir === "left" ? -amount : dir === "right" ? amount : 0;
    const deltaY = dir === "up" ? -amount : dir === "down" ? amount : 0;
    let note = "";
    if (await isHidden(tab)) {
      const fn = SYNTHETIC_SCROLL_EXPR(deltaX, deltaY, !!id);
      if (id) await callOn(tab, id, fn);
      else await evaluate(tab, `(${fn}).call(null)`);
      note = SYNTHETIC_NOTE;
    } else {
      const pt = id
        ? await centerOf(tab, id)
        : await evaluate<{ x: number; y: number }>(tab, "({ x: innerWidth / 2, y: innerHeight / 2 })");
      await tab.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: pt.x, y: pt.y, deltaX, deltaY });
      await sleep(200);
    }
    const pos = await evaluate<{ x: number; y: number; h: number }>(
      tab,
      "({ x: Math.round(scrollX), y: Math.round(scrollY), h: document.documentElement.scrollHeight - innerHeight })",
    );
    return { text: `scrolled ${dir} ${amount}px${note}; page scroll position ${pos.x},${pos.y} of max ${pos.h}`, data: pos };
  },

  async select(c) {
    const ref = arg(c, 0, "REF");
    const values = c.args.slice(1);
    if (!values.length) throw new CliError("bad_args", "missing VALUE");
    const tab = await getTab(c);
    const picked = await callOn<string[]>(tab, await resolveElement(tab, ref), SELECT_FN, values);
    if (!picked.length) throw new CliError("not_found", `no option matching ${JSON.stringify(values)}`);
    return { text: `${ref}: selected ${JSON.stringify(picked)}`, data: picked };
  },

  async upload(c) {
    const ref = arg(c, 0, "REF");
    const files = list(c.flags, "files");
    if (!files.length) throw new CliError("bad_args", "missing --files PATH...");
    const tab = await getTab(c);
    await tab.send("DOM.setFileInputFiles", { files, objectId: await resolveElement(tab, ref) });
    return { text: `${ref}: attached ${files.length} file(s)` };
  },

  async dialog(c) {
    const tab = await getTab(c, { allowDialog: true });
    const sub = c.args[0] ?? "status";
    if (sub === "status") {
      return tab.dialog
        ? { text: untrusted(`${tab.dialog.type}: ${tab.dialog.message}`), data: tab.dialog }
        : { text: "no dialog open", data: null };
    }
    const action = oneOf(sub, ["accept", "dismiss"] as const, "dialog action");
    if (!tab.dialog) throw new CliError("no_dialog", "no JavaScript dialog is open");
    const { type } = tab.dialog;
    await tab.send("Page.handleJavaScriptDialog", { accept: action === "accept", promptText: str(c.flags, "text") });
    return { text: `${action === "accept" ? "accepted" : "dismissed"} ${type}` };
  },

  async eval(c) {
    const script = arg(c, 0, "SCRIPT");
    const tab = await getTab(c);
    const call = tab.send(
      "Runtime.evaluate",
      { expression: script, returnByValue: true, awaitPromise: true, userGesture: true, replMode: true },
      num(c.flags, "timeout", DEFAULT_WAIT_TIMEOUT),
    );
    if (await raceDialog(tab, call)) return { text: `script is blocked by a dialog${dialogNote(tab)}`, data: { dialog: tab.dialog } };
    const r = await call;
    if (r.exceptionDetails) throw jsError(r.exceptionDetails);
    const value = r.result.value;
    const text = r.result.type === "undefined" ? "undefined" : typeof value === "string" ? value : value !== undefined ? JSON.stringify(value, null, 2) : formatRemote(r.result);
    return { text: untrusted(text), data: { value } };
  },

  async resize(c) {
    const width = Number(arg(c, 0, "WIDTH"));
    const height = Number(arg(c, 1, "HEIGHT"));
    if (!(width > 0 && height > 0)) throw new CliError("bad_args", "WIDTH and HEIGHT must be positive numbers");
    const tab = await getTab(c);
    const conn = await c.browser.connection();
    const { windowId } = await conn.send("Browser.getWindowForTarget", { targetId: tab.targetId });
    await conn.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
    await conn.send("Browser.setWindowBounds", { windowId, bounds: { width, height } });
    return { text: `resized window to ${width}x${height}` };
  },

  async record(c) {
    const sub = c.args[0] ?? "status";
    const rec = c.browser.recorder;
    if (sub === "start") {
      if (rec) {
        throw new CliError("already_recording", `already recording tab ${shortId(rec.tab.targetId)}; run \`browsercli record stop\` first`);
      }
      let url = c.args[1] ?? str(c.flags, "url");
      if (!url && c.browser.currentTargetId) {
        const cur = await c.browser.tab(await c.browser.resolveTarget()).catch(() => undefined);
        if (cur) url = (await pageInfo(cur)).url;
      }
      url = normalizeUrl(url || "about:blank");
      // A separate, visible window: Chrome doesn't paint background tabs.
      const conn = await c.browser.connection();
      const { targetId } = await conn.send("Target.createTarget", { url, newWindow: true });
      c.browser.currentTargetId = targetId;
      const tab = await c.browser.tab(targetId);
      const size = str(c.flags, "size");
      if (size) {
        const [width, height] = size.split("x").map(Number);
        if (!(width > 0 && height > 0)) throw new CliError("bad_args", "--size must look like 1280x800");
        const { windowId } = await conn.send("Browser.getWindowForTarget", { targetId });
        await conn.send("Browser.setWindowBounds", { windowId, bounds: { width, height } });
      }
      await waitForInitialLoad(tab, url, num(c.flags, "timeout", DEFAULT_WAIT_TIMEOUT));
      const maxSeconds = num(c.flags, "max-seconds", 120);
      const recorder = new Recorder(tab, {
        fps: Math.min(30, Math.max(1, num(c.flags, "fps", 5))),
        maxSeconds,
        rawDir: join(HOME, "recordings", `.raw-${Date.now()}`),
      });
      await recorder.start();
      c.browser.recorder = recorder;
      return {
        text:
          `recording tab ${shortId(targetId)} in a new window (now selected): ${(await pageInfo(tab)).url}\n` +
          "Reproduce the issue (by hand or with browsercli commands), then run `browsercli record stop [--out DIR]`.\n" +
          `Keep the window visible: Chrome doesn't paint covered or minimized windows. Auto-stops after ${maxSeconds}s.`,
        data: { id: shortId(targetId), targetId },
      };
    }
    if (sub === "stop") {
      if (!rec) throw new CliError("not_recording", "no recording in progress; start one with `browsercli record start [URL]`");
      await rec.halt();
      const stamp = new Date(rec.startedAt).toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const dir = str(c.flags, "out") ?? join(HOME, "recordings", stamp);
      const s = rec.finalize(dir, num(c.flags, "max-frames", 40));
      c.browser.recorder = undefined;
      if (bool(c.flags, "close")) {
        const conn = await c.browser.connection();
        await c.browser.detach(rec.tab.targetId);
        await conn.send("Target.closeTarget", { targetId: rec.tab.targetId }).catch(() => {});
        if (c.browser.currentTargetId === rec.tab.targetId) c.browser.currentTargetId = undefined;
      }
      const lines = [
        `saved recording to ${dir}`,
        `  timeline.md   ${s.events} events (${s.errors} errors), ${(s.durationMs / 1000).toFixed(1)}s`,
        `  frames/       ${s.keyFrames.length} key frames (of ${s.capturedFrames} captured)`,
        s.video ? `  video.mp4` : `  no video: ${s.videoError ?? "no frames captured"}`,
      ];
      if (!s.capturedFrames) lines.push("no frames were captured: keep the recording window visible (not covered or minimized)");
      return { text: lines.join("\n"), data: s };
    }
    if (sub === "status") {
      if (!rec) return { text: "not recording", data: null };
      const secs = ((rec.stoppedAt ?? Date.now()) - rec.startedAt) / 1000;
      const state = rec.active ? "recording" : `stopped (${rec.stopReason}), run \`browsercli record stop\` to save`;
      return {
        text: `${state}: tab ${shortId(rec.tab.targetId)}, ${secs.toFixed(1)}s, ${rec.frames.length} frames, ${rec.events.length} events`,
        data: { active: rec.active, seconds: secs, frames: rec.frames.length, events: rec.events.length },
      };
    }
    throw new CliError("bad_args", "usage: browsercli record start [URL] | stop [--out DIR] | status");
  },

  async cdp(c) {
    const method = arg(c, 0, "METHOD");
    let params: unknown;
    if (c.args[1]) {
      try {
        params = JSON.parse(c.args[1]);
      } catch {
        throw new CliError("bad_args", "PARAMS must be JSON");
      }
    }
    let result: unknown;
    if (bool(c.flags, "browser")) {
      const conn = await c.browser.connection();
      result = await conn.sendRaw(method, params);
    } else {
      const tab = await getTab(c, { allowDialog: true });
      result = await tab.sendRaw(method, params, num(c.flags, "timeout", DEFAULT_WAIT_TIMEOUT));
    }
    return { text: untrusted(JSON.stringify(result, null, 2)), data: result };
  },

  async wait(c) {
    const timeout = num(c.flags, "timeout", DEFAULT_WAIT_TIMEOUT);
    const hidden = (str(c.flags, "state") ?? "visible") === "hidden";
    let expr: string;
    let what: string;
    const text = str(c.flags, "text");
    const selector = str(c.flags, "selector");
    const url = str(c.flags, "url");
    const fn = str(c.flags, "fn");
    if (text !== undefined) {
      expr = `(document.body ? document.body.innerText : "").includes(${JSON.stringify(text)})`;
      what = `text ${JSON.stringify(text)}`;
    } else if (selector !== undefined) {
      expr = `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        const s = getComputedStyle(el);
        return el.getClientRects().length > 0 && s.visibility !== "hidden" && s.display !== "none";
      })()`;
      what = `selector ${selector}`;
    } else if (url !== undefined) {
      const re = "^" + url.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$";
      expr = url.includes("*")
        ? `new RegExp(${JSON.stringify(re)}).test(location.href)`
        : `location.href.includes(${JSON.stringify(url)})`;
      what = `url ${url}`;
    } else if (bool(c.flags, "load")) {
      expr = `document.readyState === "complete"`;
      what = "page load";
    } else if (fn !== undefined) {
      // Accepts an expression or a function (sync or async) returning a truthy value.
      expr = `(async () => { const v = (${fn}); return !!(typeof v === "function" ? await v() : await v); })()`;
      what = "function";
    } else {
      throw new CliError("bad_args", "wait needs one of --text, --selector, --url, --load, --fn");
    }
    if (hidden) expr = `!(${expr})`;
    const tab = await getTab(c);
    const deadline = Date.now() + timeout;
    while (true) {
      if (tab.dialog) throw new CliError("dialog_open", `a ${tab.dialog.type} dialog opened while waiting; run \`browsercli dialog accept|dismiss\``);
      const ok = await evaluate<boolean>(tab, expr, 5_000).catch((e) => {
        if (e instanceof CliError && e.code === "js_error") throw e;
        return false; // context destroyed during navigation etc.
      });
      if (ok) return { text: `ok: ${what}${hidden ? " is gone" : ""}` };
      if (Date.now() > deadline) throw new CliError("timeout", `timed out after ${timeout}ms waiting for ${what}${hidden ? " to disappear" : ""}`);
      await sleep(100);
    }
  },
};

async function history(c: Ctx, delta: number): Promise<Output> {
  const tab = await getTab(c);
  const { currentIndex, entries } = await tab.send("Page.getNavigationHistory");
  const entry = entries[currentIndex + delta];
  if (!entry) throw new CliError("no_history", `no ${delta < 0 ? "previous" : "next"} page in history`);
  const loaded = await navigateAndWait(
    tab,
    async () => void (await tab.send("Page.navigateToHistoryEntry", { entryId: entry.id })),
    num(c.flags, "timeout", DEFAULT_WAIT_TIMEOUT),
  );
  const info = await pageInfo(tab);
  return { text: `${delta < 0 ? "back" : "forward"} to ${info.url} — ${JSON.stringify(info.title)}${loaded ? "" : " (still loading)"}` };
}

