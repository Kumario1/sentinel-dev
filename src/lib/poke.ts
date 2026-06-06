import { Config } from "../config";
import { log } from "../logger";

/**
 * Send a message to Poke's inbound API. Poke then texts it to your phone.
 * Defaults to the V2 endpoint (https://poke.com/api/v1/inbound/api-message);
 * override POKE_WEBHOOK_URL for the legacy HackMIT endpoint.
 */
export async function sendToPoke(
  cfg: Config,
  message: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  if (!cfg.pokeApiKey) {
    log.warn("POKE_API_KEY not set; skipping Poke notification.");
    log.info(message);
    return;
  }
  const res = await fetch(cfg.pokeWebhookUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.pokeApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message, source: "sentinel-dev", ...metadata }),
  });
  if (!res.ok) {
    throw new Error(`Poke webhook error ${res.status}: ${await res.text()}`);
  }
  log.info("Pushed update to Poke.");
}

/**
 * #2: Incremental progress ping. No-op (with a log line) unless POKE_PROGRESS
 * is enabled, so we don't spam the conversation by default in CI.
 */
export async function sendProgress(cfg: Config, message: string): Promise<void> {
  if (!cfg.pokeProgress) {
    log.info(`(progress) ${message}`);
    return;
  }
  try {
    await sendToPoke(cfg, message, { kind: "progress" });
  } catch (error) {
    // Progress is best-effort; never fail the pipeline over a status ping.
    log.warn(`Progress ping failed: ${String(error)}`);
  }
}

export function buildApprovalMessage(args: {
  owner: string;
  repo: string;
  issue: number;
  title: string;
  branch: string;
  summary: string;
  diffStat: string;
  diff: string;
  runUrl: string;
}): string {
  return [
    `Sentinel-Dev proposed a fix for ${args.owner}/${args.repo} #${args.issue}: ` +
      `${args.title || "(untitled)"}`,
    ``,
    `Why this works: ${args.summary}`,
    ``,
    `Branch: ${args.branch}`,
    `Changed files:`,
    args.diffStat || "(no diff stat)",
    ``,
    `Diff:`,
    "```diff",
    args.diff || "(no diff captured)",
    "```",
    ``,
    `Run: ${args.runUrl}`,
    ``,
    `Reply "approve" to open a draft PR and auto-merge it, or "decline" to ` +
      `discard the branch — I'll take it from here.`,
  ].join("\n");
}
