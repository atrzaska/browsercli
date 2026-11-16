# browsercli

Control your **real Chrome** from the command line, using your own profile, logins and
open tabs. It's built for AI agents and handy for humans too.
It talks to Chrome directly over the [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/).
It does not launch a separate browser or need a profile copy or an extension.

```sh
$ browsercli open github.com
opened tab 52BA951F (now selected): https://github.com/ — "GitHub"
$ browsercli snapshot --interactive-only
- [@e12] link "Sign in"
- [@e15] textbox "Search or jump to…"
...
$ browsercli fill @e15 "chrome devtools protocol" && browsercli press Enter
```

## Setup

Requires Node.js ≥ 22.4 and Chrome 144+ (or any Chromium browser).

```sh
npm install && npm run build
npm link            # puts `browsercli` on your PATH
```

Enable remote debugging in your everyday Chrome **once**:

1. Open `chrome://inspect/#remote-debugging`
2. Turn on **Allow remote debugging**

On the first command, Chrome asks you to allow the connection. Click **Allow**.
browsercli finds Chrome automatically through the `DevToolsActivePort` file in Chrome's
profile directory. The connection is held by a small background daemon, so you approve
once per daemon run, not once per command.

Other ways to connect:

```sh
# a Chrome started with a debugging port (e.g. a separate test profile)
chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-test
browsercli connect --port 9222

browsercli connect --ws ws://127.0.0.1:9222/devtools/browser/<id>
browsercli connect --user-data-dir "~/Library/Application Support/Google/Chrome Beta"
```

## Using it with an agent

`SKILL.md` is an [Agent Skills](https://agentskills.io) file covering the commands, the
ref workflow and the safety rules. Put it in your agent's skills directory as
`browsercli/SKILL.md`, or symlink it so it stays up to date:

```sh
mkdir -p <skills-dir>/browsercli && ln -sf "$PWD/SKILL.md" <skills-dir>/browsercli/SKILL.md
```

Any agent that can run shell commands can use browsercli without the skill. `browsercli help`
prints the full reference.

## Commands

Run `browsercli help` for the full list. The essentials:

| | |
|---|---|
| Navigate | `open URL [--tab ID] [--new \| --window]`, `back`, `forward`, `reload` |
| Read | `snapshot [--interactive-only] [--depth N] [--scope REF] [--diff]`, `text`, `find QUERY [--by text\|role]`, `get --what …`, `is --what …` |
| Act | `click REF [--double]`, `fill REF VALUE`, `fill-form JSON`, `press KEY`, `select REF VALUE…`, `check`/`uncheck`, `hover`, `focus`, `clear`, `scroll`, `upload REF --files …` |
| Wait | `wait --text T \| --selector S \| --url U \| --load \| --fn JS [--state hidden] [--timeout MS]` |
| Capture | `screenshot [--out P] [--ref REF] [--full]`, `pdf [--out P]` |
| Debug | `console`, `network`, `eval JS`, `cdp METHOD [JSON]` |
| Record | `record start [URL]`, `record stop [--out DIR] [--close]`, `record status` |
| State | `cookies get\|set\|delete`, `storage get\|set\|clear` |
| Tabs | `tab list`, `tab new [URL] [--window]`, `tab switch ID`, `tab close [ID]` |
| Daemon | `status`, `connect`, `disconnect`, `daemon stop`, `daemon logs` |

Every command accepts `--json`.

### Recording bugs

```sh
browsercli record start localhost:3000/checkout   # opens a separate window and starts recording
# reproduce the bug by hand, or let an agent drive it with browsercli commands
browsercli record stop --out ./bug-123
```

```
bug-123/
  timeline.md     # what happened when: commands, clicks, console errors, failed requests, navigations
  timeline.json   # same, structured
  frames/         # key frames around each event and visual change (≤ 40, --max-frames)
  video.mp4       # for humans (requires ffmpeg)
```

AI models read images and text, not video, so the key frames and timeline are what you
give an agent: "at 00:04 the click on Submit produced a 500 on /api/order, and the frame
after it shows a stuck spinner". The recording shows your clicks and form changes
but never what you typed. Chrome only paints visible windows, so keep the recording
window uncovered. Options: `--fps` (default 5), `--max-seconds` (default 120), `--size 1280x800`.

### How it behaves

- **Explicit targeting.** Commands act on the tab you opened (`open` / `tab new`) or
  picked (`tab switch`), or on `--tab ID`. It never guesses from whichever tab you are
  looking at, so an agent can't stumble into your email by accident.
- **Sessions.** Several agents can share one browser without colliding. Each caller has
  its own selected tab and recording, keyed by `--session`, else `$BROWSERCLI_SESSION`,
  else the process issuing the commands (the nearest ancestor that isn't a shell or a
  wrapper like `timeout`/`npx`), so separate agent processes and terminals are isolated
  automatically. Several agents running inside one process (e.g. a multi-agent gateway)
  should each pass `--session NAME`. `tab list` marks tabs selected by other sessions with `~`,
  `tab close` and `daemon stop` refuse to break another session's work without `--force`,
  and a recording's timeline only includes its own session's commands.
- **Doesn't steal focus.** New tabs open in the background. Chrome withholds trusted
  mouse input from background tabs, so there `click`/`hover`/`scroll` fall back to
  DOM-dispatched events, and the output tells you when that happened. `tab switch` brings
  a tab to the front for real input.
- **Refs.** `snapshot` labels elements `[@e3]`. Refs stay valid until the page navigates.
  Old refs then fail with `stale_ref` instead of silently hitting a different element.
- **Navigation-aware actions.** `click`/`press` wait for any page load they trigger and
  report it. If a JavaScript `alert`/`confirm` opens, the command returns immediately
  and tells you to run `dialog accept|dismiss`.
- **Untrusted output.** Page-derived text is wrapped in `<untrusted-page-content>` tags
  so agents treat it as data, not instructions.

## Architecture

```
browsercli (CLI) ──unix socket──▶ daemon ──WebSocket (CDP)──▶ Chrome
   src/cli.ts                    src/daemon.ts                browser endpoint from
                                 src/browser.ts  (tabs, refs, console/network buffers)
                                 src/commands.ts (verbs)      DevToolsActivePort
                                 src/snapshot.ts (AX tree → outline)
```

- The CLI auto-starts the daemon (`~/.browsercli/`, override with `BROWSERCLI_HOME`) and
  restarts it automatically after a rebuild.
- One browser-level WebSocket with flat sessions (`Target.attachToTarget {flatten: true}`).
  Tabs are attached on first use. Console and network events are buffered from then on.
- Connection settings and the selected tab persist in `~/.browsercli/state.json`.
- No runtime dependencies (Node's built-in `WebSocket`). `devtools-protocol` provides types.

## Development

```sh
npm run dev       # tsc --watch
npm test          # builds, then runs an end-to-end suite against a throwaway headless Chrome
```

`npm test` never touches your real profile. Set `CHROME_PATH` if Chrome isn't in the
default location.

## Limitations

- Snapshots cover the main frame. Cross-origin iframe contents aren't included yet.
- `pdf` depends on Chrome supporting `Page.printToPDF` for the page.
- `resize` resizes the browser window (not an emulated viewport).
