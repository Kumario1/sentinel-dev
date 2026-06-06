import { Config } from "../config";
import { GitHubRepo, IssueRef, commentOnIssue, slug } from "./githubApi";
import { log } from "../logger";

/**
 * Delegate the actual code-writing to a Cursor background agent by mentioning
 * Cursor's GitHub App on the issue. Cursor reads the issue, opens a branch,
 * implements the fix, and opens a PR — Sentinel just orchestrates and reports.
 *
 * Requires the Cursor GitHub App installed on the repo with write access.
 */
export async function delegateToCursor(
  cfg: Config,
  repo: GitHubRepo,
  issue: IssueRef,
): Promise<void> {
  const body = [
    `${cfg.cursorMention} please fix this issue.`,
    ``,
    `Investigate the root cause, make a minimal correct change, add or update`,
    `tests, and open a pull request that references #${issue.number}.`,
  ].join("\n");
  await commentOnIssue(repo, issue.number, body);
  log.info(`Delegated ${slug(repo)}#${issue.number} to Cursor.`);
}

/** Relay a follow-up instruction from the user to the Cursor agent. */
export async function instructCursor(
  cfg: Config,
  repo: GitHubRepo,
  issue: number,
  instruction: string,
): Promise<void> {
  await commentOnIssue(
    repo,
    issue,
    `${cfg.cursorMention} ${instruction}`,
  );
  log.info(`Relayed instruction to Cursor on ${slug(repo)}#${issue}.`);
}
