// Locates the browser-level DevTools WebSocket endpoint of a running Chrome.
import { readFileSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { CliError } from "./common.js";

export interface ConnectOpts {
  ws?: string;
  port?: number;
  userDataDir?: string;
}

export function userDataDirs(): string[] {
  const home = homedir();
  switch (process.platform) {
    case "darwin": {
      const base = join(home, "Library", "Application Support");
      return [
        "Google/Chrome",
        "Google/Chrome Beta",
        "Google/Chrome Dev",
        "Google/Chrome Canary",
        "Chromium",
        "BraveSoftware/Brave-Browser",
        "Microsoft Edge",
        "Arc/User Data",
        "Vivaldi",
      ].map((d) => join(base, d));
    }
    case "win32": {
      const base = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
      return [
        "Google/Chrome/User Data",
        "Google/Chrome Beta/User Data",
        "Google/Chrome SxS/User Data",
        "Chromium/User Data",
        "BraveSoftware/Brave-Browser/User Data",
        "Microsoft/Edge/User Data",
      ].map((d) => join(base, d));
    }
    default: {
      const base = join(home, ".config");
      return [
        "google-chrome",
        "google-chrome-beta",
        "google-chrome-unstable",
        "chromium",
        "BraveSoftware/Brave-Browser",
        "microsoft-edge",
        "vivaldi",
      ].map((d) => join(base, d));
    }
  }
}

// Chrome writes <user-data-dir>/DevToolsActivePort (port, then browser ws path)
// when remote debugging is on, via --remote-debugging-port or the
// chrome://inspect/#remote-debugging toggle.
function readActivePort(dir: string): { ws: string; mtime: number } | undefined {
  const file = join(dir, "DevToolsActivePort");
  try {
    const [port, path] = readFileSync(file, "utf8").trim().split("\n").map((s) => s.trim());
    if (!port || !path) return undefined;
    return { ws: `ws://127.0.0.1:${port}${path}`, mtime: statSync(file).mtimeMs };
  } catch {
    return undefined;
  }
}

function portListening(ws: string): Promise<boolean> {
  const port = Number(new URL(ws).port);
  return new Promise((resolve) => {
    const sock = createConnection({ host: "127.0.0.1", port });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(500, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

async function wsFromPort(port: number): Promise<string> {
  let res: globalThis.Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000) });
  } catch {
    throw new CliError("no_browser", `nothing is listening for DevTools on port ${port}`);
  }
  const v = (await res.json()) as { webSocketDebuggerUrl?: string };
  if (!v.webSocketDebuggerUrl) throw new CliError("no_browser", `no webSocketDebuggerUrl on port ${port}`);
  return v.webSocketDebuggerUrl;
}

export async function discoverEndpoint(o: ConnectOpts): Promise<string> {
  if (o.ws) return o.ws;
  if (o.port) return wsFromPort(o.port);
  if (o.userDataDir) {
    const c = readActivePort(o.userDataDir);
    if (!c) throw new CliError("no_browser", `no DevToolsActivePort file in ${o.userDataDir}`);
    return c.ws;
  }
  const found: { ws: string; mtime: number }[] = [];
  for (const dir of userDataDirs()) {
    const c = readActivePort(dir);
    if (c && (await portListening(c.ws))) found.push(c);
  }
  if (found.length === 0) {
    throw new CliError(
      "no_browser",
      "no Chrome with remote debugging found.\n" +
        'Open chrome://inspect/#remote-debugging in Chrome and enable "Allow remote debugging" (Chrome 144+),\n' +
        "or start Chrome with --remote-debugging-port=9222 and run `browsercli connect --port 9222`.",
    );
  }
  found.sort((a, b) => b.mtime - a.mtime);
  return found[0].ws;
}
