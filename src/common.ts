import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
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
  session: string;
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

// Programs that sit between an agent and browsercli for a single command;
// the session belongs to whatever launched them.
const PASSTHROUGH = new Set([
  "sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "pwsh", "nu",
  "env", "timeout", "gtimeout", "nice", "nohup", "time", "xargs", "sudo", "script", "sandbox-exec",
  "npm", "npx", "pnpm", "bun", "bunx", "yarn", "node",
]);

// Each caller gets its own selected tab and recording. Without an explicit
// --session or $BROWSERCLI_SESSION, the session is the nearest ancestor that
// isn't a shell or wrapper: the agent process (or terminal) issuing commands,
// which outlives the per-command shells it spawns.
export function sessionId(flag?: string): string {
  if (flag) return flag;
  if (process.env.BROWSERCLI_SESSION) return process.env.BROWSERCLI_SESSION;
  return processSession() ?? "default";
}

function processSession(): string | undefined {
  if (process.platform === "win32") return undefined;
  let out: string;
  try {
    out = execFileSync("ps", ["-axo", "pid=,ppid=,lstart=,comm="], { encoding: "utf8", timeout: 2000 });
  } catch {
    return undefined;
  }
  const procs = new Map<number, { ppid: number; start: string; name: string }>();
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.+)$/.exec(line);
    if (m) procs.set(Number(m[1]), { ppid: Number(m[2]), start: m[3], name: basename(m[4].trim()).replace(/^-/, "") });
  }
  let pid = process.ppid;
  for (let depth = 0; depth < 32 && pid > 1; depth++) {
    const p = procs.get(pid);
    if (!p) return undefined;
    if (!PASSTHROUGH.has(p.name.toLowerCase())) {
      // Start time guards against PID reuse.
      const id = createHash("sha256").update(`${pid} ${p.start}`).digest("hex").slice(0, 6);
      return `${p.name}-${pid}-${id}`;
    }
    pid = p.ppid;
  }
  return undefined;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const UNTRUSTED_OPEN = "<untrusted-page-content>";
const UNTRUSTED_CLOSE = "</untrusted-page-content>";

// Page-derived text is wrapped so agents treat it as data, never instructions.
export function untrusted(s: string): string {
  const body = s.replaceAll(UNTRUSTED_CLOSE, "<\\/untrusted-page-content>");
  return `${UNTRUSTED_OPEN}\n${body}\n${UNTRUSTED_CLOSE}`;
}
