import { Config, branchForIssue } from "../config";
import { deleteRemoteBranch } from "../lib/git";
import { commentOnIssue, createDraftPrAndMerge } from "../lib/github";
import { defaultBranch } from "../lib/git";
import { sendToPoke } from "../lib/poke";
import { log } from "../logger";

export type Decision = "approve" | "decline";

/**
 * Phase 5: act on the human decision relayed from Poke.
 * - approve -> draft PR + auto-merge
 * - decline -> delete the branch (the workflow emails the logs)
 */
export async function runFinalize(cfg: Config): Promise<void> {
  const ctx = cfg.repoContext;
  const decision = (process.env.DECISION ?? "").toLowerCase() as Decision;
  const branch =
    process.env.BRANCH || (ctx.number ? branchForIssue(ctx.number) : "");

  if (!branch) throw new Error("No branch provided to finalize.");
  if (decision !== "approve" && decision !== "decline") {
    throw new Error(`DECISION must be 'approve' or 'decline' (got '${decision}').`);
  }

  const remote = `${ctx.owner}/${ctx.repo}`;
  log.section(`Finalizing '${decision}' for ${branch}`);

  if (decision === "approve") {
    const url = createDraftPrAndMerge({
      branch,
      base: defaultBranch(),
      title: `Sentinel-Dev: fix for #${ctx.number}`,
      body: `Automated fix by Sentinel-Dev for #${ctx.number}. Approved via Poke.`,
    });
    if (ctx.number) {
      commentOnIssue(ctx.number, `Sentinel-Dev fix merged: ${url}`);
    }
    await sendToPoke(cfg, `Approved. Sentinel-Dev merged ${branch}: ${url}`);
    return;
  }

  // decline
  deleteRemoteBranch(branch, cfg.githubToken, remote);
  if (ctx.number) {
    commentOnIssue(
      ctx.number,
      `Sentinel-Dev fix on ${branch} was declined. Branch deleted; logs emailed to ${cfg.notifyEmail}.`,
    );
  }
  await sendToPoke(
    cfg,
    `Declined. Sentinel-Dev deleted ${branch} and emailed the logs to ${cfg.notifyEmail}.`,
  );
}
