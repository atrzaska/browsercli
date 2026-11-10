import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { statSync } from "node:fs";

export class CliError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export type Flags = Record<string, string | boolean | string[]>;

export interface Request {
  verb: string;
  args: string[];
  flags: Flags;
  stamp: string;
}

export interface Capture {
  base64: string;
  ext: string;
}

export interface Response {
  ok: boolean;
  text?: string;
  data?: unknown;
  capture?: Capture;
  error?: { code: string; message: string };
}

export const HOME = process.env.BROWSERCLI_HOME ?? join(homedir(), ".browsercli");
export const SOCKET_PATH = socketPath();

function socketPath(): string {
  const id = createHash("sha256").update(HOME).digest("hex").slice(0, 12);
  if (process.platform === "win32") return `\\\\.\\pipe\\browsercli-${id}`;
  const p = join(HOME, "daemon.sock");
  // Unix socket paths are limited to ~104 bytes.
  return p.length < 100 ? p : join(tmpdir(), `browsercli-${id}.sock`);
}

export const LOG_PATH = join(HOME, "daemon.log");
export const STATE_PATH = join(HOME, "state.json");

// Identifies the build so the client can restart a daemon running stale code.
export function buildStamp(): string {
  try {
    return String(statSync(process.argv[1]).mtimeMs);
  } catch {
    return "unknown";
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const UNTRUSTED_OPEN = "<untrusted-page-content>";
const UNTRUSTED_CLOSE = "</untrusted-page-content>";

// Page-derived text is wrapped so agents treat it as data, never instructions.
export function untrusted(s: string): string {
  const body = s.replaceAll(UNTRUSTED_CLOSE, "<\\/untrusted-page-content>");
  return `${UNTRUSTED_OPEN}\n${body}\n${UNTRUSTED_CLOSE}`;
}
