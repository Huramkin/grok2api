import type { ConfigManager } from "../../core/config";
import type { MessageItem, ToolDefinition, ToolChoiceObject, EffortType } from "../../types";
import { AppException, UpstreamException, ValidationException, ErrorType } from "../../core/errors";
import { ModelService } from "../model";
import { TokenManager } from "../token";
import { requestChat } from "../reverse/app_chat";
import { extractMessages } from "./message";
import { parseToolCalls, parseToolCallBlock } from "./tool_call";

function normalizeLine(line: string): string | null {
  let text = line.trim();
  if (!text) return null;
  if (text.startsWith("data:")) text = text.slice(5).trim();
  if (text === "[DONE]") return null;
  return text;
}

function collectImages(obj: unknown): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();

  function walk(value: unknown): void {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    const record = value as Record<string, unknown>;
    for (const [key, item] of Object.entries(record)) {
      if (["generatedImageUrls", "imageUrls", "imageURLs"].includes(key)) {
        if (Array.isArray(item)) {
          for (const url of item) {
            if (typeof url === "string" && url && !seen.has(url)) {
              seen.add(url);
              urls.push(url);
            }
          }
        } else if (typeof item === "string" && item && !seen.has(item)) {
          seen.add(item);
          urls.push(item);
        }
        continue;
      }
      walk(item);
    }
  }

  walk(obj);
  return urls;
}

interface SSEChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  system_fingerprint: string;
  choices: {
    index: number;
    delta: Record<string, unknown>;
    logprobs: null;
    finish_reason: string | null;
  }[];
}

function buildSSE(
  responseId: string,
  model: string,
  created: number,
  fingerprint: string,
  options: {
    content?: string;
    role?: string;
    finish?: string | null;
    toolCalls?: unknown[];
  },
): string {
  const delta: Record<string, unknown> = {};
  if (options.role) {
    delta.role = options.role;
    delta.content = "";
  } else if (options.toolCalls !== undefined) {
    delta.tool_calls = options.toolCalls;
  } else if (options.content) {
    delta.content = options.content;
  }

  const chunk: SSEChunk = {
    id: responseId || `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
    object: "chat.completion.chunk",
    created,
    model,
    system_fingerprint: fingerprint,
    choices: [
      {
        index: 0,
        delta,
        logprobs: null,
        finish_reason: options.finish ?? null,
      },
    ],
  };

  return `data: ${JSON.stringify(chunk)}\n\n`;
}

async function pickToken(
  tokenMgr: TokenManager,
  modelId: string,
  tried: Set<string>,
): Promise<string | null> {
  for (const poolName of ModelService.poolCandidatesForModel(modelId)) {
    const token = tokenMgr.getToken(poolName, tried);
    if (token) return token;
  }
  return null;
}

function isRateLimited(e: unknown): boolean {
  if (!(e instanceof UpstreamException)) return false;
  const status = e.details?.status as number | undefined;
  return status === 429;
}

function isTransientUpstream(e: unknown): boolean {
  if (!(e instanceof UpstreamException)) return false;
  const status = e.details?.status as number | undefined;
  if (status && [408, 500, 502, 503, 504].includes(status)) return true;
  const err = String(e.details?.error ?? e.message).toLowerCase();
  return ["timed out", "timeout", "connection reset", "temporarily unavailable"].some(
    (m) => err.includes(m),
  );
}

// Filter tags from tokens
function filterToken(
  token: string,
  filterTags: string[],
): string {
  if (!token || !filterTags || filterTags.length === 0) return token;
  for (const tag of filterTags) {
    if (tag === "xai:tool_usage_card") continue;
    if (token.includes(`<${tag}`) || token.includes(`</${tag}`)) return "";
  }
  return token;
}

export async function chatCompletions(
  model: string,
  messages: MessageItem[],
  config: ConfigManager,
  tokenMgr: TokenManager,
  options: {
    stream?: boolean;
    reasoningEffort?: string;
    temperature?: number;
    topP?: number;
    tools?: ToolDefinition[];
    toolChoice?: string | ToolChoiceObject;
    parallelToolCalls?: boolean;
  } = {},
): Promise<Response> {
  const modelInfo = ModelService.get(model);
  if (!modelInfo) {
    throw new ValidationException(`Unknown model: ${model}`);
  }

  const isStream = options.stream ?? config.get<boolean>("app.stream", true);
  const showThink = options.reasoningEffort === undefined
    ? config.get<boolean>("app.thinking", true)
    : options.reasoningEffort !== "none";
  const maxTokenRetries = config.get<number>("retry.max_retry", 3);
  const filterTags = config.get<string[]>("app.filter_tags", []);
  const toolStreamEnabled = Boolean(options.tools?.length) && options.toolChoice !== "none";

  // Extract messages
  const { text: messageText } = extractMessages(
    messages,
    options.tools,
    options.toolChoice,
    options.parallelToolCalls ?? true,
  );

  const grokModel = modelInfo.grok_model;
  const mode = modelInfo.model_mode;

  const modelConfigOverride: Record<string, unknown> = {
    temperature: options.temperature ?? 0.8,
    topP: options.topP ?? 0.95,
  };
  if (options.reasoningEffort !== undefined) {
    modelConfigOverride.reasoningEffort = options.reasoningEffort;
  }

  // Token retry loop
  const tried = new Set<string>();
  let lastError: unknown = null;

  for (let attempt = 0; attempt < maxTokenRetries; attempt++) {
    const token = await pickToken(tokenMgr, model, tried);
    if (!token) {
      if (lastError) throw lastError;
      throw new AppException(
        "No available tokens. Please try again later.",
        ErrorType.RATE_LIMIT,
        "rate_limit_exceeded",
        null,
        429,
      );
    }

    tried.add(token);

    try {
      const response = await requestChat(token, messageText, grokModel, mode, config, {
        modelConfigOverride,
      });

      if (isStream) {
        return buildStreamResponse(response, model, token, showThink, filterTags, toolStreamEnabled, options.tools, tokenMgr, config);
      }

      return await buildNonStreamResponse(response, model, token, filterTags, options.tools, options.toolChoice, tokenMgr, modelInfo.cost);
    } catch (e) {
      lastError = e;

      if (isRateLimited(e)) {
        await tokenMgr.markRateLimited(token);
        continue;
      }

      if (isTransientUpstream(e)) {
        const hasAlternative = ModelService.poolCandidatesForModel(model).some(
          (pool) => tokenMgr.getToken(pool, tried) !== null,
        );
        if (hasAlternative) continue;
      }

      throw e;
    }
  }

  if (lastError) throw lastError;
  throw new AppException(
    "No available tokens. Please try again later.",
    ErrorType.RATE_LIMIT,
    "rate_limit_exceeded",
    null,
    429,
  );
}

function buildStreamResponse(
  response: Response,
  model: string,
  token: string,
  showThink: boolean,
  filterTags: string[],
  toolStreamEnabled: boolean,
  tools: ToolDefinition[] | undefined,
  tokenMgr: TokenManager,
  config: ConfigManager,
): Response {
  const created = Math.floor(Date.now() / 1000);
  let responseId = "";
  let fingerprint = "";
  let roleSent = false;
  let thinkOpened = false;
  let thinkClosedOnce = false;
  let imageThinkActive = false;

  // Tool state
  let toolState: "text" | "tool" = "text";
  let toolBuffer = "";
  let toolPartial = "";
  let toolCallsSeen = false;
  let toolCallIndex = 0;

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const readable = new ReadableStream({
    async start(controller) {
      try {
        const reader = response.body!.getReader();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const rawLine of lines) {
            const line = normalizeLine(rawLine);
            if (!line) continue;

            let data: Record<string, unknown>;
            try {
              data = JSON.parse(line);
            } catch {
              continue;
            }

            const result = (data.result ?? {}) as Record<string, unknown>;
            const resp = (result.response ?? {}) as Record<string, unknown>;
            const isThinking = Boolean(resp.isThinking);

            // Extract metadata
            const llm = resp.llmInfo as Record<string, unknown> | undefined;
            if (llm && !fingerprint) fingerprint = (llm.modelHash as string) || "";
            if (resp.responseId) responseId = resp.responseId as string;

            if (!roleSent) {
              controller.enqueue(encoder.encode(buildSSE(responseId, model, created, fingerprint, { role: "assistant" })));
              roleSent = true;
            }

            // Image generation progress
            if (resp.streamingImageGenerationResponse) {
              if (!showThink) continue;
              imageThinkActive = true;
              if (!thinkOpened) {
                controller.enqueue(encoder.encode(buildSSE(responseId, model, created, fingerprint, { content: "<think>\n" })));
                thinkOpened = true;
              }
              const img = resp.streamingImageGenerationResponse as Record<string, unknown>;
              const idx = ((img.imageIndex as number) ?? 0) + 1;
              const progress = (img.progress as number) ?? 0;
              controller.enqueue(
                encoder.encode(buildSSE(responseId, model, created, fingerprint, { content: `正在生成第${idx}张图片中，当前进度${progress}%\n` })),
              );
              continue;
            }

            // Model response (images)
            if (resp.modelResponse) {
              if (imageThinkActive && thinkOpened) {
                controller.enqueue(encoder.encode(buildSSE(responseId, model, created, fingerprint, { content: "\n</think>\n" })));
                thinkOpened = false;
                thinkClosedOnce = true;
              }
              imageThinkActive = false;

              const mr = resp.modelResponse as Record<string, unknown>;
              for (const url of collectImages(mr)) {
                controller.enqueue(
                  encoder.encode(buildSSE(responseId, model, created, fingerprint, { content: `![image](${url})\n` })),
                );
              }
              continue;
            }

            // Text token
            const tokenText = resp.token as string | undefined;
            if (tokenText === undefined || tokenText === null) continue;
            if (!tokenText) continue;

            if (isThinking && thinkClosedOnce && !imageThinkActive) continue;

            let filtered = filterToken(tokenText, filterTags);
            if (!filtered) continue;

            const inThink = (isThinking && !thinkClosedOnce) || imageThinkActive;

            if (inThink) {
              if (!showThink) continue;
              if (!thinkOpened) {
                controller.enqueue(encoder.encode(buildSSE(responseId, model, created, fingerprint, { content: "<think>\n" })));
                thinkOpened = true;
              }
              controller.enqueue(encoder.encode(buildSSE(responseId, model, created, fingerprint, { content: filtered })));
              continue;
            }

            if (thinkOpened) {
              controller.enqueue(encoder.encode(buildSSE(responseId, model, created, fingerprint, { content: "\n</think>\n" })));
              thinkOpened = false;
              thinkClosedOnce = true;
            }

            // Tool call streaming
            if (toolStreamEnabled) {
              const events = handleToolStream(filtered, toolState, toolBuffer, toolPartial, tools);
              toolState = events.state;
              toolBuffer = events.buffer;
              toolPartial = events.partial;

              for (const ev of events.events) {
                if (ev.kind === "text") {
                  controller.enqueue(encoder.encode(buildSSE(responseId, model, created, fingerprint, { content: ev.data as string })));
                } else if (ev.kind === "tool") {
                  const tc = ev.data as Record<string, unknown>;
                  if (tc.index === undefined) {
                    tc.index = toolCallIndex++;
                  }
                  toolCallsSeen = true;
                  controller.enqueue(encoder.encode(buildSSE(responseId, model, created, fingerprint, { toolCalls: [tc] })));
                }
              }
              continue;
            }

            controller.enqueue(encoder.encode(buildSSE(responseId, model, created, fingerprint, { content: filtered })));
          }
        }

        // Finalize
        if (thinkOpened) {
          controller.enqueue(encoder.encode(buildSSE(responseId, model, created, fingerprint, { content: "</think>\n" })));
        }

        if (toolStreamEnabled) {
          const flush = flushToolStream(toolState, toolBuffer, toolPartial, tools);
          for (const ev of flush) {
            if (ev.kind === "text") {
              controller.enqueue(encoder.encode(buildSSE(responseId, model, created, fingerprint, { content: ev.data as string })));
            } else if (ev.kind === "tool") {
              const tc = ev.data as Record<string, unknown>;
              if (tc.index === undefined) tc.index = toolCallIndex++;
              toolCallsSeen = true;
              controller.enqueue(encoder.encode(buildSSE(responseId, model, created, fingerprint, { toolCalls: [tc] })));
            }
          }
        }

        const finishReason = toolStreamEnabled && toolCallsSeen ? "tool_calls" : "stop";
        controller.enqueue(encoder.encode(buildSSE(responseId, model, created, fingerprint, { finish: finishReason })));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));

        // Record usage
        const modelInfo = ModelService.get(model);
        const effort: EffortType = modelInfo?.cost === "high" ? "high" : "low";
        await tokenMgr.consume(token, effort);
      } catch (e) {
        const errPayload = {
          error: {
            message: e instanceof Error ? e.message : "stream_error",
            type: "server_error",
            code: "stream_error",
          },
        };
        controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify(errPayload)}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

async function buildNonStreamResponse(
  response: Response,
  model: string,
  token: string,
  filterTags: string[],
  tools: ToolDefinition[] | undefined,
  toolChoice: string | ToolChoiceObject | undefined,
  tokenMgr: TokenManager,
  cost: string,
): Promise<Response> {
  const created = Math.floor(Date.now() / 1000);
  let responseId = "";
  let fingerprint = "";
  let content = "";

  const text = await response.text();
  const lines = text.split("\n");

  for (const rawLine of lines) {
    const line = normalizeLine(rawLine);
    if (!line) continue;

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(line);
    } catch {
      continue;
    }

    const result = (data.result ?? {}) as Record<string, unknown>;
    const resp = (result.response ?? {}) as Record<string, unknown>;

    const llm = resp.llmInfo as Record<string, unknown> | undefined;
    if (llm && !fingerprint) fingerprint = (llm.modelHash as string) || "";

    const mr = resp.modelResponse as Record<string, unknown> | undefined;
    if (mr) {
      responseId = (mr.responseId as string) || "";
      content = (mr.message as string) || "";

      for (const url of collectImages(mr)) {
        content += `\n![image](${url})\n`;
      }
    }
  }

  // Filter tags
  if (filterTags.length > 0) {
    for (const tag of filterTags) {
      const pattern = new RegExp(`<${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^>]*>.*?<\\/${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}>|<${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^>]*\\/>`, "gs");
      content = content.replace(pattern, "");
    }
  }

  // Parse tool calls
  let finishReason = "stop";
  let toolCallsResult: Record<string, unknown>[] | null = null;

  if (tools && tools.length > 0 && toolChoice !== "none") {
    const { textContent, toolCalls } = parseToolCalls(content, tools);
    if (toolCalls) {
      toolCallsResult = toolCalls;
      content = textContent ?? "";
      finishReason = "tool_calls";
    }
  }

  // Record usage
  const effort: EffortType = cost === "high" ? "high" : "low";
  await tokenMgr.consume(token, effort);

  const messageObj: Record<string, unknown> = {
    role: "assistant",
    content,
    refusal: null,
    annotations: [],
  };
  if (toolCallsResult) {
    messageObj.tool_calls = toolCallsResult;
  }

  return Response.json({
    id: responseId,
    object: "chat.completion",
    created,
    model,
    system_fingerprint: fingerprint,
    choices: [
      {
        index: 0,
        message: messageObj,
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      prompt_tokens_details: { cached_tokens: 0, text_tokens: 0, audio_tokens: 0, image_tokens: 0 },
      completion_tokens_details: { text_tokens: 0, audio_tokens: 0, reasoning_tokens: 0 },
    },
  });
}

// ---- Tool stream helpers ----

interface ToolStreamEvent {
  kind: "text" | "tool";
  data: string | Record<string, unknown>;
}

interface ToolStreamState {
  state: "text" | "tool";
  buffer: string;
  partial: string;
  events: ToolStreamEvent[];
}

function suffixPrefix(text: string, tag: string): number {
  if (!text || !tag) return 0;
  const maxKeep = Math.min(text.length, tag.length - 1);
  for (let keep = maxKeep; keep > 0; keep--) {
    if (text.endsWith(tag.slice(0, keep))) return keep;
  }
  return 0;
}

function handleToolStream(
  chunk: string,
  state: "text" | "tool",
  buffer: string,
  partial: string,
  tools?: ToolDefinition[],
): ToolStreamState {
  const events: ToolStreamEvent[] = [];
  const startTag = "<tool_call>";
  const endTag = "</tool_call>";
  let data = partial + chunk;
  let currentPartial = "";

  let currentState = state;
  let currentBuffer = buffer;

  while (data) {
    if (currentState === "text") {
      const startIdx = data.indexOf(startTag);
      if (startIdx === -1) {
        const keep = suffixPrefix(data, startTag);
        const emit = keep ? data.slice(0, -keep) : data;
        if (emit) events.push({ kind: "text", data: emit });
        currentPartial = keep ? data.slice(-keep) : "";
        break;
      }

      const before = data.slice(0, startIdx);
      if (before) events.push({ kind: "text", data: before });
      data = data.slice(startIdx + startTag.length);
      currentState = "tool";
      continue;
    }

    const endIdx = data.indexOf(endTag);
    if (endIdx === -1) {
      const keep = suffixPrefix(data, endTag);
      const append = keep ? data.slice(0, -keep) : data;
      if (append) currentBuffer += append;
      currentPartial = keep ? data.slice(-keep) : "";
      break;
    }

    currentBuffer += data.slice(0, endIdx);
    data = data.slice(endIdx + endTag.length);
    const toolCall = parseToolCallBlock(currentBuffer, tools);
    if (toolCall) events.push({ kind: "tool", data: toolCall });
    currentBuffer = "";
    currentState = "text";
  }

  return { state: currentState, buffer: currentBuffer, partial: currentPartial, events };
}

function flushToolStream(
  state: "text" | "tool",
  buffer: string,
  partial: string,
  tools?: ToolDefinition[],
): ToolStreamEvent[] {
  const events: ToolStreamEvent[] = [];

  if (state === "text") {
    if (partial) events.push({ kind: "text", data: partial });
    return events;
  }

  const raw = buffer + partial;
  const toolCall = parseToolCallBlock(raw, tools);
  if (toolCall) {
    events.push({ kind: "tool", data: toolCall });
  } else if (raw) {
    events.push({ kind: "text", data: `<tool_call>${raw}` });
  }

  return events;
}
