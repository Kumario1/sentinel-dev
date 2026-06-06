import { Config } from "../config";
import { startMcpServer } from "../mcp/server";
import { getWatcher } from "../watch/watcher";
import { sendToPoke } from "../lib/poke";
import { log } from "../logger";

/**
 * The always-on mode: run the multi-repo issue watcher AND the MCP control
 * server in one process. The watcher pushes updates to Poke; you steer it back
 * through the MCP tools (pause/resume/instruct/approve/decline).
 */
export async function runServe(cfg: Config): Promise<void> {
  log.section("Sentinel-Dev: serve (watcher + MCP)");
  startMcpServer(cfg);

  const watcher = getWatcher(cfg);
  await sendToPoke(
    cfg,
    [
      `Sentinel-Dev is online (engine: ${cfg.fixEngine}).`,
      `Watching: ${watcher.status().watching.join(", ") || "(none configured)"}`,
      `I'll message you when I pick up an issue. Reply to steer me.`,
    ].join("\n"),
  ).catch((error) => log.warn(`Startup Poke ping failed: ${String(error)}`));

  await watcher.start();
  log.info("Watcher running. Press Ctrl+C to stop.");
}
