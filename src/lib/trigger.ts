import { Config } from "../config";
import { GitHubRepo, IssueRef, addFixLabel, slug } from "./githubApi";
import { delegateToCursor } from "./cursor";
import { sendToPoke } from "./poke";

const MAX_BODY = 1500;

function issueContext(repoSlug: string, issue: IssueRef): string {
  const body = issue.body
    ? issue.body.length > MAX_BODY
      ? `${issue.body.slice(0, MAX_BODY)}…`
      : issue.body
    : "(no description)";
  return [
    `Repo: ${repoSlug}`,
    `Issue #${issue.number}: ${issue.title}`,
    issue.url || "",
    ``,
    body,
  ]
    .filter(Boolean)
    .join("\n");
}

/** The user-facing Poke message for a triggered fix, tailored to the engine. */
function fixMessage(cfg: Config, repoSlug: string, issue: IssueRef): string {
  const ctx = issueContext(repoSlug, issue);
  const steer =
    `Reply to steer me: "approve #${issue.number}", "decline #${issue.number}", ` +
    `"tell it to <instruction> on #${issue.number}", or "pause".`;

  if (cfg.fixEngine === "poke") {
    return [
      `New GitHub issue to fix.`,
      ``,
      ctx,
      ``,
      `Please spin up a Cursor agent to fix this issue and open a pull request ` +
        `against ${repoSlug}. When the PR is ready, summarize the change and ask ` +
        `me to approve before merging.`,
    ].join("\n");
  }
  if (cfg.fixEngine === "cursor") {
    return [
      `Picked up ${repoSlug}#${issue.number}: ${issue.title}`,
      `Mentioned ${cfg.cursorMention} on the issue — Cursor will open a PR.`,
      issue.url || "",
      ``,
      steer,
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [
    `Picked up ${repoSlug}#${issue.number}: ${issue.title}`,
    `Added the Sentinel-Fix label — the in-repo workflow is running.`,
    issue.url || "",
    ``,
    steer,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Kick off a fix using the configured engine and notify Poke. Returns a short
 * description of the action taken.
 *  - "poke":     the Poke message itself is the trigger (Poke spins up Cursor).
 *  - "cursor":   mention @cursor on the issue, then notify.
 *  - "sentinel": add the Sentinel-Fix label, then notify.
 */
export async function requestFix(
  cfg: Config,
  repo: GitHubRepo,
  issue: IssueRef,
): Promise<string> {
  const repoSlug = slug(repo);
  let action: string;

  if (cfg.fixEngine === "cursor") {
    await delegateToCursor(cfg, repo, issue);
    action = "mentioned @cursor on the issue";
  } else if (cfg.fixEngine === "sentinel") {
    await addFixLabel(repo, issue.number);
    action = "added the Sentinel-Fix label";
  } else {
    action = "asked Poke to spin up a Cursor agent";
  }

  await sendToPoke(cfg, fixMessage(cfg, repoSlug, issue), {
    kind: "fix-request",
    repo: repoSlug,
    issue: issue.number,
  });
  return action;
}
