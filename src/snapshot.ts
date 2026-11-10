// Renders Chrome's accessibility tree as a compact, ref-annotated outline:
//   - [@e3] button "Submit" [disabled]
import type { Protocol } from "devtools-protocol";
import type { Tab } from "./browser.js";

type AXNode = Protocol.Accessibility.AXNode;

export const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "switch",
  "slider",
  "spinbutton",
  "treeitem",
  "textarea",
]);

// Wrapper roles that add nesting but no meaning when unnamed.
const TRANSPARENT_ROLES = new Set([
  "generic",
  "none",
  "presentation",
  "paragraph",
  "group",
  "Section",
  "LayoutTable",
  "LayoutTableRow",
  "LayoutTableCell",
  "Div",
  "Pre",
  "Abbr",
  "Mark",
  "Time",
  "DescriptionListDetail",
  "superscript",
  "subscript",
  "emphasis",
  "strong",
  "LabelText",
  "MenuListPopup",
]);

const TEXT_ROLES = new Set(["StaticText", "text"]);
const SKIP_ROLES = new Set(["InlineTextBox", "LineBreak", "ListMarker"]);
const MAX_TEXT = 300;

export interface SnapshotOptions {
  interactiveOnly?: boolean;
  maxDepth?: number;
  rootBackendNodeId?: number;
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const quote = (s: string) => JSON.stringify(s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + "…" : s);

function axValue(v?: Protocol.Accessibility.AXValue): string {
  if (!v || v.value === undefined || v.value === null) return "";
  return clean(String(v.value));
}

function stateTags(n: AXNode): string[] {
  const tags: string[] = [];
  for (const p of n.properties ?? []) {
    const v = p.value.value;
    switch (p.name) {
      case "checked":
      case "pressed":
        if (v === "true" || v === true) tags.push(p.name);
        else if (v === "mixed") tags.push(`${p.name}=mixed`);
        break;
      case "disabled":
      case "selected":
      case "focused":
      case "required":
      case "readonly":
      case "modal":
        if (v) tags.push(p.name);
        break;
      case "expanded":
        tags.push(v ? "expanded" : "collapsed");
        break;
      case "level":
        tags.push(`level=${v}`);
        break;
    }
  }
  return tags;
}

// True when Chrome computed the element's name from its text content (e.g.
// <button><span>2025</span><span>Folder</span></button> -> "2025 Folder").
function nameFromContents(n: AXNode): boolean {
  const src = n.name?.sources?.find((s) => s.value && !s.superseded);
  return src?.type === "contents";
}

export function lineFor(n: AXNode, ref: string | undefined): string {
  const role = n.role?.value ?? "unknown";
  const name = axValue(n.name);
  let line = `${ref ? `[@${ref}] ` : ""}${role}`;
  if (name) line += ` ${quote(name)}`;
  const value = axValue(n.value);
  if (value && value !== name) line += ` value=${quote(value)}`;
  const tags = stateTags(n);
  if (tags.length) line += ` [${tags.join(", ")}]`;
  return line;
}

export function renderSnapshot(tab: Tab, nodes: AXNode[], opts: SnapshotOptions): string[] {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  let root: AXNode | undefined = nodes[0];
  if (opts.rootBackendNodeId !== undefined) {
    root = nodes.find((n) => n.backendDOMNodeId === opts.rootBackendNodeId);
  }
  if (!root) return [];
  const lines: string[] = [];
  const maxDepth = opts.maxDepth ?? Infinity;

  const children = (n: AXNode) => (n.childIds ?? []).map((id) => byId.get(id)).filter((c): c is AXNode => !!c);

  // Text already shown on an ancestor's line is skipped: exact matches of the
  // parent's name/value, and any part of a name built from its contents.
  interface Shown {
    exact: string[];
    contents: string;
  }
  const walk = (n: AXNode, depth: number, shown: Shown) => {
    const role = n.role?.value ?? "";
    if (SKIP_ROLES.has(role)) return;
    const name = axValue(n.name);
    if (n.ignored) {
      for (const c of children(n)) walk(c, depth, shown);
      return;
    }
    if (TEXT_ROLES.has(role)) {
      const redundant = shown.exact.includes(name) || shown.contents.includes(name);
      if (!opts.interactiveOnly && name && !redundant && depth <= maxDepth) {
        lines.push(`${"  ".repeat(depth)}- text ${quote(name)}`);
      }
      return;
    }
    const interactive = INTERACTIVE_ROLES.has(role);
    if (!interactive && !name && TRANSPARENT_ROLES.has(role)) {
      for (const c of children(n)) walk(c, depth, shown);
      return;
    }
    const own: Shown = { exact: [name, axValue(n.value)], contents: nameFromContents(n) ? name : shown.contents };
    const isRoot = role === "RootWebArea";
    const ref = !isRoot && n.backendDOMNodeId !== undefined ? tab.refFor(n.backendDOMNodeId) : undefined;
    if (opts.interactiveOnly) {
      if (interactive) lines.push(`- ${lineFor(n, ref)}`);
      for (const c of children(n)) walk(c, depth, own);
      return;
    }
    if (depth > maxDepth) return;
    lines.push(`${"  ".repeat(depth)}- ${lineFor(n, ref)}`);
    for (const c of children(n)) walk(c, depth + 1, own);
  };
  walk(root, 0, { exact: [], contents: "" });
  return lines;
}

export interface FindMatch {
  ref: string;
  line: string;
}

export function findNodes(tab: Tab, nodes: AXNode[], query: string, by: "text" | "role", limit = 50): FindMatch[] {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const q = query.toLowerCase();
  const out: FindMatch[] = [];
  const seen = new Set<number>();
  const add = (n: AXNode) => {
    if (n.backendDOMNodeId === undefined || seen.has(n.backendDOMNodeId) || out.length >= limit) return;
    seen.add(n.backendDOMNodeId);
    const ref = tab.refFor(n.backendDOMNodeId);
    out.push({ ref, line: lineFor(n, ref) });
  };
  // Nearest non-ignored, non-text ancestor, so text hits resolve to clickable elements.
  const elementFor = (n: AXNode): AXNode | undefined => {
    let cur: AXNode | undefined = n.parentId ? byId.get(n.parentId) : undefined;
    while (cur && (cur.ignored || TEXT_ROLES.has(cur.role?.value ?? "") || (TRANSPARENT_ROLES.has(cur.role?.value ?? "") && !axValue(cur.name)))) {
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return cur;
  };
  for (const n of nodes) {
    if (n.ignored) continue;
    const role = n.role?.value ?? "";
    if (role === "RootWebArea" || SKIP_ROLES.has(role)) continue;
    if (by === "role") {
      if (role.toLowerCase() === q) add(n);
      continue;
    }
    if (!axValue(n.name).toLowerCase().includes(q)) continue;
    if (TEXT_ROLES.has(role)) {
      const el = elementFor(n);
      if (el && el.role?.value !== "RootWebArea") add(el);
    } else {
      add(n);
    }
  }
  return out;
}

// Line diff (LCS) between two snapshots; falls back to set difference when large.
export function diffLines(a: string[], b: string[]): string[] {
  if (a.length * b.length > 4_000_000) {
    const as = new Set(a);
    const bs = new Set(b);
    return [...a.filter((l) => !bs.has(l)).map((l) => `- ${l}`), ...b.filter((l) => !as.has(l)).map((l) => `+ ${l}`)];
  }
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push(`- ${a[i++]}`);
    } else {
      out.push(`+ ${b[j++]}`);
    }
  }
  while (i < n) out.push(`- ${a[i++]}`);
  while (j < m) out.push(`+ ${b[j++]}`);
  return out;
}
