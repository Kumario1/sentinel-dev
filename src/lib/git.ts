import * as fs from "fs";
import * as path from "path";
import { run, runOrThrow } from "./exec";
import { FilePatch } from "./llm";
import { log } from "../logger";

export function configureBot(): void {
  run(`git config user.name "sentinel-dev[bot]"`);
  run(`git config user.email "sentinel-dev[bot]@users.noreply.github.com"`);
}

export function defaultBranch(): string {
  const result = run("git symbolic-ref refs/remotes/origin/HEAD");
  if (result.ok) {
    return result.output.trim().replace("refs/remotes/origin/", "");
  }
  return "main";
}

export function createBranch(branch: string, base: string): void {
  log.section(`Creating branch ${branch} from ${base}`);
  // Reset to a clean copy of base so the patch is the only change.
  run(`git checkout ${base}`);
  run(`git branch -D ${branch}`); // ignore if it doesn't exist
  runOrThrow(`git checkout -b ${branch}`);
}

/** Write each proposed file to disk, creating parent dirs as needed. */
export function applyPatch(files: FilePatch[]): string[] {
  const written: string[] = [];
  for (const file of files) {
    const target = path.resolve(process.cwd(), file.path);
    if (!target.startsWith(process.cwd())) {
      throw new Error(`Refusing to write outside the repo: ${file.path}`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content);
    written.push(file.path);
    log.info(`Wrote ${file.path}`);
  }
  return written;
}

export interface CommitResult {
  committed: boolean;
  diffStat: string;
  /** Full unified diff of the staged change (truncated for messaging). */
  diff: string;
}

const MAX_DIFF_CHARS = 6000;

export function commitAll(message: string): CommitResult {
  run("git add -A");
  const status = run("git status --porcelain");
  if (!status.output.trim()) {
    log.warn("No changes to commit (LLM patch was a no-op).");
    return { committed: false, diffStat: "", diff: "" };
  }
  const diffStat = run("git diff --cached --stat").output.trim();
  const fullDiff = run("git diff --cached").output.trim();
  const diff =
    fullDiff.length > MAX_DIFF_CHARS
      ? `${fullDiff.slice(0, MAX_DIFF_CHARS)}\n… (diff truncated)`
      : fullDiff;
  runOrThrow(`git commit -m ${JSON.stringify(message)}`);
  return { committed: true, diffStat, diff };
}

export function pushBranch(branch: string, token: string, remote: string): void {
  log.section(`Pushing ${branch}`);
  // Authenticated push URL so GITHUB_TOKEN can create the ref.
  const authUrl = `https://x-access-token:${token}@github.com/${remote}.git`;
  runOrThrow(`git push ${JSON.stringify(authUrl)} ${branch} --force`);
}

export function deleteRemoteBranch(branch: string, token: string, remote: string): void {
  const authUrl = `https://x-access-token:${token}@github.com/${remote}.git`;
  run(`git push ${JSON.stringify(authUrl)} --delete ${branch}`);
  log.info(`Deleted remote branch ${branch}`);
}
