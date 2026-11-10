// Background process holding the browser connection; serves one JSON request
// per Unix-socket connection.
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { Browser } from "./browser.js";
import { verbs } from "./commands.js";
import { CliError, HOME, SOCKET_PATH, buildStamp, type Request, type Response } from "./common.js";

function log(...args: unknown[]) {
  console.log(new Date().toISOString(), ...args);
}

function socketAlive(): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection(SOCKET_PATH);
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });
}

export async function runDaemon() {
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32" && existsSync(SOCKET_PATH)) {
    if (await socketAlive()) {
      log("another daemon is already running; exiting");
      process.exit(0);
    }
    unlinkSync(SOCKET_PATH);
  }

  const stamp = buildStamp();
  const browser = new Browser();
  process.on("uncaughtException", (e) => log("uncaught exception:", e));
  process.on("unhandledRejection", (e) => log("unhandled rejection:", e));

  const shutdown = () => {
    log("shutting down");
    browser.disconnect();
    server.close();
    if (process.platform !== "win32") {
      try {
        unlinkSync(SOCKET_PATH);
      } catch {}
    }
    process.exit(0);
  };

  async function handle(req: Request): Promise<{ res: Response; exit?: boolean }> {
    if (req.stamp !== stamp) {
      return { res: { ok: false, error: { code: "version_mismatch", message: "daemon is running an older build" } }, exit: true };
    }
    if (req.verb === "shutdown") return { res: { ok: true, text: "daemon stopped" }, exit: true };
    const h = verbs[req.verb];
    if (!h) return { res: { ok: false, error: { code: "unknown_verb", message: `unknown command "${req.verb}"; see \`browsercli help\`` } } };
    try {
      const out = await h({ browser, args: req.args, flags: req.flags });
      return { res: { ok: true, ...out } };
    } catch (e) {
      const code = e instanceof CliError ? e.code : "internal_error";
      if (!(e instanceof CliError)) log(`${req.verb} failed:`, e);
      return { res: { ok: false, error: { code, message: (e as Error).message } } };
    }
  }

  const server = createServer((sock: Socket) => {
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", async (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      buf = "";
      let req: Request;
      try {
        req = JSON.parse(line);
      } catch {
        sock.end(JSON.stringify({ ok: false, error: { code: "bad_request", message: "invalid JSON" } }) + "\n");
        return;
      }
      log("->", req.verb, req.args.join(" "));
      const { res, exit } = await handle(req);
      sock.end(JSON.stringify(res) + "\n", () => {
        if (exit) shutdown();
      });
    });
    sock.on("error", () => {});
  });

  server.listen(SOCKET_PATH, () => log(`daemon ${process.pid} listening on ${SOCKET_PATH}`));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
