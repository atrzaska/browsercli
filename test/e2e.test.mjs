// End-to-end test against a throwaway headless Chrome (never your real profile).
// Set CHROME_PATH to override the browser binary.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
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
  return run({}, args);
}

// Runs as a specific browsercli session (like a second agent).
const as = (session) => (...args) => run({ BROWSERCLI_SESSION: session }, args);

async function run(extraEnv, args) {
  try {
    const t0 = Date.now();
    const { stdout } = await exec("node", [cli, ...args], { env: { ...process.env, BROWSERCLI_HOME: home, ...extraEnv } });
    if (process.env.TIMING) console.error(`${Date.now() - t0}ms`, args.join(" "));
    return stdout.trim();
  } catch (e) {
    throw new Error(`browsercli ${args.join(" ")} failed:\n${e.stderr || e.stdout}`);
  }
}

async function bFails(...args) {
  return runFails({}, args);
}

const asFails = (session) => (...args) => runFails({ BROWSERCLI_SESSION: session }, args);

async function runFails(extraEnv, args) {
  try {
    await exec("node", [cli, ...args], { env: { ...process.env, BROWSERCLI_HOME: home, ...extraEnv } });
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

test("fill verifies rich-text editors by text, ignoring emoji", async () => {
  const snap = await b("snapshot", "--interactive-only");
  const emoji = refOf(snap, 'textbox "Emoji editor"');
  const stubborn = refOf(snap, 'textbox "Stubborn editor"');
  assert.equal(await b("fill", emoji, "hello from browsercli 🤖"), `${emoji}: filled`);
  assert.match(await b("eval", "document.getElementById('emoji-editor').innerHTML"), /<img alt=":robot_face:"/);
  assert.match(await b("fill", stubborn, "you shall not pass"), /filled, but the editor now contains ""/);
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

test("record: frames, timeline, video", async () => {
  const outDir = join(home, "rec");
  assert.match(await b("record", "start", `${base}/index.html`, "--fps", "10"), /recording tab/);
  assert.match(await bFails("record", "start"), /already_recording/);
  const snap = await b("snapshot", "--interactive-only");
  await b("fill", refOf(snap, 'textbox "Name"'), "secret-value");
  await b("click", refOf(snap, 'button "Break things"'));
  await b("wait", "--text", "broken!");
  await new Promise((r) => setTimeout(r, 700));
  assert.match(await b("record", "status"), /^recording/);
  assert.match(await b("record", "stop", "--out", outDir, "--close"), /saved recording/);

  const md = readFileSync(join(outDir, "timeline.md"), "utf8");
  assert.match(md, /\*\*browsercli\*\* fill e\d+ \(12 chars\)/);
  assert.doesNotMatch(md, /secret-value/);
  assert.match(md, /\*\*page\*\* click on button "Break things"/);
  assert.match(md, /\*\*console\.error\*\* boom: cart total is NaN/);
  assert.match(md, /\*\*network\*\* 404 GET .*\/api\/missing/);
  const timeline = JSON.parse(readFileSync(join(outDir, "timeline.json"), "utf8"));
  assert.ok(timeline.frames.length >= 2, "expected key frames");
  for (const f of timeline.frames) assert.ok(existsSync(join(outDir, f.file)), f.file);
  // The click is stamped before the error it caused.
  const at = (re) => timeline.events.find((e) => re.test(e.text)).ms;
  assert.ok(at(/^click /) <= at(/boom/));
  if (timeline.video) assert.ok(statSync(join(outDir, "video.mp4")).size > 1000);
  assert.match(await bFails("record", "stop"), /not_recording/);
});

test("sessions: agents don't share a selected tab", async () => {
  const alice = as("alice");
  const bob = as("bob");
  const aliceTab = JSON.parse(await alice("open", `${base}/index.html`, "--json")).data.id;
  assert.match(await asFails("bob")("snapshot"), /no_tab_selected/);
  const bobTab = JSON.parse(await bob("open", `${base}/page2.html`, "--new", "--json")).data.id;
  assert.notEqual(aliceTab, bobTab);
  // Bob opening a tab doesn't move Alice.
  assert.match(await alice("get", "--what", "title"), /Test Page/);
  assert.match(await bob("get", "--what", "title"), /Page Two/);

  // Alice's list marks Bob's tab as in use; closing it needs --force.
  const list = JSON.parse(await alice("tab", "list", "--json")).data;
  assert.ok(list.find((t) => t.id === aliceTab).current);
  assert.equal(list.find((t) => t.id === bobTab).otherSessions, 1);
  assert.match(await alice("tab", "list"), new RegExp(`~ ${bobTab}`));
  assert.match(await asFails("alice")("tab", "close", bobTab), /tab_in_use/);

  // A recording only logs its own session's commands.
  const outDir = join(home, "rec-sessions");
  await alice("record", "start", `${base}/index.html`);
  await bob("eval", "1 + 1");
  await alice("eval", "2 + 2");
  assert.match(await asFails("bob")("daemon", "stop"), /recording_in_progress/);
  await alice("record", "stop", "--out", outDir, "--close");
  const events = JSON.parse(readFileSync(join(outDir, "timeline.json"), "utf8")).events.filter((e) => e.kind === "browsercli");
  assert.deepEqual(events.map((e) => e.text), ["eval 2 + 2"]);

  await bob("tab", "close", bobTab);
  await alice("tab", "close", aliceTab);
});

test("tabs", async () => {
  const opened = await b("tab", "new", `${base}/page2.html`, "--json");
  const { id } = JSON.parse(opened).data;
  const list = JSON.parse(await b("tab", "list", "--json")).data;
  assert.ok(list.find((t) => t.id === id && t.current));
  await b("tab", "close", id);
  assert.match(await bFails("snapshot"), /no_tab_selected/);
});
