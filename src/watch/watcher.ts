import * as fs from "fs";
import { Config } from "../config";
import {
  GitHubRepo,
  IssueRef,
  listAccessibleRepos,
  listOpenIssues,
  repoFromSlug,
  slug,
} from "../lib/githubApi";
import { requestFix } from "../lib/trigger";
import { log } from "../logger";

interface PersistedState {
  /** Keys ("owner/repo#123") of issues we've already acted on. */
  handled: string[];
}

export interface ActiveFix {
  repo: string;
  issue: number;
  title: string;
  url: string;
  startedAt: string;
}

/**
 * Polls the configured repos for new issues and kicks off a fix for each,
 * reporting to Poke. A single instance is shared with the MCP server so the
 * user can pause/resume and inspect what's in flight from the Poke app.
 */
export class IssueWatcher {
  paused = false;
  readonly active = new Map<string, ActiveFix>();
  private handled = new Set<string>();
  private timer?: NodeJS.Timeout;
  private resolvedRepos?: GitHubRepo[];

  constructor(private readonly cfg: Config) {
    this.load();
  }

  /** Slugs from explicit config or the GitHub Actions context (no discovery). */
  private configuredSlugs(): string[] {
    if (this.cfg.watchRepos.length) return this.cfg.watchRepos;
    const ctx = `${this.cfg.repoContext.owner}/${this.cfg.repoContext.repo}`;
    return ctx.startsWith("/") || ctx === "/" ? [] : [ctx];
  }

  /** Resolve the repos to watch, auto-discovering from the token if none given. */
  private async resolveRepos(): Promise<GitHubRepo[]> {
    if (this.resolvedRepos) return this.resolvedRepos;
    let slugs = this.configuredSlugs();
    if (slugs.length === 0) {
      if (!this.cfg.githubToken) {
        throw new Error(
          "No GitHub auth. Run `sentinel login` (or `gh auth login`), " +
            "or set GITHUB_TOKEN.",
        );
      }
      slugs = await listAccessibleRepos(
        this.cfg.githubToken,
        this.cfg.watchMaxRepos,
      );
      log.info(`Auto-discovered ${slugs.length} repo(s): ${slugs.join(", ")}`);
    }
    this.resolvedRepos = slugs
      .filter((s) => s && !s.startsWith("/"))
      .map((s) => repoFromSlug(s, this.cfg.githubToken));
    return this.resolvedRepos;
  }

  /** Currently-known repos (resolved during start(); config fallback otherwise). */
  private repos(): GitHubRepo[] {
    if (this.resolvedRepos) return this.resolvedRepos;
    return this.configuredSlugs()
      .filter((s) => s && !s.startsWith("/"))
      .map((s) => repoFromSlug(s, this.cfg.githubToken));
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.cfg.stateFile, "utf8");
      const parsed = JSON.parse(raw) as PersistedState;
      this.handled = new Set(parsed.handled ?? []);
    } catch {
      this.handled = new Set();
    }
  }

  private save(): void {
    try {
      const data: PersistedState = { handled: [...this.handled] };
      fs.writeFileSync(this.cfg.stateFile, JSON.stringify(data, null, 2));
    } catch (error) {
      log.warn(`Could not persist watcher state: ${String(error)}`);
    }
  }

  /** Seed already-open issues as "seen" so we only act on new ones going forward. */
  private async baseline(): Promise<void> {
    if (this.handled.size > 0) return; // resuming from prior state
    if ((process.env.WATCH_BACKFILL ?? "false").toLowerCase() === "true") return;
    for (const repo of await this.resolveRepos()) {
      try {
        const issues = await listOpenIssues(repo, { label: this.cfg.watchLabel });
        issues.forEach((i) => this.handled.add(`${slug(repo)}#${i.number}`));
      } catch (error) {
        log.warn(`Baseline failed for ${slug(repo)}: ${String(error)}`);
      }
    }
    this.save();
    log.info(`Baselined ${this.handled.size} existing issue(s) as seen.`);
  }

  private async handleIssue(repo: GitHubRepo, issue: IssueRef): Promise<void> {
    const key = `${slug(repo)}#${issue.number}`;
    this.active.set(key, {
      repo: slug(repo),
      issue: issue.number,
      title: issue.title,
      url: issue.url,
      startedAt: new Date().toISOString(),
    });
    try {
      const what = await requestFix(this.cfg, repo, issue);
      this.handled.add(key);
      this.save();
      log.info(`Handled ${key}: ${what}.`);
    } catch (error) {
      log.error(`Failed to handle ${key}: ${String(error)}`);
      this.active.delete(key);
    }
  }

  /** One polling pass across all watched repos. */
  async tick(): Promise<void> {
    if (this.paused) return;
    for (const repo of await this.resolveRepos()) {
      let issues: IssueRef[];
      try {
        issues = await listOpenIssues(repo, { label: this.cfg.watchLabel });
      } catch (error) {
        log.warn(`Poll failed for ${slug(repo)}: ${String(error)}`);
        continue;
      }
      for (const issue of issues) {
        const key = `${slug(repo)}#${issue.number}`;
        if (this.handled.has(key)) continue;
        log.section(`Watcher: new issue ${key}`);
        await this.handleIssue(repo, issue);
      }
    }
  }

  async start(): Promise<void> {
    await this.resolveRepos();
    await this.baseline();
    const repos = this.repos().map(slug).join(", ");
    log.section(
      `Watching ${repos} every ${Math.round(this.cfg.watchIntervalMs / 1000)}s ` +
        `(engine: ${this.cfg.fixEngine}, label: ${this.cfg.watchLabel || "any"})`,
    );
    const loop = async () => {
      try {
        await this.tick();
      } catch (error) {
        log.error(`Watcher tick error: ${String(error)}`);
      }
    };
    await loop();
    this.timer = setInterval(loop, this.cfg.watchIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  status(): { paused: boolean; watching: string[]; active: ActiveFix[] } {
    return {
      paused: this.paused,
      watching: this.repos().map(slug),
      active: [...this.active.values()],
    };
  }
}

let singleton: IssueWatcher | undefined;

/** Shared watcher instance so the MCP tools can control the running watcher. */
export function getWatcher(cfg: Config): IssueWatcher {
  if (!singleton) singleton = new IssueWatcher(cfg);
  return singleton;
}
