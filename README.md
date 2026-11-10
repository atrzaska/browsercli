# browsercli

Control your **real Chrome** from the command line, using your own profile, logins and
open tabs. It's built for AI agents (Claude Code and others) and handy for humans too.
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

Install the bundled skill so Claude Code knows the commands, the ref workflow and the
safety rules:

```sh
mkdir -p ~/.claude/skills/browsercli && cp SKILL.md ~/.claude/skills/browsercli/
```

## Commands

Run `browsercli help` for the full list. The essentials:

| | |
|---|---|
| Navigate | `open URL [--tab ID] [--new]`, `back`, `forward`, `reload` |
| Read | `snapshot [--interactive-only] [--depth N] [--scope REF] [--diff]`, `text`, `find QUERY [--by text\|role]`, `get --what …`, `is --what …` |
| Act | `click REF [--double]`, `fill REF VALUE`, `fill-form JSON`, `press KEY`, `select REF VALUE…`, `check`/`uncheck`, `hover`, `focus`, `clear`, `scroll`, `upload REF --files …` |
| Wait | `wait --text T \| --selector S \| --url U \| --load \| --fn JS [--state hidden] [--timeout MS]` |
| Capture | `screenshot [--out P] [--ref REF] [--full]`, `pdf [--out P]` |
| Debug | `console`, `network`, `eval JS`, `cdp METHOD [JSON]` |
| State | `cookies get\|set\|delete`, `storage get\|set\|clear` |
| Tabs | `tab list`, `tab new [URL]`, `tab switch ID`, `tab close [ID]` |
| Daemon | `status`, `connect`, `disconnect`, `daemon stop`, `daemon logs` |

Every command accepts `--json`.

### How it behaves

- **Explicit targeting.** Commands act on the tab you opened (`open` / `tab new`) or
  picked (`tab switch`), or on `--tab ID`. It never guesses from whichever tab you are
  looking at, so an agent can't stumble into your email by accident.
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
