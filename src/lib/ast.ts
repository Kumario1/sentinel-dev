import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import { log } from "../logger";

export interface CodeSymbol {
  name: string;
  kind: "function" | "class" | "method";
  file: string;
  line: number;
  /** The full source text of the function/class/method. */
  snippet: string;
}

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const IGNORED_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  ".github",
  "coverage",
]);

function walk(dir: string, acc: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      walk(full, acc);
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      acc.push(full);
    }
  }
  return acc;
}

function collectSymbols(file: string): CodeSymbol[] {
  const text = fs.readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const symbols: CodeSymbol[] = [];
  const rel = path.relative(process.cwd(), file);

  const push = (name: string, kind: CodeSymbol["kind"], node: ts.Node) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    symbols.push({
      name,
      kind,
      file: rel,
      line: line + 1,
      snippet: node.getText(source),
    });
  };

  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      push(node.name.text, "function", node);
    } else if (ts.isClassDeclaration(node) && node.name) {
      push(node.name.text, "class", node);
      node.members.forEach((member) => {
        if (ts.isMethodDeclaration(member) && member.name) {
          push(`${node.name!.text}.${member.name.getText(source)}`, "method", member);
        }
      });
    } else if (
      (ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) &&
      node.name &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) ||
        ts.isFunctionExpression(node.initializer))
    ) {
      push(node.name.getText(source), "function", node);
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return symbols;
}

/** Map every source file in the repo into a flat list of symbols. */
export function mapRepository(): CodeSymbol[] {
  const files = walk(process.cwd());
  const symbols = files.flatMap((file) => {
    try {
      return collectSymbols(file);
    } catch (error) {
      log.warn(`Failed to parse ${file}: ${String(error)}`);
      return [];
    }
  });
  log.info(`AST mapped ${symbols.length} symbols across ${files.length} files.`);
  return symbols;
}

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "when", "into", "code",
  "bug", "fix", "issue", "error", "function", "class", "method", "should",
  "does", "not", "but", "are", "was", "has", "have", "you", "your", "its",
]);

function keywords(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
    ),
  );
}

/**
 * Rank symbols by how well their name / file / body matches the issue text.
 * This is our heuristic for "find the buggy function or class".
 */
export function rankSuspects(
  symbols: CodeSymbol[],
  issueText: string,
  limit = 6,
): CodeSymbol[] {
  const words = keywords(issueText);
  if (words.length === 0) return symbols.slice(0, limit);

  const scored = symbols.map((symbol) => {
    const name = symbol.name.toLowerCase();
    const fileName = symbol.file.toLowerCase();
    const haystack = symbol.snippet.toLowerCase();
    let score = 0;
    for (const word of words) {
      if (name.includes(word)) score += 5;
      if (fileName.includes(word)) score += 2;
      if (haystack.includes(word)) score += 1;
    }
    return { symbol, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.symbol);
}
