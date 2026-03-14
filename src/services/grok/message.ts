import type { MessageItem, ToolDefinition, ToolChoiceObject } from "../../types";
import { buildToolPrompt, formatToolHistory } from "./tool_call";

export function extractMessages(
  messages: MessageItem[],
  tools?: ToolDefinition[] | null,
  toolChoice?: string | ToolChoiceObject | null,
  parallelToolCalls: boolean = true,
): { text: string; fileAttachments: string[]; imageAttachments: string[] } {
  let processedMessages = messages.map((m) => ({
    role: m.role,
    content: m.content,
    tool_calls: m.tool_calls,
    tool_call_id: m.tool_call_id,
    name: m.name,
  })) as Record<string, unknown>[];

  if (tools && tools.length > 0) {
    processedMessages = formatToolHistory(processedMessages);
  }

  const fileAttachments: string[] = [];
  const imageAttachments: string[] = [];
  const extracted: { role: string; text: string }[] = [];

  for (const msg of processedMessages) {
    const role = (msg.role as string) || "user";
    const content = msg.content;
    const parts: string[] = [];

    if (typeof content === "string") {
      if (content.trim()) parts.push(content);
    } else if (Array.isArray(content)) {
      for (const item of content) {
        if (!item || typeof item !== "object") continue;
        const block = item as Record<string, unknown>;
        const itemType = block.type as string;

        if (itemType === "text") {
          const text = (block.text as string) || "";
          if (text.trim()) parts.push(text);
        } else if (itemType === "image_url") {
          const imageData = (block.image_url || {}) as Record<string, unknown>;
          const url = imageData.url as string;
          if (url) imageAttachments.push(url);
        } else if (itemType === "input_audio") {
          const audioData = (block.input_audio || {}) as Record<string, unknown>;
          const data = audioData.data as string;
          if (data) fileAttachments.push(data);
        } else if (itemType === "file") {
          const fileData = (block.file || {}) as Record<string, unknown>;
          const raw = fileData.file_data as string;
          if (raw) fileAttachments.push(raw);
        }
      }
    } else if (content && typeof content === "object" && !Array.isArray(content)) {
      const block = content as Record<string, unknown>;
      if (block.type === "text") {
        const text = (block.text as string) || "";
        if (text.trim()) parts.push(text);
      }
    }

    // tool_calls fallback for assistant messages with no text
    const toolCallsArr = msg.tool_calls as Record<string, unknown>[] | undefined;
    if (role === "assistant" && parts.length === 0 && Array.isArray(toolCallsArr)) {
      for (const call of toolCallsArr) {
        const fn = (call.function ?? {}) as Record<string, unknown>;
        const name = (fn.name as string) || (call.name as string) || "tool";
        let args = fn.arguments ?? "";
        if (typeof args === "object") {
          try { args = JSON.stringify(args); } catch { args = String(args); }
        }
        parts.push(`[tool_call] ${name} ${String(args).trim()}`.trim());
      }
    }

    if (parts.length > 0) {
      let roleLabel = role;
      if (role === "tool") {
        const name = msg.name as string;
        const callId = msg.tool_call_id as string;
        if (name) roleLabel = `tool[${name.trim()}]`;
        if (callId) roleLabel = `${roleLabel}#${callId.trim()}`;
      }
      extracted.push({ role: roleLabel, text: parts.join("\n") });
    }
  }

  // Find last user message index
  let lastUserIndex = -1;
  for (let i = extracted.length - 1; i >= 0; i--) {
    if (extracted[i].role === "user") {
      lastUserIndex = i;
      break;
    }
  }

  const texts: string[] = [];
  for (let i = 0; i < extracted.length; i++) {
    const { role, text } = extracted[i];
    texts.push(i === lastUserIndex ? text : `${role}: ${text}`);
  }

  let combined = texts.join("\n\n");

  if (!combined.trim() && (fileAttachments.length > 0 || imageAttachments.length > 0)) {
    combined = "Refer to the following content:";
  }

  if (tools && tools.length > 0) {
    const toolPrompt = buildToolPrompt(tools, toolChoice, parallelToolCalls);
    if (toolPrompt) {
      combined = `${toolPrompt}\n\n${combined}`;
    }
  }

  return { text: combined, fileAttachments, imageAttachments };
}
