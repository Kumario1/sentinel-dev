import * as fs from "fs";
import * as path from "path";

// Tee everything we log to sentinel.log so the workflow can attach it to the
// failure / decline email and upload it as an artifact.
const LOG_FILE = path.resolve(process.cwd(), "sentinel.log");

function write(level: string, args: unknown[]): void {
  const line = `[${new Date().toISOString()}] [${level}] ${args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a, null, 2)))
    .join(" ")}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    // Best-effort: never let logging crash the pipeline.
  }
}

export const log = {
  info(...args: unknown[]): void {
    console.log(...args);
    write("INFO", args);
  },
  warn(...args: unknown[]): void {
    console.warn(...args);
    write("WARN", args);
  },
  error(...args: unknown[]): void {
    console.error(...args);
    write("ERROR", args);
  },
  section(title: string): void {
    const banner = `\n=== ${title} ===`;
    console.log(banner);
    write("INFO", [banner]);
  },
};
