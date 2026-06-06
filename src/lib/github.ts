import { run, runOrThrow } from "./exec";
import { log } from "../logger";

/**
 * Thin wrapper over the gh CLI (pre-installed on GitHub-hosted runners and
 * authenticated via GITHUB_TOKEN in the environment).
 */

export interface CreatePrArgs {
  branch: string;
  base: string;
  title: string;
  body: string;
}

/** 5. Open a draft PR and merge it automatically. Returns the PR URL. */
export function createDraftPrAndMerge(args: CreatePrArgs): string {
  log.section(`Opening draft PR for ${args.branch}`);
  const url = runOrThrow(
    `gh pr create --draft --base ${args.base} --head ${args.branch} ` +
      `--title ${JSON.stringify(args.title)} --body ${JSON.stringify(args.body)}`,
  ).trim();
  log.info(`Draft PR: ${url}`);

  // A PR cannot be merged while it is still a draft, so mark it ready first.
  runOrThrow(`gh pr ready ${args.branch}`);
  log.section("Merging PR");
  runOrThrow(`gh pr merge ${args.branch} --squash --admin --delete-branch`);
  log.info("PR merged.");
  return url;
}

export function commentOnIssue(issue: number, body: string): void {
  run(`gh issue comment ${issue} --body ${JSON.stringify(body)}`);
}
