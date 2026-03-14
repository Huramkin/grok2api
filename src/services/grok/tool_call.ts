import type { ToolDefinition, ToolChoiceObject } from "../../types";

export function buildToolPrompt(
  tools: ToolDefinition[],
  toolChoice?: string | ToolChoiceObject | null,
  parallelToolCalls: boolean = true,
): string {
  if (!tools || tools.length === 0) return "";
  if (toolChoice === "none") return "";

  const lines: string[] = [
    "# Available Tools",
    "",
    "You have access to the following tools. To call a tool, output a <tool_call> block with a JSON object containing \"name\" and \"arguments\".",
    "",
    "Format:",
    "<tool_call>",
    '{"name": "function_name", "arguments": {"param": "value"}}',
    "</tool_call>",
    "",
  ];

  if (parallelToolCalls) {
    lines.push("You may make multiple tool calls in a single response by using multiple <tool_call> blocks.");
    lines.push("");
  }

  lines.push("## Tool Definitions");
  lines.push("");

  for (const tool of tools) {
    if (tool.type !== "function") continue;
    const func = tool.function;
    lines.push(`### ${func.name}`);
    if (func.description) lines.push(func.description);
    if (func.parameters) {
      lines.push(`Parameters: ${JSON.stringify(func.parameters)}`);
    }
    lines.push("");
  }

  if (toolChoice === "required") {
    lines.push("IMPORTANT: You MUST call at least one tool in your response. Do not respond with only text.");
  } else if (typeof toolChoice === "object" && toolChoice !== null) {
    const forcedName = toolChoice.function?.name || "";
    if (forcedName) {
      lines.push(`IMPORTANT: You MUST call the tool "${forcedName}" in your response.`);
    }
  } else {
    lines.push("Decide whether to call a tool based on the user's request. If you don't need a tool, respond normally with text only.");
  }

  lines.push("");
  lines.push("When you call a tool, you may include text before or after the <tool_call> blocks, but the tool call blocks must be valid JSON.");

  return lines.join("\n");
}

const TOOL_CALL_RE = /<tool_call>\s*(.*?)\s*<\/tool_call>/gs;

function stripCodeFences(text: string): string {
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```[a-zA-Z0-9_-]*\s*/, "");
    cleaned = cleaned.replace(/\s*```$/, "");
  }
  return cleaned.trim();
}

function extractJsonObject(text: string): string {
  const start = text.indexOf("{");
  if (start === -1) return text;
  const end = text.lastIndexOf("}");
  if (end === -1 || end < start) return text.slice(start);
  return text.slice(start, end + 1);
}

function removeTrailingCommas(text: string): string {
  return text.replace(/,\s*([}\]])/g, "$1");
}

function balanceBraces(text: string): string {
  let open = 0, close = 0;
  let inString = false, escape = false;
  for (const ch of text) {
    if (escape) { escape = false; continue; }
    if (ch === "\\" && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") open++;
    else if (ch === "}") close++;
  }
  if (open > close) return text + "}".repeat(open - close);
  return text;
}

function repairJson(text: string): unknown | null {
  if (!text) return null;
  let cleaned = stripCodeFences(text);
  cleaned = extractJsonObject(cleaned);
  cleaned = cleaned.replace(/\r\n|\r/g, "\n").replace(/\n/g, " ");
  cleaned = removeTrailingCommas(cleaned);
  cleaned = balanceBraces(cleaned);
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

export function parseToolCallBlock(
  rawJson: string,
  tools?: ToolDefinition[],
): Record<string, unknown> | null {
  if (!rawJson) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    parsed = repairJson(rawJson);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const obj = parsed as Record<string, unknown>;
  const name = obj.name as string | undefined;
  if (!name) return null;

  if (tools && tools.length > 0) {
    const validNames = new Set(tools.filter((t) => t.type === "function").map((t) => t.function.name));
    if (validNames.size > 0 && !validNames.has(name)) return null;
  }

  const args = obj.arguments;
  const argsStr = typeof args === "string" ? args : JSON.stringify(args ?? {});

  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 24);

  return {
    id: `call_${id}`,
    type: "function",
    function: { name, arguments: argsStr },
  };
}

export function parseToolCalls(
  content: string,
  tools?: ToolDefinition[],
): { textContent: string | null; toolCalls: Record<string, unknown>[] | null } {
  if (!content) return { textContent: content, toolCalls: null };

  const matches = [...content.matchAll(TOOL_CALL_RE)];
  if (matches.length === 0) return { textContent: content, toolCalls: null };

  const toolCalls: Record<string, unknown>[] = [];
  for (const match of matches) {
    const raw = match[1].trim();
    const tc = parseToolCallBlock(raw, tools);
    if (tc) toolCalls.push(tc);
  }

  if (toolCalls.length === 0) return { textContent: content, toolCalls: null };

  const textParts: string[] = [];
  let lastEnd = 0;
  for (const match of matches) {
    const before = content.slice(lastEnd, match.index).trim();
    if (before) textParts.push(before);
    lastEnd = match.index! + match[0].length;
  }
  const trailing = content.slice(lastEnd).trim();
  if (trailing) textParts.push(trailing);

  const textContent = textParts.length > 0 ? textParts.join("\n") : null;
  return { textContent, toolCalls };
}

export function formatToolHistory(
  messages: Record<string, unknown>[],
): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];

  for (const msg of messages) {
    const role = msg.role as string;
    const content = msg.content;
    const toolCalls = msg.tool_calls as Record<string, unknown>[] | undefined;

    if (role === "assistant" && toolCalls) {
      const parts: string[] = [];
      if (content && typeof content === "string") parts.push(content);

      for (const tc of toolCalls) {
        const fn = (tc.function ?? {}) as Record<string, unknown>;
        const tcName = (fn.name as string) || "";
        const tcArgs = (fn.arguments as string) || "{}";
        parts.push(`<tool_call>{"name":"${tcName}","arguments":${tcArgs}}</tool_call>`);
      }

      result.push({ role: "assistant", content: parts.join("\n") });
    } else if (role === "tool") {
      const toolName = (msg.name as string) || "unknown";
      const callId = (msg.tool_call_id as string) || "";
      const contentStr = typeof content === "string" ? content : JSON.stringify(content ?? "");
      result.push({
        role: "user",
        content: `tool (${toolName}, ${callId}): ${contentStr}`,
      });
    } else {
      result.push(msg);
    }
  }

  return result;
}
