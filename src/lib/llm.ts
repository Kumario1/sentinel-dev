import { Config } from "../config";
import { CodeSymbol } from "./ast";
import { log } from "../logger";

export interface FilePatch {
  path: string;
  content: string;
}

export interface FixProposal {
  summary: string;
  files: FilePatch[];
}

export interface FixRequest {
  issueTitle: string;
  issueBody: string;
  testOutput: string;
  testsPassed: boolean;
  suspects: CodeSymbol[];
}

const SYSTEM_PROMPT = `You are Sentinel-Dev, an autonomous bug-fixing agent.
You are given a repository issue, the test output, and the most relevant
functions/classes (located via AST analysis). Produce a minimal, correct patch.

Respond with ONLY a JSON object, no markdown fences, matching:
{
  "summary": "one short paragraph describing the fix",
  "files": [
    { "path": "relative/path/from/repo/root.ext", "content": "FULL new file contents" }
  ]
}

Rules:
- Return the COMPLETE final contents for each file you change (not a diff).
- Only include files you actually modify.
- Keep the change as small as possible and preserve existing style.
- Never invent file paths; only edit files implied by the provided context.`;

function buildUserPrompt(req: FixRequest): string {
  const suspects = req.suspects
    .map(
      (s) =>
        `### ${s.kind} ${s.name} (${s.file}:${s.line})\n\`\`\`\n${s.snippet}\n\`\`\``,
    )
    .join("\n\n");

  return [
    `Issue title: ${req.issueTitle}`,
    `Issue body:\n${req.issueBody || "(no description provided)"}`,
    `Tests ${req.testsPassed ? "passed" : "failed"}. Output:\n\`\`\`\n${
      req.testOutput || "(no output)"
    }\n\`\`\``,
    `Most relevant code (AST-ranked suspects):\n${
      suspects || "(no suspects found; infer from issue text)"
    }`,
    `Write the patch now as the specified JSON object.`,
  ].join("\n\n");
}

function extractJson(raw: string): FixProposal {
  let text = raw.trim();
  // Strip accidental markdown fences.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  // Fall back to the first {...} block.
  if (!text.startsWith("{")) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end !== -1) text = text.slice(start, end + 1);
  }
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed.files)) {
    throw new Error("LLM response missing a files array.");
  }
  return {
    summary: String(parsed.summary ?? "Automated fix by Sentinel-Dev."),
    files: parsed.files.map((f: any) => ({
      path: String(f.path),
      content: String(f.content),
    })),
  };
}

async function callAnthropic(cfg: Config, prompt: string): Promise<string> {
  if (!cfg.anthropicApiKey) throw new Error("ANTHROPIC_API_KEY is not set.");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": cfg.anthropicApiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: cfg.anthropicModel,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
  }
  const data: any = await res.json();
  return data?.content?.[0]?.text ?? "";
}

async function callOpenAI(cfg: Config, prompt: string): Promise<string> {
  if (!cfg.openaiApiKey) throw new Error("OPENAI_API_KEY is not set.");
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.openaiApiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: cfg.openaiModel,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenAI API error ${res.status}: ${await res.text()}`);
  }
  const data: any = await res.json();
  return data?.choices?.[0]?.message?.content ?? "";
}

export async function generateFix(
  cfg: Config,
  req: FixRequest,
): Promise<FixProposal> {
  log.section(`Requesting patch from ${cfg.llmProvider}`);
  const prompt = buildUserPrompt(req);
  const raw =
    cfg.llmProvider === "openai"
      ? await callOpenAI(cfg, prompt)
      : await callAnthropic(cfg, prompt);
  const proposal = extractJson(raw);
  log.info(
    `LLM proposed changes to ${proposal.files.length} file(s): ` +
      proposal.files.map((f) => f.path).join(", "),
  );
  return proposal;
}
