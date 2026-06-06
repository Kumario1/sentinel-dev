import * as fs from "fs";
import * as path from "path";

/**
 * Minimal .env loader (no dependency). Reads KEY=VALUE lines from the given
 * file and sets them on process.env *without* overriding values already set
 * (so explicit exports and CI secrets always win). Quotes are stripped.
 */
export function loadDotEnv(file = ".env"): void {
  let raw: string;
  try {
    raw = fs.readFileSync(path.resolve(process.cwd(), file), "utf8");
  } catch {
    return; // no .env is fine
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = val;
  }
}
