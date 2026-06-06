import { execSync, ExecSyncOptions } from "child_process";

export interface RunResult {
  ok: boolean;
  output: string;
  code: number;
}

/**
 * Run a shell command, capturing combined stdout/stderr without throwing.
 * Use this when we want to inspect failures (e.g. the test command) instead of
 * crashing the pipeline.
 */
export function run(command: string, options: ExecSyncOptions = {}): RunResult {
  try {
    const output = execSync(command, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 50 * 1024 * 1024,
      ...options,
    }).toString();
    return { ok: true, output, code: 0 };
  } catch (error: any) {
    const stdout = error?.stdout?.toString() ?? "";
    const stderr = error?.stderr?.toString() ?? "";
    return {
      ok: false,
      output: `${stdout}${stderr}` || String(error?.message ?? error),
      code: typeof error?.status === "number" ? error.status : 1,
    };
  }
}

/** Run a command and throw if it fails. Use for steps that must succeed. */
export function runOrThrow(command: string, options: ExecSyncOptions = {}): string {
  const result = run(command, options);
  if (!result.ok) {
    throw new Error(`Command failed (${command}):\n${result.output}`);
  }
  return result.output;
}
