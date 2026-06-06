import { log } from "../logger";

/**
 * Minimal GitHub REST client (native fetch) used by the MCP server to drive the
 * existing Sentinel workflows from the Poke app:
 *   - trigger_fix  -> add the `Sentinel-Fix` label    (fires sentinel.yml)
 *   - approve/decline -> repository_dispatch events   (fires sentinel-approval.yml)
 *   - list / diff  -> read repo state for review
 */

const API = "https://api.github.com";

export interface GitHubRepo {
  owner: string;
  repo: string;
  token: string;
}

/** Parse an "owner/repo" slug into a GitHubRepo with the given token. */
export function repoFromSlug(slug: string, token: string): GitHubRepo {
  const [owner, repo] = slug.split("/");
  if (!owner || !repo) throw new Error(`Invalid repo slug: "${slug}"`);
  return { owner, repo, token };
}

export const slug = (repo: GitHubRepo) => `${repo.owner}/${repo.repo}`;

/** The authenticated user's login (for greetings / scoping). */
export async function currentUser(token: string): Promise<string> {
  const me: any = await ghToken(token, `/user`);
  return me?.login ?? "unknown";
}

/**
 * Discover repos the authenticated user can push to, most-recently-pushed first.
 * Lets the watcher run with no WATCH_REPOS configured.
 */
export async function listAccessibleRepos(
  token: string,
  max = 20,
): Promise<string[]> {
  const slugs: string[] = [];
  for (let page = 1; page <= 5 && slugs.length < max; page++) {
    const repos: any[] = await ghToken(
      token,
      `/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`,
    );
    if (repos.length === 0) break;
    for (const r of repos) {
      if (r.archived) continue;
      if (r.permissions && !r.permissions.push) continue;
      slugs.push(r.full_name);
      if (slugs.length >= max) break;
    }
    if (repos.length < 100) break;
  }
  return slugs;
}

async function ghToken(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "sentinel-dev",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub ${path} -> ${res.status}: ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json();
}

const gh = (repo: GitHubRepo, path: string, init: RequestInit = {}) =>
  ghToken(repo.token, path, init);

/** Fire a repository_dispatch event consumed by sentinel-approval.yml. */
export async function dispatch(
  repo: GitHubRepo,
  eventType: "sentinel-approve" | "sentinel-decline",
  payload: { branch: string; issue: number },
): Promise<void> {
  await gh(repo, `/repos/${repo.owner}/${repo.repo}/dispatches`, {
    method: "POST",
    body: JSON.stringify({ event_type: eventType, client_payload: payload }),
  });
  log.info(`Dispatched ${eventType} for ${payload.branch}`);
}

/** Add the Sentinel-Fix label to an issue, which triggers sentinel.yml. */
export async function addFixLabel(
  repo: GitHubRepo,
  issue: number,
  label = "Sentinel-Fix",
): Promise<void> {
  await gh(repo, `/repos/${repo.owner}/${repo.repo}/issues/${issue}/labels`, {
    method: "POST",
    body: JSON.stringify({ labels: [label] }),
  });
  log.info(`Labeled #${issue} with ${label}`);
}

export interface OpenFix {
  issue: number;
  title: string;
  branch: string | null;
  url: string;
}

/** Open issues carrying the Sentinel-Fix label, plus any pending fix branch. */
export async function listOpenFixes(repo: GitHubRepo): Promise<OpenFix[]> {
  const issues: any[] = await gh(
    repo,
    `/repos/${repo.owner}/${repo.repo}/issues?state=open&labels=Sentinel-Fix&per_page=50`,
  );
  const branches: any[] = await gh(
    repo,
    `/repos/${repo.owner}/${repo.repo}/branches?per_page=100`,
  );
  const branchNames = new Set(branches.map((b) => b.name));
  return issues
    .filter((i) => !i.pull_request)
    .map((i) => {
      const branch = `sentinel/fix-issue-${i.number}`;
      return {
        issue: i.number,
        title: i.title,
        branch: branchNames.has(branch) ? branch : null,
        url: i.html_url,
      };
    });
}

export interface IssueRef {
  number: number;
  title: string;
  body: string;
  url: string;
  updatedAt: string;
}

/**
 * Open issues (excluding PRs), newest activity first. Optional label filter and
 * `since` (ISO timestamp) so the watcher only pulls recently-touched issues.
 */
export async function listOpenIssues(
  repo: GitHubRepo,
  opts: { label?: string; since?: string } = {},
): Promise<IssueRef[]> {
  const params = new URLSearchParams({
    state: "open",
    sort: "created",
    direction: "desc",
    per_page: "50",
  });
  if (opts.label) params.set("labels", opts.label);
  if (opts.since) params.set("since", opts.since);
  const issues: any[] = await gh(
    repo,
    `/repos/${repo.owner}/${repo.repo}/issues?${params.toString()}`,
  );
  return issues
    .filter((i) => !i.pull_request)
    .map((i) => ({
      number: i.number,
      title: i.title,
      body: i.body ?? "",
      url: i.html_url,
      updatedAt: i.updated_at,
    }));
}

/** Fetch a single issue's details. */
export async function getIssue(
  repo: GitHubRepo,
  issue: number,
): Promise<IssueRef> {
  const i: any = await gh(
    repo,
    `/repos/${repo.owner}/${repo.repo}/issues/${issue}`,
  );
  return {
    number: i.number,
    title: i.title,
    body: i.body ?? "",
    url: i.html_url,
    updatedAt: i.updated_at,
  };
}

/** Post a comment on an issue (used to mention @cursor or relay instructions). */
export async function commentOnIssue(
  repo: GitHubRepo,
  issue: number,
  body: string,
): Promise<void> {
  await gh(repo, `/repos/${repo.owner}/${repo.repo}/issues/${issue}/comments`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
  log.info(`Commented on ${slug(repo)}#${issue}`);
}

export interface PrRef {
  number: number;
  title: string;
  url: string;
  branch: string;
  draft: boolean;
}

/**
 * Best-effort: find an open PR that addresses an issue. Cursor names its
 * branches `cursor/…` and references the issue in the PR body, so we match on
 * either the branch prefix or a `#<issue>` reference.
 */
export async function findOpenPrForIssue(
  repo: GitHubRepo,
  issue: number,
): Promise<PrRef | null> {
  const pulls: any[] = await gh(
    repo,
    `/repos/${repo.owner}/${repo.repo}/pulls?state=open&per_page=100`,
  );
  const needle = new RegExp(`#${issue}\\b`);
  const match =
    pulls.find((p) => needle.test(`${p.title}\n${p.body ?? ""}`)) ??
    pulls.find((p) => (p.head?.ref ?? "").includes(`issue-${issue}`));
  if (!match) return null;
  return {
    number: match.number,
    title: match.title,
    url: match.html_url,
    branch: match.head?.ref ?? "",
    draft: !!match.draft,
  };
}

/** Mark a draft PR ready (if needed) and squash-merge it. */
export async function mergePr(repo: GitHubRepo, pr: PrRef): Promise<void> {
  if (pr.draft) {
    log.warn(`PR #${pr.number} is a draft; cannot merge via API until ready.`);
  }
  await gh(repo, `/repos/${repo.owner}/${repo.repo}/pulls/${pr.number}/merge`, {
    method: "PUT",
    body: JSON.stringify({ merge_method: "squash" }),
  });
  log.info(`Merged ${slug(repo)} PR #${pr.number}`);
}

/** Close a PR without merging (decline). */
export async function closePr(repo: GitHubRepo, pr: PrRef): Promise<void> {
  await gh(repo, `/repos/${repo.owner}/${repo.repo}/pulls/${pr.number}`, {
    method: "PATCH",
    body: JSON.stringify({ state: "closed" }),
  });
  log.info(`Closed ${slug(repo)} PR #${pr.number}`);
}

/** Unified diff between the repo's default branch and a fix branch. */
export async function getBranchDiff(
  repo: GitHubRepo,
  branch: string,
  maxChars = 6000,
): Promise<string> {
  const info: any = await gh(repo, `/repos/${repo.owner}/${repo.repo}`);
  const base = info.default_branch ?? "main";
  const cmp: any = await gh(
    repo,
    `/repos/${repo.owner}/${repo.repo}/compare/${base}...${branch}`,
  );
  const patch = (cmp.files ?? [])
    .map((f: any) => `--- ${f.filename}\n${f.patch ?? "(binary or no patch)"}`)
    .join("\n\n");
  if (!patch) return `No differences between ${base} and ${branch}.`;
  return patch.length > maxChars
    ? `${patch.slice(0, maxChars)}\n… (diff truncated)`
    : patch;
}
