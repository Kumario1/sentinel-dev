import { execSync } from "child_process";
import { Config } from "../config";
import { currentUser, listAccessibleRepos } from "../lib/githubApi";
import { run } from "../lib/exec";
import { log } from "../logger";

/**
 * `login` — make sure we have GitHub auth without the user fiddling with PATs.
 * If `gh` is already authenticated we just confirm; otherwise we kick off the
 * interactive `gh auth login` flow.
 */
export async function runAuth(cfg: Config): Promise<void> {
  const ghPresent = run("gh --version").ok;
  if (!ghPresent) {
    throw new Error(
      "GitHub CLI (`gh`) not found. Install it (https://cli.github.com) and " +
        "re-run `sentinel login`, or set GITHUB_TOKEN.",
    );
  }

  if (!run("gh auth status").ok) {
    log.section("Launching `gh auth login`…");
    execSync("gh auth login --git-protocol https --web", { stdio: "inherit" });
  }

  const token = run("gh auth token").output.trim();
  if (!token) throw new Error("Login did not produce a token. Try `gh auth login`.");

  const user = await currentUser(token);
  const repos = await listAccessibleRepos(token, cfg.watchMaxRepos);
  log.section(`Authenticated as ${user}`);
  log.info(
    `Sentinel can watch ${repos.length} repo(s) (most recent first):\n` +
      repos.map((r) => `  • ${r}`).join("\n"),
  );
  log.info(
    `\nReady. Run \`npm run serve\` to start watching. ` +
      `Set WATCH_REPOS to narrow the list if you don't want all of them.`,
  );
}
