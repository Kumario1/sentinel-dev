import { Config } from "../config";
import { sendToPoke } from "../lib/poke";
import { log } from "../logger";

/**
 * `ping` — send a test message to Poke so you can confirm outbound wiring.
 * Optional custom text: `npm run ping -- "your message"`.
 */
export async function runPing(cfg: Config): Promise<void> {
  if (!cfg.pokeApiKey) {
    throw new Error(
      "POKE_API_KEY is not set. Add it to .env or export it, then retry.",
    );
  }
  const custom = process.argv[3];
  // The inbound API hands the message to your Poke agent, which decides what to
  // do — so a connectivity test must explicitly ask Poke to message you back,
  // otherwise nothing visible happens even though the API returns success.
  const message =
    custom ||
    'Connectivity test from Sentinel-Dev. Please reply to me right now with ' +
      'exactly this text: "✅ Sentinel-Dev is connected to Poke."';
  await sendToPoke(cfg, message, { kind: "ping" });
  log.info(
    "Ping accepted by Poke's API. You should get a reply in the Poke app " +
      "shortly. If not, see the troubleshooting notes.",
  );
}
