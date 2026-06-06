import { loadDotEnv } from "./lib/dotenv";
import { loadConfig } from "./config";
import { runFix } from "./commands/fix";
import { runFinalize } from "./commands/finalize";
import { runServe } from "./commands/serve";
import { runAuth } from "./commands/auth";
import { runPing } from "./commands/ping";
import { runCli } from "./cli/interactive";
import { runMcpServer } from "./mcp/server";
import { log } from "./logger";

async function main(): Promise<void> {
  loadDotEnv(); // pick up .env before reading config
  const command = process.argv[2] ?? "fix";
  const cfg = loadConfig();

  switch (command) {
    case "fix":
      await runFix(cfg);
      break;
    case "finalize":
      await runFinalize(cfg);
      break;
    case "serve":
      await runServe(cfg);
      break;
    case "login":
    case "auth":
      await runAuth(cfg);
      break;
    case "cli":
      await runCli(cfg);
      break;
    case "ping":
      await runPing(cfg);
      break;
    case "mcp":
      await runMcpServer(cfg);
      break;
    default:
      throw new Error(
        `Unknown command: ${command} ` +
          `(expected 'cli', 'fix', 'finalize', 'serve', 'login', 'ping', or 'mcp').`,
      );
  }
}

main().catch((error) => {
  log.error("Sentinel-Dev failed:", error?.stack ?? String(error));
  process.exit(1);
});
