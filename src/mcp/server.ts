import * as http from "http";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Config, branchForIssue } from "../config";
import {
  GitHubRepo,
  closePr,
  dispatch,
  findOpenPrForIssue,
  getBranchDiff,
  getIssue,
  listOpenFixes,
  mergePr,
  repoFromSlug,
} from "../lib/githubApi";
import { requestFix } from "../lib/trigger";
import { instructCursor } from "../lib/cursor";
import { sendToPoke } from "../lib/poke";
import { getWatcher } from "../watch/watcher";
import { log } from "../logger";

/**
 * #1: Expose Sentinel as an MCP server so you can drive the always-on watcher
 * conversationally from the Poke app — check status, steer Cursor, pause, and
 * approve/decline the resulting PRs.
 */

const text = (body: string) => ({ content: [{ type: "text" as const, text: body }] });

/** Resolve which repo a tool acts on: explicit arg, single watched repo, or context. */
function resolveRepo(cfg: Config, repoArg?: string): GitHubRepo {
  if (repoArg) return repoFromSlug(repoArg, cfg.githubToken);
  if (cfg.watchRepos.length === 1) {
    return repoFromSlug(cfg.watchRepos[0], cfg.githubToken);
  }
  const { owner, repo } = cfg.repoContext;
  if (owner && repo) return { owner, repo, token: cfg.githubToken };
  throw new Error(
    "Multiple/zero repos configured — pass `repo` as \"owner/repo\".",
  );
}

const repoArg = {
  repo: z
    .string()
    .optional()
    .describe('Target repo "owner/repo" (omit if only one is watched)'),
};

function buildServer(cfg: Config, pokeUserId?: string): McpServer {
  const server = new McpServer({ name: "sentinel-dev", version: "1.0.0" });
  const watcher = getWatcher(cfg);
  const who = pokeUserId ? ` [poke-user ${pokeUserId}]` : "";

  server.registerTool(
    "watch_status",
    {
      title: "Watcher status",
      description:
        "Show whether the issue watcher is paused, which repos it's watching, " +
        "and which fixes are currently in flight.",
      inputSchema: {},
    },
    async () => {
      log.info(`watch_status${who}`);
      const s = watcher.status();
      const active = s.active.length
        ? s.active
            .map((a) => `• ${a.repo}#${a.issue} — ${a.title} (${a.url})`)
            .join("\n")
        : "(nothing in flight)";
      return text(
        [
          `Watcher: ${s.paused ? "PAUSED" : "running"} (engine: ${cfg.fixEngine})`,
          `Repos: ${s.watching.join(", ") || "(none)"}`,
          `In flight:`,
          active,
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "pause_watch",
    {
      title: "Pause the watcher",
      description: "Stop picking up new issues (in-flight fixes keep going).",
      inputSchema: {},
    },
    async () => {
      watcher.paused = true;
      log.info(`pause_watch${who}`);
      return text("Watcher paused. New issues won't be picked up until resumed.");
    },
  );

  server.registerTool(
    "resume_watch",
    {
      title: "Resume the watcher",
      description: "Resume picking up new issues.",
      inputSchema: {},
    },
    async () => {
      watcher.paused = false;
      log.info(`resume_watch${who}`);
      return text("Watcher resumed.");
    },
  );

  server.registerTool(
    "list_open_fixes",
    {
      title: "List open fixes",
      description:
        "List open issues labeled Sentinel-Fix in a repo and whether a fix " +
        "branch already exists.",
      inputSchema: { ...repoArg },
    },
    async ({ repo }) => {
      const target = resolveRepo(cfg, repo);
      log.info(`list_open_fixes ${target.owner}/${target.repo}${who}`);
      const fixes = await listOpenFixes(target);
      if (fixes.length === 0) return text("No open Sentinel-Fix issues.");
      return text(
        fixes
          .map(
            (f) =>
              `#${f.issue} ${f.title} — ${
                f.branch ? `branch ${f.branch}` : "no fix branch yet"
              } — ${f.url}`,
          )
          .join("\n"),
      );
    },
  );

  server.registerTool(
    "trigger_fix",
    {
      title: "Trigger a fix",
      description:
        "Manually start a fix for an issue using the configured engine " +
        "(ask Poke to spin up Cursor, mention @cursor, or the Sentinel-Fix label).",
      inputSchema: { issue: z.number().int().positive(), ...repoArg },
    },
    async ({ issue, repo }) => {
      const target = resolveRepo(cfg, repo);
      log.info(`trigger_fix ${target.owner}/${target.repo}#${issue}${who}`);
      const issueRef = await getIssue(target, issue);
      const what = await requestFix(cfg, target, issueRef);
      return text(`Triggered fix for #${issue}: ${what}.`);
    },
  );

  server.registerTool(
    "instruct_fix",
    {
      title: "Instruct the fixer",
      description:
        "Relay a follow-up instruction to the agent working an issue. With the " +
        "Cursor engine this comments on the issue; otherwise it's relayed via Poke.",
      inputSchema: {
        issue: z.number().int().positive(),
        instruction: z.string().min(1),
        ...repoArg,
      },
    },
    async ({ issue, instruction, repo }) => {
      const target = resolveRepo(cfg, repo);
      log.info(`instruct_fix #${issue}: ${instruction}${who}`);
      if (cfg.fixEngine === "cursor") {
        await instructCursor(cfg, target, issue, instruction);
      } else {
        await sendToPoke(
          cfg,
          `Follow-up for ${target.owner}/${target.repo}#${issue}: ${instruction}\n` +
            `Please pass this to the Cursor agent working that issue.`,
          { kind: "instruction", repo: `${target.owner}/${target.repo}`, issue },
        );
      }
      return text(`Sent to the agent on #${issue}: "${instruction}"`);
    },
  );

  server.registerTool(
    "get_diff",
    {
      title: "Get fix diff",
      description: "Return the unified diff for a fix branch so you can review it.",
      inputSchema: {
        branch: z.string().describe("e.g. cursor/issue-123 or sentinel/fix-issue-123"),
        ...repoArg,
      },
    },
    async ({ branch, repo }) => {
      const target = resolveRepo(cfg, repo);
      log.info(`get_diff ${branch}${who}`);
      return text(await getBranchDiff(target, branch));
    },
  );

  server.registerTool(
    "approve_fix",
    {
      title: "Approve a fix",
      description:
        "Approve the fix for an issue: merge the agent's PR (Cursor) or fire " +
        "the approval workflow (Sentinel engine).",
      inputSchema: { issue: z.number().int().positive(), ...repoArg },
    },
    async ({ issue, repo }) => {
      const target = resolveRepo(cfg, repo);
      log.info(`approve_fix #${issue}${who}`);
      watcher.active.delete(`${target.owner}/${target.repo}#${issue}`);
      if (cfg.fixEngine !== "sentinel") {
        const pr = await findOpenPrForIssue(target, issue);
        if (!pr) return text(`No open PR found for #${issue} yet. Try again soon.`);
        await mergePr(target, pr);
        return text(`Merged PR #${pr.number} for issue #${issue}: ${pr.url}`);
      }
      await dispatch(target, "sentinel-approve", {
        branch: branchForIssue(issue),
        issue,
      });
      return text(`Approved #${issue}; opening a draft PR and merging it.`);
    },
  );

  server.registerTool(
    "decline_fix",
    {
      title: "Decline a fix",
      description:
        "Decline the fix for an issue: close the agent's PR (Cursor) or fire " +
        "the decline workflow (Sentinel engine).",
      inputSchema: { issue: z.number().int().positive(), ...repoArg },
    },
    async ({ issue, repo }) => {
      const target = resolveRepo(cfg, repo);
      log.info(`decline_fix #${issue}${who}`);
      watcher.active.delete(`${target.owner}/${target.repo}#${issue}`);
      if (cfg.fixEngine !== "sentinel") {
        const pr = await findOpenPrForIssue(target, issue);
        if (!pr) return text(`No open PR found for #${issue}.`);
        await closePr(target, pr);
        return text(`Closed PR #${pr.number} for issue #${issue} without merging.`);
      }
      await dispatch(target, "sentinel-decline", {
        branch: branchForIssue(issue),
        issue,
      });
      return text(`Declined #${issue}; deleting the branch and emailing logs.`);
    },
  );

  return server;
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

/** Start the stateless Streamable-HTTP MCP server. Returns the http.Server. */
export function startMcpServer(cfg: Config): http.Server {
  const httpServer = http.createServer(async (req, res) => {
    if (req.url !== "/mcp") {
      res.writeHead(404).end("Not found");
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end("Method not allowed");
      return;
    }
    try {
      const body = await readBody(req);
      const pokeUserId = req.headers["x-poke-user-id"] as string | undefined;
      const server = buildServer(cfg, pokeUserId);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      log.error("MCP request failed:", String(error));
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          }),
        );
      }
    }
  });

  httpServer.listen(cfg.mcpPort, () => {
    log.section(`Sentinel MCP server on http://localhost:${cfg.mcpPort}/mcp`);
  });
  return httpServer;
}

/** The `mcp` command: MCP control server only (no watcher loop). */
export async function runMcpServer(cfg: Config): Promise<void> {
  startMcpServer(cfg);
}
