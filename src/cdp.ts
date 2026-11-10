// Minimal Chrome DevTools Protocol client using flat sessions over a single
// browser-level WebSocket.
import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping.js";
import { CliError } from "./common.js";

export type Commands = ProtocolMapping.Commands;
export type Method = keyof Commands;
export type Params<M extends Method> = Commands[M]["paramsType"][0];
export type Result<M extends Method> = Commands[M]["returnType"];

export interface CDPEvent {
  method: string;
  params: any;
  sessionId?: string;
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  method: string;
  timer: NodeJS.Timeout;
}

export const DEFAULT_CALL_TIMEOUT = 30_000;

export class CDPConnection {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Set<(e: CDPEvent) => void>();
  private closeHandlers = new Set<() => void>();
  closed = false;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => this.onMessage(ev.data));
    ws.addEventListener("close", () => this.onClose());
  }

  static connect(url: string, timeoutMs: number): Promise<CDPConnection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        ws.close();
        reject(
          new CliError(
            "connect_timeout",
            `timed out connecting to ${url}.\nIf Chrome shows an "Allow remote debugging?" prompt, click Allow and retry.`,
          ),
        );
      }, timeoutMs);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(new CDPConnection(ws));
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new CliError("connect_failed", `could not connect to ${url} (was the remote debugging prompt denied?)`));
      });
    });
  }

  private onMessage(data: unknown) {
    let msg: any;
    try {
      msg = JSON.parse(typeof data === "string" ? data : Buffer.from(data as ArrayBuffer).toString("utf8"));
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        p.reject(new CliError("cdp_error", `${p.method}: ${msg.error.message}${msg.error.data ? ` (${msg.error.data})` : ""}`));
      } else {
        p.resolve(msg.result ?? {});
      }
      return;
    }
    const ev: CDPEvent = { method: msg.method, params: msg.params ?? {}, sessionId: msg.sessionId };
    for (const l of this.listeners) {
      try {
        l(ev);
      } catch (e) {
        console.error("event listener failed:", e);
      }
    }
  }

  private onClose() {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new CliError("disconnected", "connection to the browser was closed"));
    }
    this.pending.clear();
    for (const h of this.closeHandlers) h();
  }

  on(listener: (e: CDPEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onClosed(h: () => void) {
    this.closeHandlers.add(h);
  }

  send<M extends Method>(
    method: M,
    params?: Params<M>,
    sessionId?: string,
    timeoutMs = DEFAULT_CALL_TIMEOUT,
  ): Promise<Result<M>> {
    return this.sendRaw(method, params, sessionId, timeoutMs);
  }

  sendRaw(method: string, params?: unknown, sessionId?: string, timeoutMs = DEFAULT_CALL_TIMEOUT): Promise<any> {
    if (this.closed) return Promise.reject(new CliError("disconnected", "connection to the browser was closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CliError("timeout", `${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, method, timer });
      const msg: Record<string, unknown> = { id, method };
      if (params !== undefined) msg.params = params;
      if (sessionId) msg.sessionId = sessionId;
      this.ws.send(JSON.stringify(msg));
    });
  }

  close() {
    this.ws.close();
    this.onClose();
  }
}
