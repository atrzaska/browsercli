// End-to-end test against a throwaway headless Chrome (never your real profile).
// Set CHROME_PATH to override the browser binary.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = new URL("..", import.meta.url).pathname;
const cli = join(root, "dist/cli.js");
const fixtures = join(root, "test/fixtures");

const chromePath =
  process.env.CHROME_PATH ??
  ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync);

let home, profile, chrome, server, base;

async function b(...args) {
  try {
    const t0 = Date.now();
    const { stdout } = await exec("node", [cli, ...args], { env: { ...process.env, BROWSERCLI_HOME: home } });
    if (process.env.TIMING) console.error(`${Date.now() - t0}ms`, args.join(" "));
    return stdout.trim();
  } catch (e) {
    throw new Error(`browsercli ${args.join(" ")} failed:\n${e.stderr || e.stdout}`);
  }
}

async function bFails(...args) {
  try {
    await exec("node", [cli, ...args], { env: { ...process.env, BROWSERCLI_HOME: home } });
  } catch (e) {
    return e.stderr.trim();
  }
  throw new Error(`expected failure: ${args.join(" ")}`);
}

const refOf = (snapshot, pattern) => {
  const line = snapshot.split("\n").find((l) => l.includes(pattern));
  assert.ok(line, `no snapshot line containing ${pattern}:\n${snapshot}`);
  return line.match(/\[@(e\d+)\]/)[1];
};

before(async () => {
  assert.ok(chromePath, "Chrome not found; set CHROME_PATH");
  home = mkdtempSync(join(tmpdir(), "bcli-"));
  profile = mkdtempSync(join(tmpdir(), "bcli-profile-"));
  server = createServer((req, res) => {
    const file = join(fixtures, req.url === "/" ? "index.html" : req.url.slice(1));
    if (!existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": "text/html" }).end(readFileSync(file));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  chrome = spawn(chromePath, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
  for (let i = 0; i < 100 && !existsSync(join(profile, "DevToolsActivePort")); i++) await new Promise((r) => setTimeout(r, 100));
  await b("connect", "--user-data-dir", profile);
});

after(async () => {
  await b("daemon", "stop").catch(() => {});
  chrome?.kill();
  server?.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
});

test("requires an explicit tab", async () => {
  assert.match(await bFails("snapshot"), /no_tab_selected/);
});

test("forms, refs, navigation", async () => {
  assert.match(await b("open", `${base}/index.html`), /Test Page/);
  let snap = await b("snapshot");
  assert.match(snap, /<untrusted-page-content>/);
  // Text that only repeats a contents-derived name is dropped; aria-label'd content is kept.
  assert.match(snap, /button "2025 Folder"\n/);
  assert.doesNotMatch(snap, /text "2025"|text "Folder"/);
  assert.match(snap, /button "Close dialog"\n\s+- text "X"/);
  const name = refOf(snap, 'textbox "Name"');
  const agree = refOf(snap, 'checkbox "I agree"');
  const color = refOf(snap, 'combobox "Color"');
  const submit = refOf(snap, 'button "Submit"');

  await b("fill", name, "Ada");
  await b("check", agree);
  assert.match(await b("select", color, "Green"), /\["g"\]/);
  await b("click", submit);
  assert.match(await b("get", "--what", "text", "--ref", "#out"), /submitted:Ada:yes:g/);

  await b("fill-form", JSON.stringify({ [name]: "Bob", [agree]: false, [color]: "Red" }));
  await b("press", "Enter", "--ref", name);
  assert.match(await b("text"), /submitted:Bob:null:r/);

  const diff = await b("snapshot", "--diff");
  assert.match(diff, /\+ .*text "submitted:Bob:null:r"/);

  const link = refOf(snap, 'link "Go to page 2"');
  assert.match(await b("click", link), /navigated to .*page2/);
  assert.match(await bFails("click", name), /stale_ref/);
  assert.match(await b("back"), /index\.html/);
  assert.equal(await b("get", "--what", "title"), "<untrusted-page-content>\nTest Page\n</untrusted-page-content>");
});

test("dialogs do not hang", async () => {
  const snap = await b("snapshot", "--interactive-only");
  const alertBtn = refOf(snap, 'button "Alert me"');
  assert.match(await b("click", alertBtn), /alert dialog opened/);
  assert.match(await bFails("eval", "1"), /dialog_open/);
  assert.match(await b("dialog", "accept"), /accepted alert/);
  assert.match(await b("eval", "1 + 1"), /\n2\n/);
});

test("wait, find, eval, console, capture", async () => {
  const delayed = (await b("find", "Delayed")).match(/@(e\d+)/)[1];
  await b("click", delayed);
  assert.match(await b("wait", "--text", "Late content", "--timeout", "3000"), /^ok/);
  assert.match(await bFails("wait", "--selector", "#nope", "--timeout", "300"), /timeout/);
  assert.equal(JSON.parse(await b("eval", "await Promise.resolve({ n: 42 })", "--json")).data.value.n, 42);
  assert.match(await b("console"), /\[warning\] careful/);
  const shot = JSON.parse(await b("screenshot", "--json"));
  assert.ok(existsSync(shot.path));
  assert.equal(readFileSync(shot.path).subarray(1, 4).toString(), "PNG");
});

test("tabs", async () => {
  const opened = await b("tab", "new", `${base}/page2.html`, "--json");
  const { id } = JSON.parse(opened).data;
  const list = JSON.parse(await b("tab", "list", "--json")).data;
  assert.ok(list.find((t) => t.id === id && t.current));
  await b("tab", "close", id);
  assert.match(await bFails("snapshot"), /no_tab_selected/);
});
