import * as readline from "readline/promises";
import { stdin, stdout } from "process";
import { Config } from "../config";
import {
  GitHubRepo,
  closePr,
  currentUser,
  findOpenPrForIssue,
  listAccessibleRepos,
  listOpenIssues,
  mergePr,
  repoFromSlug,
} from "../lib/githubApi";
import { requestFix } from "../lib/trigger";
import { runServe } from "../commands/serve";
import { log } from "../logger";

type RL = readline.Interface;

const BANNER = `
  ┌──────────────────────────────────────────────┐
  │   Sentinel-Dev — autonomous issue fixer        │
  └──────────────────────────────────────────────┘`;

/** Parse "1,3,5" / "all" / "1-3" against a list length into 0-based indices. */
function parseSelection(input: string, length: number): number[] {
  const t = input.trim().toLowerCase();
  if (t === "all" || t === "*") return [...Array(length).keys()];
  const out = new Set<number>();
  for (const part of t.split(",").map((p) => p.trim()).filter(Boolean)) {
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) {
      const [a, b] = [Number(range[1]), Number(range[2])].sort((x, y) => x - y);
      for (let i = a; i <= b; i++) if (i >= 1 && i <= length) out.add(i - 1);
    } else {
      const n = Number(part);
      if (n >= 1 && n <= length) out.add(n - 1);
    }
  }
  return [...out];
}

async function pickRepo(rl: RL, repos: string[]): Promise<string | null> {
  repos.forEach((r, i) => console.log(`  ${String(i + 1).padStart(2)}. ${r}`));
  const answer = await rl.question("\nRepo number (or blank to go back): ");
  const idx = Number(answer.trim()) - 1;
  if (!answer.trim() || idx < 0 || idx >= repos.length) return null;
  return repos[idx];
}

/** Browse a repo's open issues and trigger a fix for the chosen one(s). */
async function fixAnIssue(
  rl: RL,
  cfg: Config,
  repos: string[],
): Promise<void> {
  const repoSlug = await pickRepo(rl, repos);
  if (!repoSlug) return;
  const repo: GitHubRepo = repoFromSlug(repoSlug, cfg.githubToken);

  console.log(`\nFetching open issues in ${repoSlug}…`);
  const issues = await listOpenIssues(repo, { label: cfg.watchLabel });
  if (issues.length === 0) {
    console.log("No open issues found.");
    return;
  }
  issues.forEach((iss, i) =>
    console.log(`  ${String(i + 1).padStart(2)}. #${iss.number} ${iss.title}`),
  );

  const sel = await rl.question(
    "\nIssue number(s) to fix (e.g. 1,3 or 1-2, blank to cancel): ",
  );
  const picks = parseSelection(sel, issues.length);
  if (picks.length === 0) {
    console.log("Cancelled.");
    return;
  }

  const chosen = picks.map((i) => issues[i]);
  console.log(
    `\nWill fix (engine: ${cfg.fixEngine}):\n` +
      chosen.map((c) => `  • #${c.number} ${c.title}`).join("\n"),
  );
  const ok = await rl.question("Proceed? (y/N): ");
  if (ok.trim().toLowerCase() !== "y") {
    console.log("Cancelled.");
    return;
  }

  for (const issue of chosen) {
    try {
      const what = await requestFix(cfg, repo, issue);
      console.log(`  ✓ #${issue.number}: ${what}`);
    } catch (error) {
      console.log(`  ✗ #${issue.number}: ${String(error)}`);
    }
  }
}

/** Approve (merge) or decline (close) the PR addressing an issue. */
async function reviewAFix(rl: RL, cfg: Config, repos: string[]): Promise<void> {
  const repoSlug = await pickRepo(rl, repos);
  if (!repoSlug) return;
  const repo = repoFromSlug(repoSlug, cfg.githubToken);

  const num = Number((await rl.question("Issue number: ")).trim());
  if (!num) return;
  const pr = await findOpenPrForIssue(repo, num);
  if (!pr) {
    console.log(`No open PR found for #${num} yet.`);
    return;
  }
  const action = await rl.question(
    `Found PR #${pr.number} (${pr.url}). [a]pprove/merge, [d]ecline/close, or blank: `,
  );
  const a = action.trim().toLowerCase();
  if (a === "a") {
    await mergePr(repo, pr);
    console.log(`  ✓ Merged PR #${pr.number}`);
  } else if (a === "d") {
    await closePr(repo, pr);
    console.log(`  ✓ Closed PR #${pr.number}`);
  } else {
    console.log("No action taken.");
  }
}

/** Select repos to watch, then hand off to the always-on serve loop. */
async function startWatching(
  rl: RL,
  cfg: Config,
  repos: string[],
): Promise<boolean> {
  console.log("\nSelect repos to watch:");
  repos.forEach((r, i) => console.log(`  ${String(i + 1).padStart(2)}. ${r}`));
  const sel = await rl.question(
    "\nNumbers (e.g. 1,3 or 1-4), 'all', or blank to cancel: ",
  );
  const picks = parseSelection(sel, repos.length);
  if (picks.length === 0) {
    console.log("Cancelled.");
    return false;
  }
  const chosen = picks.map((i) => repos[i]);
  console.log(`\nWatching: ${chosen.join(", ")}`);
  const label = await rl.question(
    "Only fix issues with a label? (enter label, or blank for all issues): ",
  );

  cfg.watchRepos = chosen;
  if (label.trim()) cfg.watchLabel = label.trim();

  rl.close();
  await runServe(cfg); // runs until Ctrl+C
  return true;
}

export async function runCli(cfg: Config): Promise<void> {
  console.log(BANNER);
  if (!cfg.githubToken) {
    console.log(
      "\nNot authenticated. Run `npm run login` (or set GITHUB_TOKEN) first.\n",
    );
    return;
  }

  const user = await currentUser(cfg.githubToken);
  console.log(`\nSigned in as ${user}. Fix engine: ${cfg.fixEngine}.`);
  console.log("Discovering repos you can push to…");
  const repos = cfg.watchRepos.length
    ? cfg.watchRepos
    : await listAccessibleRepos(cfg.githubToken, cfg.watchMaxRepos);
  console.log(`Found ${repos.length} repo(s).`);

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    for (;;) {
      console.log(
        [
          "\n──────── Menu ────────",
          "  1. Fix an issue now",
          "  2. Start watching repos (always-on)",
          "  3. Review a fix (approve/decline a PR)",
          "  4. List watchable repos",
          "  5. Quit",
        ].join("\n"),
      );
      const choice = (await rl.question("Choose 1-5: ")).trim();
      if (choice === "1") await fixAnIssue(rl, cfg, repos);
      else if (choice === "2") {
        const handed = await startWatching(rl, cfg, repos);
        if (handed) return; // serve took over the process
      } else if (choice === "3") await reviewAFix(rl, cfg, repos);
      else if (choice === "4")
        repos.forEach((r, i) => console.log(`  ${i + 1}. ${r}`));
      else if (choice === "5" || choice.toLowerCase() === "q") {
        console.log("Bye.");
        return;
      } else console.log("Pick a number 1-5.");
    }
  } catch (error) {
    log.error("CLI error:", String(error));
  } finally {
    rl.close();
  }
}
