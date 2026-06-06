# Sentinel-Dev

Sentinel-Dev is an autonomous developer agent that **watches your GitHub issues
and gets them fixed**, keeping you in the loop the whole time over
[Poke](https://poke.com).

You point it at one or more repos. When an issue shows up, Sentinel hands it off
to be fixed — by default it asks **Poke to spin up a [Cursor](https://cursor.com)
agent** that writes the code and opens a pull request. Sentinel texts you
progress on Poke, and you approve, decline, or steer it — all from your phone or
from a friendly terminal menu.

```
 GitHub issue (any watched repo)
        │  Sentinel polls / you pick it in the CLI
        ▼
   Sentinel ──"fix issue #N, here's the context"──► Poke ──► spins up Cursor VM
        │                                                       │ writes code,
        │  updates & questions (Poke inbound API)               │ opens a PR
        ▼                                                       ▼
   you ◄── approve / decline / instruct (CLI or Poke MCP) ──► merge / close PR
```

---

## Table of contents

- [Concepts](#concepts)
- [Prerequisites](#prerequisites)
- [Install](#install)
- [Quick start](#quick-start)
- [The interactive CLI](#the-interactive-cli)
- [Commands](#commands)
- [Fix engines](#fix-engines)
- [Poke integration](#poke-integration)
- [Connecting Sentinel to the Poke app (MCP)](#connecting-sentinel-to-the-poke-app-mcp)
- [Using the Cursor engine](#using-the-cursor-engine)
- [Configuration reference](#configuration-reference)
- [GitHub Actions (label mode)](#github-actions-label-mode)
- [Architecture](#architecture)
- [Troubleshooting](#troubleshooting)
- [Security](#security)

---

## Concepts

- **Watcher** — a long-running loop (the `serve` command) that polls your repos
  for new issues and triggers a fix for each. It tracks what it has already
  handled so it never double-fixes.
- **Fix engine** — *who actually writes the code*. `poke` (default) asks Poke to
  launch a Cursor agent; `cursor` mentions `@cursor` on the issue directly;
  `sentinel` runs an in-repo LLM patch pipeline. See [Fix engines](#fix-engines).
- **Poke (outbound)** — Sentinel posts messages to Poke's inbound API to text you
  updates and ask for approval.
- **MCP server (inbound)** — Sentinel exposes a [Model Context Protocol](https://modelcontextprotocol.io)
  server that you connect to the Poke app, so you can *talk back* to Sentinel
  (approve, decline, instruct, pause) from your phone.
- **Interactive CLI** — a terminal menu (the `cli` command) to pick repos to
  watch and choose which issues to fix, without editing any config.

---

## Prerequisites

- **Node.js 18+** (uses the built-in `fetch` and `readline/promises`).
- **[GitHub CLI](https://cli.github.com) (`gh`)** — used for zero-config auth.
  Run `gh auth login` once (or let `npm run login` do it). Alternatively set
  `GITHUB_TOKEN` yourself.
- **A Poke V2 API key** from [poke.com/kitchen](https://poke.com/kitchen) → API
  Keys (set as `POKE_API_KEY`). Optional, but without it Sentinel just logs
  messages instead of texting you.
- **For the default `poke` engine:** Poke's Cursor integration enabled in your
  Poke account (so Poke can spin up a Cursor VM). Nothing to install on GitHub.

---

## Install

```bash
git clone <your-fork> sentinel-dev && cd sentinel-dev
npm install
npm run build        # type-check + compile to dist/
```

---

## Quick start

```bash
export POKE_API_KEY=<your V2 Poke key>   # optional but recommended
npm run login                            # authenticate via gh (no PAT needed)
npm start                                # opens the interactive CLI
```

From the menu you can fix an issue immediately or start watching repos. That's
it — no tokens to paste, no repo list to maintain (Sentinel auto-discovers the
repos you can push to).

To run the always-on watcher headless instead of the menu:

```bash
npm run serve                            # watches your repos, texts you on Poke
```

To also control Sentinel from the Poke app, expose its MCP port (see
[Connecting Sentinel to the Poke app](#connecting-sentinel-to-the-poke-app-mcp)).

---

## The interactive CLI

`npm start` (or `npm run cli`) launches a menu. It first authenticates, shows who
you are and the active fix engine, and discovers the repos you can push to.

```
──────── Menu ────────
  1. Fix an issue now
  2. Start watching repos (always-on)
  3. Review a fix (approve/decline a PR)
  4. List watchable repos
  5. Quit
```

**1. Fix an issue now**
Pick a repo from the numbered list, then Sentinel fetches its open issues
(pull requests are filtered out). Choose one or more to fix — you can enter
`1`, a list like `1,3`, a range like `1-2`, or `all`. Confirm, and Sentinel
triggers the fix with the configured engine.

**2. Start watching repos (always-on)**
Select repos (`1,3`, `1-4`, or `all`), optionally restrict to a label (e.g.
only issues tagged `bug`), and Sentinel switches into the always-on `serve`
loop: it polls those repos and fixes new issues as they appear, texting you on
Poke. Press `Ctrl+C` to stop.

**3. Review a fix (approve/decline a PR)**
Pick a repo, enter an issue number, and Sentinel finds the open PR addressing it
(e.g. the one Cursor opened). Choose `a` to merge it or `d` to close it.

**4. List watchable repos** — reprints the discovered repo list.

**5. Quit** — exits.

> Selection syntax (used wherever you pick repos/issues): comma lists `1,3,5`,
> ranges `2-4`, `all`/`*`, or blank to cancel/go back.

---

## Commands

All are available as `npm run <name>` or `node dist/index.js <name>`.

| Command | What it does |
| --- | --- |
| `cli` (default, also `npm start`) | Interactive menu to pick repos and fix issues |
| `login` | Authenticate via the GitHub CLI and list watchable repos |
| `ping` | Send a test message to Poke to verify outbound wiring |
| `serve` | Always-on watcher **+** MCP control server |
| `mcp` | MCP control server only (no watcher) |
| `fix` | One-shot label-triggered pipeline (used by GitHub Actions) |
| `finalize` | Apply an approve/decline decision (used by the approval Action) |

---

## Fix engines

Set with `FIX_ENGINE`. This decides *who writes the code* in watcher/CLI mode.

| `FIX_ENGINE` | How the fix gets written | Setup needed |
| --- | --- | --- |
| `poke` (default) | Sentinel messages Poke to **spin up a Cursor VM** that fixes the issue and opens a PR | Poke's Cursor integration; **nothing on GitHub** |
| `cursor` | Sentinel comments `@cursor` on the issue; Cursor's GitHub App opens a PR | Install the Cursor GitHub App with read+write |
| `sentinel` | Sentinel's own LLM patches the code in-repo via the `Sentinel-Fix` label + Actions | `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` + the workflows |

With `poke` and `cursor`, the result is a Cursor pull request, so `approve_fix`
merges that PR and `decline_fix` closes it. With `sentinel`, approval fires the
`repository_dispatch` workflow described in [GitHub Actions](#github-actions-label-mode).

---

## Poke integration

Sentinel talks to Poke in **both** directions.

**Outbound (notifications).** It texts you when it picks up an issue, includes
the issue title/body/link and (for the `poke` engine) an explicit instruction to
spin up a Cursor agent, and reports merges/declines. Toggle progress chatter
with `POKE_PROGRESS`. **Test it:** put `POKE_API_KEY` in `.env` and run
`npm run ping` — the message should appear in your Poke app.

**Inbound (control) via MCP.** Connect Sentinel's MCP server to Poke and you can
drive it conversationally. Tools (each takes an optional `repo` = `"owner/repo"`
when more than one is watched):

| Tool | What it does |
| --- | --- |
| `watch_status` | Paused?, repos watched, fixes in flight |
| `pause_watch` / `resume_watch` | Stop / resume picking up new issues |
| `trigger_fix` | Start a fix for an issue (engine-aware) |
| `instruct_fix` | Relay a follow-up instruction to the agent on an issue |
| `get_diff` | Unified diff for a fix branch, for review |
| `list_open_fixes` | Open `Sentinel-Fix` issues + pending branches in a repo |
| `approve_fix` | Merge the Cursor PR (or fire the Sentinel approval workflow) |
| `decline_fix` | Close the Cursor PR (or fire the Sentinel decline workflow) |

Every MCP request's `X-Poke-User-Id` header is logged for auditing.

---

## Connecting Sentinel to the Poke app (MCP)

1. Start Sentinel with the MCP server running:

   ```bash
   npm run serve            # watcher + MCP on MCP_PORT (default 3000)
   # or, control surface only:
   npm run mcp
   ```

2. Expose it to Poke. The easiest way is Poke's tunnel:

   ```bash
   npx poke@latest tunnel http://localhost:3000/mcp -n "Sentinel"
   ```

   Or, if hosting at a public URL, add it at
   [poke.com/integrations/new](https://poke.com/integrations/new) with the
   server URL ending in `/mcp`.

3. In the Poke app, ask things like *"what is Sentinel working on?"*,
   *"approve the fix for issue 42"*, or *"tell it to add tests on issue 42"* —
   Poke calls the matching MCP tool.

---

## Using the Cursor engine

Only needed if you set `FIX_ENGINE=cursor` (the default `poke` engine doesn't use
this). To let `@cursor` mentions spin up an agent:

1. Install the **Cursor GitHub App** on the repos you watch, with **read &
   write** access (cursor.com → Integrations → GitHub).
2. Connect the same GitHub account/org in Cursor and set a spend limit
   (background agents bill at model API pricing).

Then an `@cursor` comment on an issue triggers an agent that branches,
implements, and opens a PR. `CURSOR_MENTION` overrides the mention string.

---

## Configuration reference

Everything is environment variables (see `.env.example`). A `.env` file in the
project root is loaded automatically (without overriding values already exported,
so CI secrets win). Sensible defaults mean you usually only set `POKE_API_KEY`.

**Auth & repos**

| Var | Default | Purpose |
| --- | --- | --- |
| `GITHUB_TOKEN` | _(from `gh`)_ | Token; falls back to `gh auth token`. Auto-set in Actions |
| `WATCH_REPOS` | _(auto-discover)_ | Comma-separated `owner/repo` list to watch |
| `WATCH_MAX_REPOS` | `20` | Cap on auto-discovered repos (recently-pushed first) |
| `GITHUB_REPOSITORY` | – | `owner/repo` for the one-shot `fix`/`finalize` Action |

**Watcher**

| Var | Default | Purpose |
| --- | --- | --- |
| `FIX_ENGINE` | `poke` | `poke`, `cursor`, or `sentinel` |
| `CURSOR_MENTION` | `@cursor` | Mention used by the `cursor` engine |
| `WATCH_LABEL` | _(any)_ | Only act on issues with this label |
| `WATCH_INTERVAL_MS` | `60000` | Poll interval |
| `WATCH_BACKFILL` | `false` | Also act on issues that exist at startup |
| `STATE_FILE` | `.sentinel-state.json` | Where handled issues are recorded |
| `MCP_PORT` | `3000` | Port the MCP server listens on |

**Poke**

| Var | Default | Purpose |
| --- | --- | --- |
| `POKE_API_KEY` | – | Poke V2 key (from Kitchen). Omit to log instead of text |
| `POKE_WEBHOOK_URL` | `…/api/v1/inbound/api-message` | Poke inbound endpoint |
| `POKE_PROGRESS` | `true` | Stream progress updates |

**Sentinel LLM engine (only for `FIX_ENGINE=sentinel`)**

| Var | Default | Purpose |
| --- | --- | --- |
| `LLM_PROVIDER` | `anthropic` | `anthropic` or `openai` |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | – / `claude-sonnet-4-20250514` | Anthropic patches |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | – / `gpt-4o` | OpenAI patches |
| `TEST_COMMAND` | auto-detected | Override the test command |
| `NOTIFY_EMAIL` / `SMTP_*` | – | Failure/decline email |

---

## GitHub Actions (label mode)

The original flow still works and is what `FIX_ENGINE=sentinel` drives. Add the
**`Sentinel-Fix`** label to an issue and `.github/workflows/sentinel.yml` runs
your tests, AST-maps the codebase, asks an LLM for a patch, pushes
`sentinel/fix-issue-<n>`, and pings Poke. Approving (via the MCP `approve_fix`
tool, or a `repository_dispatch` of `sentinel-approve`) runs
`.github/workflows/sentinel-approval.yml`, which opens a draft PR and merges it;
declining deletes the branch and emails the logs.

Required repo secrets for this mode: `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`),
`POKE_API_KEY`, and `SMTP_USERNAME`/`SMTP_PASSWORD` for emails. `GITHUB_TOKEN` is
provided automatically.

---

## Architecture

```
src/
  index.ts            CLI dispatch: cli, login, serve, mcp, fix, finalize
  config.ts           Env parsing + gh-token resolution + watcher/engine config
  logger.ts           Tees logs to sentinel.log
  cli/
    interactive.ts    The terminal menu (pick repos, fix issues, review PRs)
  commands/
    serve.ts          Always-on: watcher + MCP server together
    auth.ts           `login`: authenticate via gh + list repos
    fix.ts            test -> AST -> LLM -> branch/push -> Poke (label mode)
    finalize.ts       approve -> PR+merge / decline -> delete+notify
  watch/
    watcher.ts        Multi-repo issue poller -> requestFix -> Poke updates
  mcp/
    server.ts         MCP server Poke connects to (status/steer/approve/decline)
  lib/
    trigger.ts        Engine dispatch + the Poke message per fix
    cursor.ts         @cursor delegation / instruction relay
    githubApi.ts      GitHub REST client (auth, issues, comments, PRs, repos)
    poke.ts           Poke inbound webhook + progress + approval message
    tests.ts          test command detection + run (sentinel engine)
    ast.ts            TS compiler API mapping + suspect ranking (sentinel engine)
    llm.ts            Anthropic/OpenAI patch client (sentinel engine)
    git.ts            branch / apply / commit / push (sentinel engine)
    github.ts         gh CLI: draft PR + auto-merge (sentinel engine)
    exec.ts           shell helpers
```

---

## Troubleshooting

- **"No GitHub auth"** — run `npm run login` (or `gh auth login`), or set
  `GITHUB_TOKEN`.
- **CLI shows "No open issues found" but the repo has activity** — those are
  likely pull requests; Sentinel only lists actual issues.
- **Poke messages don't arrive** — confirm `POKE_API_KEY` is a **V2** key from
  Kitchen and that `POKE_PROGRESS` isn't `false`. Without a key, Sentinel logs
  the message instead of sending it.
- **`approve_fix` says "No open PR found"** — the Cursor agent may not have
  opened the PR yet; try again shortly.
- **Watching too many repos** — auto-discovery watches up to `WATCH_MAX_REPOS`.
  Pin specific repos with `WATCH_REPOS`, or scope with `WATCH_LABEL`.
- **`@cursor` does nothing** (cursor engine) — the Cursor GitHub App isn't
  installed with write access on that repo.

---

## Security

- Sentinel uses your GitHub auth to read issues and (for approvals) write PRs.
  Prefer a scoped token or the `gh` login over a broad PAT.
- Never commit `.env` or API keys. `.sentinel-state.json` and `sentinel.log` are
  git-ignored.
- Your `POKE_API_KEY` can send messages to your Poke — keep it secret and rotate
  it in Kitchen if leaked.
- The MCP server has no auth of its own; only expose it to Poke (via the tunnel
  or a trusted URL), not the public internet.

---

## Tech stack

TypeScript · Node `readline` CLI · GitHub CLI + REST · Poke (inbound API + MCP) ·
Cursor agents · TS compiler API (AST) · Anthropic/OpenAI · GitHub Actions
