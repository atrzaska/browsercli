// Long-lived browser state held by the daemon: the CDP connection, attached
// tabs and their buffered console/network/dialog events and element refs.
import type { Protocol } from "devtools-protocol";
import { CDPConnection, DEFAULT_CALL_TIMEOUT, type CDPEvent, type Method, type Params, type Result } from "./cdp.js";
import { readFileSync, writeFileSync } from "node:fs";
import { CliError, STATE_PATH } from "./common.js";
import { discoverEndpoint, type ConnectOpts } from "./discover.js";
import type { Recorder } from "./recorder.js";

const BUFFER_LIMIT = 1000;
const CONNECT_TIMEOUT = 60_000;

export interface ConsoleEntry {
  time: number;
  level: string;
  text: string;
  url?: string;
}

export interface NetworkEntry {
  time: number;
  requestId: string;
  method: string;
  url: string;
  type?: string;
  status?: number;
  mimeType?: string;
  failed?: string;
}

export type Dialog = Protocol.Page.JavascriptDialogOpeningEvent;

export class Tab {
  readonly targetId: string;
  readonly sessionId: string;
  private conn: CDPConnection;
  private listeners = new Set<(e: CDPEvent) => void>();

  console: ConsoleEntry[] = [];
  network: NetworkEntry[] = [];
  private networkById = new Map<string, NetworkEntry>();
  dialog?: Dialog;
  mainFrameId = "";

  // Refs stay stable for a document's lifetime and are dropped on navigation.
  refs = new Map<string, number>();
  private nodeRefs = new Map<number, string>();
  private nextRef = 1;
  lastSnapshots = new Map<string, string[]>(); // keyed by snapshot options, for --diff

  constructor(conn: CDPConnection, targetId: string, sessionId: string) {
    this.conn = conn;
    this.targetId = targetId;
    this.sessionId = sessionId;
  }

  send<M extends Method>(method: M, params?: Params<M>, timeoutMs = DEFAULT_CALL_TIMEOUT): Promise<Result<M>> {
    return this.conn.send(method, params, this.sessionId, timeoutMs);
  }

  sendRaw(method: string, params?: unknown, timeoutMs = DEFAULT_CALL_TIMEOUT): Promise<any> {
    return this.conn.sendRaw(method, params, this.sessionId, timeoutMs);
  }

  onEvent(l: (e: CDPEvent) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  refFor(backendNodeId: number): string {
    let ref = this.nodeRefs.get(backendNodeId);
    if (!ref) {
      ref = `e${this.nextRef++}`;
      this.nodeRefs.set(backendNodeId, ref);
      this.refs.set(ref, backendNodeId);
    }
    return ref;
  }

  invalidateRefs() {
    this.refs.clear();
    this.nodeRefs.clear();
    this.lastSnapshots.clear();
  }

  // Extension content scripts (password managers, wallets…) log into every
  // page; that noise isn't the page's own output.
  private pushConsole(entry: ConsoleEntry) {
    if (entry.url?.startsWith("chrome-extension://")) return;
    this.push(this.console, entry);
  }

  private push<T>(arr: T[], item: T): T | undefined {
    arr.push(item);
    return arr.length > BUFFER_LIMIT ? arr.shift() : undefined;
  }

  handleEvent(e: CDPEvent) {
    const p = e.params;
    switch (e.method) {
      case "Runtime.consoleAPICalled":
        this.pushConsole({
          time: p.timestamp,
          level: p.type,
          text: (p.args as Protocol.Runtime.RemoteObject[]).map(formatRemote).join(" "),
          url: p.stackTrace?.callFrames?.[0]?.url,
        });
        break;
      case "Runtime.exceptionThrown": {
        const d = p.exceptionDetails as Protocol.Runtime.ExceptionDetails;
        this.pushConsole({
          time: p.timestamp,
          level: "error",
          text: d.exception?.description ?? d.text,
          url: d.url,
        });
        break;
      }
      case "Log.entryAdded":
        this.pushConsole({ time: p.entry.timestamp, level: p.entry.level, text: p.entry.text, url: p.entry.url });
        break;
      case "Network.requestWillBeSent": {
        const prev = this.networkById.get(p.requestId);
        if (prev && p.redirectResponse) prev.status = p.redirectResponse.status;
        const entry: NetworkEntry = {
          time: p.wallTime ? p.wallTime * 1000 : Date.now(),
          requestId: p.requestId,
          method: p.request.method,
          url: p.request.url,
          type: p.type,
        };
        this.networkById.set(p.requestId, entry);
        const dropped = this.push(this.network, entry);
        if (dropped && this.networkById.get(dropped.requestId) === dropped) this.networkById.delete(dropped.requestId);
        break;
      }
      case "Network.responseReceived": {
        const ent = this.networkById.get(p.requestId);
        if (ent) {
          ent.status = p.response.status;
          ent.mimeType = p.response.mimeType;
        }
        break;
      }
      case "Network.loadingFailed": {
        const ent = this.networkById.get(p.requestId);
        if (ent) ent.failed = p.canceled ? "canceled" : p.errorText;
        break;
      }
      case "Page.javascriptDialogOpening":
        this.dialog = p;
        break;
      case "Page.javascriptDialogClosed":
        this.dialog = undefined;
        break;
      case "Page.frameNavigated":
        if (!p.frame.parentId) {
          this.mainFrameId = p.frame.id;
          this.invalidateRefs();
        }
        break;
    }
    for (const l of this.listeners) l(e);
  }
}

export function formatRemote(o: Protocol.Runtime.RemoteObject): string {
  if (o.type === "string") return o.value;
  if (o.unserializableValue) return o.unserializableValue;
  if (o.type === "undefined") return "undefined";
  if ("value" in o) return JSON.stringify(o.value);
  if (o.preview?.properties) {
    const props = o.preview.properties.map((p) => `${p.name}: ${p.value ?? p.type}`).join(", ");
    return o.subtype === "array" ? `[${props}]` : `{${props}}`;
  }
  return o.description ?? o.type;
}

export interface PageTarget {
  targetId: string;
  id: string; // short id shown to users
  title: string;
  url: string;
}

export const shortId = (targetId: string) => targetId.slice(0, 8);

interface PersistedState {
  opts: ConnectOpts;
  currentTargetId?: string;
}

export class Browser {
  endpoint?: string;
  recorder?: Recorder;
  // Survives daemon restarts (e.g. after an upgrade).
  private state: PersistedState = { opts: {} };
  private conn?: CDPConnection;
  private connecting?: Promise<CDPConnection>;
  private tabs = new Map<string, Tab>();
  private bySession = new Map<string, Tab>();
  private attaching = new Map<string, Promise<Tab>>();

  constructor() {
    try {
      this.state = { opts: {}, ...JSON.parse(readFileSync(STATE_PATH, "utf8")) };
    } catch {}
  }

  private save() {
    try {
      writeFileSync(STATE_PATH, JSON.stringify(this.state, null, 2));
    } catch {}
  }

  get opts(): ConnectOpts {
    return this.state.opts;
  }
  set opts(o: ConnectOpts) {
    this.state.opts = o;
    this.save();
  }

  get currentTargetId(): string | undefined {
    return this.state.currentTargetId;
  }
  set currentTargetId(id: string | undefined) {
    if (this.state.currentTargetId === id) return;
    this.state.currentTargetId = id;
    this.save();
  }

  get connected() {
    return !!this.conn && !this.conn.closed;
  }

  async connection(): Promise<CDPConnection> {
    if (this.conn && !this.conn.closed) return this.conn;
    this.connecting ??= this.connect().finally(() => (this.connecting = undefined));
    return this.connecting;
  }

  private async connect(): Promise<CDPConnection> {
    const endpoint = await discoverEndpoint(this.opts);
    const conn = await CDPConnection.connect(endpoint, CONNECT_TIMEOUT);
    this.endpoint = endpoint;
    this.conn = conn;
    conn.on((e) => this.route(e));
    conn.onClosed(() => {
      if (this.conn === conn) this.conn = undefined;
      this.tabs.clear();
      this.bySession.clear();
    });
    return conn;
  }

  disconnect() {
    this.conn?.close();
    this.conn = undefined;
    this.tabs.clear();
    this.bySession.clear();
  }

  private route(e: CDPEvent) {
    if (e.sessionId) {
      this.bySession.get(e.sessionId)?.handleEvent(e);
      return;
    }
    if (e.method === "Target.detachedFromTarget") {
      const tab = this.bySession.get(e.params.sessionId);
      if (tab) {
        this.bySession.delete(tab.sessionId);
        this.tabs.delete(tab.targetId);
      }
    }
  }

  async pages(): Promise<PageTarget[]> {
    const conn = await this.connection();
    const { targetInfos } = await conn.send("Target.getTargets");
    return targetInfos
      .filter((t) => t.type === "page" && !t.url.startsWith("devtools://"))
      .map((t) => ({ targetId: t.targetId, id: shortId(t.targetId), title: t.title, url: t.url }));
  }

  // Resolves --tab (full or short id, case-insensitive prefix) or the current tab.
  async resolveTarget(idOrPrefix?: string): Promise<string> {
    const pages = await this.pages();
    if (idOrPrefix) {
      const q = idOrPrefix.toUpperCase();
      const matches = pages.filter((p) => p.targetId.toUpperCase().startsWith(q));
      if (matches.length === 1) return matches[0].targetId;
      if (matches.length > 1) throw new CliError("ambiguous_tab", `tab id "${idOrPrefix}" matches ${matches.length} tabs`);
      throw new CliError("tab_not_found", `no tab with id "${idOrPrefix}"; run \`browsercli tab list\``);
    }
    if (this.currentTargetId) {
      if (pages.some((p) => p.targetId === this.currentTargetId)) return this.currentTargetId;
      this.currentTargetId = undefined;
      throw new CliError(
        "no_tab_selected",
        "the selected tab was closed; run `browsercli tab list` then `browsercli tab switch ID`, or `browsercli open URL`",
      );
    }
    throw new CliError(
      "no_tab_selected",
      "no tab selected; run `browsercli tab list` then `browsercli tab switch ID`, `browsercli tab new URL`, or pass --tab ID",
    );
  }

  async tab(targetId: string): Promise<Tab> {
    const existing = this.tabs.get(targetId);
    if (existing) return existing;
    let p = this.attaching.get(targetId);
    if (!p) {
      p = this.attach(targetId).finally(() => this.attaching.delete(targetId));
      this.attaching.set(targetId, p);
    }
    return p;
  }

  private async attach(targetId: string): Promise<Tab> {
    const conn = await this.connection();
    const { sessionId } = await conn.send("Target.attachToTarget", { targetId, flatten: true });
    const tab = new Tab(conn, targetId, sessionId);
    this.tabs.set(targetId, tab);
    this.bySession.set(sessionId, tab);
    await Promise.all([
      tab.send("Page.enable"),
      tab.send("Runtime.enable"),
      tab.send("Network.enable"),
      tab.send("Log.enable"),
    ]);
    const { frameTree } = await tab.send("Page.getFrameTree");
    tab.mainFrameId = frameTree.frame.id;
    return tab;
  }

  async detach(targetId: string) {
    const tab = this.tabs.get(targetId);
    if (!tab) return;
    this.tabs.delete(targetId);
    this.bySession.delete(tab.sessionId);
    await this.conn?.send("Target.detachFromTarget", { sessionId: tab.sessionId }).catch(() => {});
  }
}
