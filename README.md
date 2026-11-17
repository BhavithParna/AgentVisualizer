# Agent Visualizer

A live desktop view of your [Claude Code](https://claude.com/claude-code) agents. When a session hands work to
subagents, this shows who is running, on which model, what each one was asked to do, and what it is doing right now.

It reads the transcripts Claude Code already writes to `~/.claude/projects` on your machine. It never changes them
and needs no setup inside Claude Code.

## What you see

- **The notch** at the top is the lead agent of the session you are viewing.
- **Capsules** hanging from it are its helpers. The colour is the model (orange Opus, blue Sonnet, violet Fable,
  green Haiku), the fill shows how busy the agent has been in the last minute, and the number is how long it has run.
- **All sessions** shows every Claude Code session active in the last 30 minutes at once, each lead with its helpers
  beneath it. The pills under the title switch between that and a single session.
- **Click an agent** to open its sheet: its job in plain English, why it matters, what it will produce, what it is
  doing right now, and a short story of what it has done. The arrow buttons or the ← → keys move between agents and
  Esc closes the sheet.
- **Live feed** along the bottom is what the agents are saying, newest first.
- **Files being changed** lists the files they edited most recently.

## Requirements

- Linux or macOS
- [Node.js](https://nodejs.org) 18 or newer
- Claude Code, used at least once so that `~/.claude/projects` exists

## Install

The steps are the same on Linux and macOS.

```sh
git clone https://github.com/BhavithParna/AgentVisualizer.git
cd AgentVisualizer
npm install
```

## Run

As a desktop app:

```sh
npm start
```

Or in your browser, with no Electron needed (this mode has no dependencies, so you can skip `npm install`):

```sh
node server.js
```

That serves the same page at <http://localhost:4517> and opens it.

### Options

Pass these after `node server.js`:

| Option | What it does |
|---|---|
| `--port 4518` | Use another port (default 4517) |
| `--no-open` | Do not open the browser |
| `--no-summaries` | Do not write plain-English summaries (see Privacy) |
| `--hours 48` | How far back to look for sessions at startup (default 24) |

## Build a standalone app

```sh
npm run dist
```

Run it on the system you are building for. On macOS it produces a `.dmg` in `dist/`; drag the app to Applications.
On Linux it produces an `.AppImage` in `dist/`; make it executable and run it.

The macOS build is not code-signed. The first time, right-click the app and choose **Open**.

## Start it at login (optional)

**macOS:** build the app, then add it under System Settings → General → Login Items.

**Linux (systemd):** this keeps the server running in the background, so the app or the browser page is ready
instantly. Save as `~/.config/systemd/user/agent-visualizer.service`, with the path changed to where you cloned it:

```ini
[Unit]
Description=Agent Visualizer

[Service]
ExecStart=/usr/bin/node "%h/AgentVisualizer/server.js" --no-open
Restart=on-failure

[Install]
WantedBy=default.target
```

```sh
systemctl --user enable --now agent-visualizer
```

If the server is already running when you open the desktop app, the app simply connects to it.

## Privacy

Everything runs on your machine and the server only listens on `localhost`.

One feature sends data out: to describe each agent's job in plain English, the server passes that agent's brief to
Claude Haiku through your own `claude` command, using your normal Claude Code login. It is one small request per
agent and the result is cached in `~/.cache/agentscope`. Start the server with `--no-summaries` to turn this off; the
sheet then shows the start of the original brief instead.

## How it works

- `server.js` tails the session and subagent transcript files, works out each agent's status, and streams a snapshot
  to the page once a second. It uses only Node's standard library.
- `index.html` is the whole interface, animated with [GSAP](https://gsap.com) (bundled in `vendor/`, so it works
  offline).
- `main.js` is a small Electron wrapper that runs the server and shows the page in a window.

Only Claude Code is supported. Other coding agents are not shown.
