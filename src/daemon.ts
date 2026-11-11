// Background process holding the browser connection; serves one JSON request
// per Unix-socket connection.
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { Browser } from "./browser.js";
import { verbs } from "./commands.js";
import { CliError, HOME, SOCKET_PATH, buildStamp, type Request, type Response } from "./common.js";

// Commands worth showing on a recording's timeline.
const RECORDED_VERBS = new Set([
  "open", "back", "forward", "reload", "click", "hover", "focus", "clear", "check", "uncheck", "fill",
  "fill-form", "press", "scroll", "select", "upload", "dialog", "eval", "wait", "resize",
]);

// Describes a command for the timeline without leaking typed values.
function describeAction(req: Request, resultText = ""): string {
  let args = req.args;
  if (req.verb === "fill") args = [args[0], `(${(args[1] ?? "").length} chars)`];
  else if (req.verb === "fill-form") {
    try {
      args = [`fields ${Object.keys(JSON.parse(args[0])).join(", ")}`];
    } catch {}
  }
  const flags = Object.entries(req.flags)
    .filter(([k]) => k !== "json")
    .map(([k, v]) => (v === true ? `--${k}` : `--${k} ${v}`));
  const outcome = resultText.split("\n").find((l) => l.startsWith("→"));
  return [req.verb, ...args, ...flags].join(" ") + (outcome ? ` ${outcome}` : "");
}

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
    if (req.verb === "shutdown") {
      const others = [...browser.recorders.entries()].filter(([s, r]) => s !== req.session && r.active);
      if (others.length && req.flags.force !== true) {
        const message = `${others.length} other session(s) are recording; stopping the daemon would lose their recordings. Pass --force to stop anyway`;
        return { res: { ok: false, error: { code: "recording_in_progress", message } } };
      }
      return { res: { ok: true, text: "daemon stopped" }, exit: true };
    }
    const h = verbs[req.verb];
    if (!h) return { res: { ok: false, error: { code: "unknown_verb", message: `unknown command "${req.verb}"; see \`browsercli help\`` } } };
    const startedAt = Date.now();
    // Only the session that started a recording shows up on its timeline.
    const recorder = browser.recorders.get(req.session);
    try {
      const out = await h({ browser, session: browser.session(req.session), args: req.args, flags: req.flags });
      if (recorder?.active && RECORDED_VERBS.has(req.verb)) recorder.action(describeAction(req, out.text), startedAt);
      return { res: { ok: true, ...out } };
    } catch (e) {
      const code = e instanceof CliError ? e.code : "internal_error";
      if (recorder?.active && RECORDED_VERBS.has(req.verb)) recorder.action(`${describeAction(req)} → failed: ${code}`, startedAt);
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
      log("->", `[${req.session?.slice(0, 8)}]`, req.verb, req.args.join(" "));
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
