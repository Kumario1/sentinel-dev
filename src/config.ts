import * as fs from "fs";
import { run } from "./lib/exec";

export type LlmProvider = "anthropic" | "openai";

/**
 * Who actually writes the fix:
 *  - "poke":     ask Poke to spin up a Cursor VM (Poke's Cursor integration).
 *  - "cursor":   mention @cursor on the issue (Cursor's GitHub App).
 *  - "sentinel": our own in-repo LLM patch pipeline (the `fix` Action).
 */
export type FixEngine = "poke" | "cursor" | "sentinel";

export interface RepoContext {
  owner: string;
  repo: string;
  /** "issues" | "pull_request" | "manual" */
  eventName: string;
  /** Issue or PR number that was labeled. */
  number: number;
  title: string;
  body: string;
  /** Head branch when the event is a pull_request. */
  headRef?: string;
  serverUrl: string;
  runId: string;
}

export interface Config {
  githubToken: string;
  repoContext: RepoContext;
  llmProvider: LlmProvider;
  anthropicApiKey?: string;
  anthropicModel: string;
  openaiApiKey?: string;
  openaiModel: string;
  pokeApiKey?: string;
  pokeWebhookUrl: string;
  /** Send incremental progress updates to Poke during the fix pipeline. */
  pokeProgress: boolean;
  notifyEmail: string;
  testCommand?: string;
  /** Port the MCP server listens on (mcp command). */
  mcpPort: number;

  /** How fixes get written: "cursor" (delegate via @cursor) or "sentinel". */
  fixEngine: FixEngine;
  /** The mention that triggers Cursor's GitHub App (default "@cursor"). */
  cursorMention: string;

  /** Watcher: repos to scan, e.g. ["owner/repo", ...]. Empty = auto-discover. */
  watchRepos: string[];
  /** Cap on auto-discovered repos (most-recently-pushed first). */
  watchMaxRepos: number;
  /** Only act on issues carrying this label (empty = any open issue). */
  watchLabel: string;
  /** Polling interval for the watcher, in milliseconds. */
  watchIntervalMs: number;
  /** Where the watcher persists which issues it has already handled. */
  stateFile: string;
}

/**
 * Resolve a GitHub token without making the user juggle PATs:
 *   1. GITHUB_TOKEN env (set automatically inside GitHub Actions)
 *   2. the GitHub CLI (`gh auth token`) — run `sentinel login` / `gh auth login`
 * Returns "" if neither is available; commands that need it error clearly.
 */
function resolveGithubToken(): string {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const gh = run("gh auth token");
  if (gh.ok && gh.output.trim()) return gh.output.trim();
  return "";
}

function readEventPayload(): Record<string, any> | undefined {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !fs.existsSync(eventPath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(eventPath, "utf8"));
  } catch {
    return undefined;
  }
}

function resolveRepoContext(): RepoContext {
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const [owner, repo] = repository.split("/");
  const eventName = process.env.GITHUB_EVENT_NAME ?? "manual";
  const serverUrl = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  const runId = process.env.GITHUB_RUN_ID ?? "local";

  const payload = readEventPayload();
  const target = payload?.pull_request ?? payload?.issue;

  // Allow explicit overrides (handy for the finalize step / local runs).
  const explicitNumber = process.env.ISSUE_NUMBER
    ? Number(process.env.ISSUE_NUMBER)
    : undefined;

  return {
    owner: owner ?? "",
    repo: repo ?? "",
    eventName,
    number: explicitNumber ?? target?.number ?? 0,
    title: target?.title ?? "",
    body: target?.body ?? "",
    headRef: payload?.pull_request?.head?.ref,
    serverUrl,
    runId,
  };
}

export function loadConfig(): Config {
  const llmProvider = (process.env.LLM_PROVIDER ?? "anthropic") as LlmProvider;
  return {
    githubToken: resolveGithubToken(),
    repoContext: resolveRepoContext(),
    llmProvider,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    anthropicModel: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-20250514",
    openaiApiKey: process.env.OPENAI_API_KEY,
    openaiModel: process.env.OPENAI_MODEL ?? "gpt-4o",
    pokeApiKey: process.env.POKE_API_KEY,
    pokeWebhookUrl:
      process.env.POKE_WEBHOOK_URL ??
      "https://poke.com/api/v1/inbound/api-message",
    pokeProgress: (process.env.POKE_PROGRESS ?? "true").toLowerCase() !== "false",
    notifyEmail: process.env.NOTIFY_EMAIL ?? "princekmr14214@gmail.com",
    testCommand: process.env.TEST_COMMAND,
    mcpPort: Number(process.env.MCP_PORT ?? process.env.PORT ?? 3000),
    fixEngine: (process.env.FIX_ENGINE ?? "poke") as FixEngine,
    cursorMention: process.env.CURSOR_MENTION ?? "@cursor",
    watchRepos: (process.env.WATCH_REPOS ?? "")
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean),
    watchMaxRepos: Number(process.env.WATCH_MAX_REPOS ?? 20),
    watchLabel: process.env.WATCH_LABEL ?? "",
    watchIntervalMs: Number(process.env.WATCH_INTERVAL_MS ?? 60000),
    stateFile: process.env.STATE_FILE ?? ".sentinel-state.json",
  };
}

export function branchForIssue(issueNumber: number): string {
  return `sentinel/fix-issue-${issueNumber}`;
}
