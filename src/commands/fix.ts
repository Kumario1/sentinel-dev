import { Config, branchForIssue } from "../config";
import { runTestSuite } from "../lib/tests";
import { mapRepository, rankSuspects } from "../lib/ast";
import { generateFix } from "../lib/llm";
import {
  applyPatch,
  commitAll,
  configureBot,
  createBranch,
  defaultBranch,
  pushBranch,
} from "../lib/git";
import { buildApprovalMessage, sendProgress, sendToPoke } from "../lib/poke";
import { log } from "../logger";

/**
 * Phases 2-4: test -> AST map -> LLM patch -> branch + push -> ping Poke.
 */
export async function runFix(cfg: Config): Promise<void> {
  const ctx = cfg.repoContext;
  if (!ctx.number) {
    throw new Error("Could not resolve an issue/PR number from the event.");
  }
  log.section(`Sentinel-Dev starting for #${ctx.number}: ${ctx.title}`);
  await sendProgress(
    cfg,
    `Sentinel-Dev picked up #${ctx.number}: ${ctx.title || "(untitled)"}. Running the test suite…`,
  );

  // 2. Test suite.
  const tests = runTestSuite(cfg.testCommand);

  // 2. AST mapping + locate the buggy function/class.
  log.section("AST analysis");
  const symbols = mapRepository();
  const issueText = `${ctx.title}\n${ctx.body}`;
  const suspects = rankSuspects(symbols, issueText);
  const topSuspect = suspects[0];
  log.info(
    `Top suspects: ${suspects.map((s) => `${s.name} (${s.file}:${s.line})`).join(", ") ||
      "none matched"}`,
  );
  await sendProgress(
    cfg,
    `Tests ${tests.passed ? "passed" : "failed"} on #${ctx.number}. ` +
      (topSuspect
        ? `Prime suspect: ${topSuspect.name} (${topSuspect.file}:${topSuspect.line}). `
        : "No clear suspect from AST. ") +
      `Asking the ${cfg.llmProvider} model for a patch…`,
  );

  // 3. Ask the LLM for a patch.
  const proposal = await generateFix(cfg, {
    issueTitle: ctx.title,
    issueBody: ctx.body,
    testOutput: tests.output,
    testsPassed: tests.passed,
    suspects,
  });

  if (proposal.files.length === 0) {
    throw new Error("LLM returned no file changes.");
  }

  // 3. Branch, apply, commit, push.
  const base =
    ctx.eventName === "pull_request" && ctx.headRef
      ? ctx.headRef
      : defaultBranch();
  const branch = branchForIssue(ctx.number);

  configureBot();
  createBranch(branch, base);
  applyPatch(proposal.files);
  const commit = commitAll(
    `fix: Sentinel-Dev patch for #${ctx.number}\n\n${proposal.summary}`,
  );
  if (!commit.committed) {
    throw new Error("Patch produced no changes; nothing to push.");
  }
  pushBranch(branch, cfg.githubToken, `${ctx.owner}/${ctx.repo}`);

  // 4. Ping Poke for human approval.
  const runUrl = `${ctx.serverUrl}/${ctx.owner}/${ctx.repo}/actions/runs/${ctx.runId}`;
  const message = buildApprovalMessage({
    owner: ctx.owner,
    repo: ctx.repo,
    issue: ctx.number,
    title: ctx.title,
    branch,
    summary: proposal.summary,
    diffStat: commit.diffStat,
    diff: commit.diff,
    runUrl,
  });
  await sendToPoke(cfg, message, {
    branch,
    issue: ctx.number,
    diff_stat: commit.diffStat,
  });

  log.section("Awaiting your approval via Poke.");
}
