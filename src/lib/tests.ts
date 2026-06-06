import * as fs from "fs";
import * as path from "path";
import { run } from "./exec";
import { log } from "../logger";

export interface TestReport {
  command: string;
  passed: boolean;
  /** Trimmed combined output, used as the "error log" for the LLM. */
  output: string;
}

/**
 * Pick the project's standard test command. Honors an explicit override, then
 * falls back to npm test (JS/TS) or pytest (Python) based on repo markers.
 */
export function detectTestCommand(override?: string): string {
  if (override && override.trim()) return override.trim();

  const cwd = process.cwd();
  const pkgPath = path.join(cwd, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (pkg?.scripts?.test) return "npm test --silent";
    } catch {
      /* fall through */
    }
  }

  const pythonMarkers = ["pytest.ini", "pyproject.toml", "setup.cfg", "tox.ini"];
  if (pythonMarkers.some((m) => fs.existsSync(path.join(cwd, m)))) {
    return "pytest -q";
  }
  if (fs.existsSync(path.join(cwd, "requirements.txt"))) {
    return "pytest -q";
  }

  // Default assumption for this repo.
  return "npm test --silent";
}

export function runTestSuite(override?: string): TestReport {
  const command = detectTestCommand(override);
  log.section(`Running test suite: ${command}`);
  const result = run(command);
  const output = result.output.trim().slice(-8000); // keep prompt budget sane
  log.info(result.ok ? "Tests passed." : "Tests failed.");
  log.info(output || "(no test output)");
  return { command, passed: result.ok, output };
}
