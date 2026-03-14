import { Hono } from "hono";
import type { Env, ChatCompletionRequest, ToolDefinition, ToolChoiceObject } from "../types";
import { ModelService } from "../services/model";
import { ValidationException, AppException, ErrorType } from "../core/errors";
import { chatCompletions } from "../services/grok/chat";
import type { ConfigManager } from "../core/config";
import type { TokenManager } from "../services/token";

const VALID_ROLES = new Set(["developer", "system", "user", "assistant", "tool"]);
const USER_CONTENT_TYPES = new Set(["text", "image_url", "input_audio", "file"]);

function validateRequest(req: ChatCompletionRequest): void {
  if (!ModelService.valid(req.model)) {
    throw new ValidationException(
      `The model \`${req.model}\` does not exist or you do not have access to it.`,
      "model",
      "model_not_found",
    );
  }

  for (let idx = 0; idx < req.messages.length; idx++) {
    const msg = req.messages[idx];
    if (!VALID_ROLES.has(msg.role)) {
      throw new ValidationException(
        `role must be one of ${[...VALID_ROLES].sort().join(", ")}`,
        `messages.${idx}.role`,
        "invalid_role",
      );
    }

    if (msg.role === "tool") {
      if (!msg.tool_call_id) {
        throw new ValidationException(
          "tool messages must have a 'tool_call_id' field",
          `messages.${idx}.tool_call_id`,
          "missing_tool_call_id",
        );
      }
      continue;
    }

    if (msg.role === "assistant" && msg.tool_calls) continue;

    const content = msg.content;
    if (content === null || content === undefined) {
      if (msg.role === "assistant" || msg.role === "tool") continue;
      throw new ValidationException("Message content cannot be null", `messages.${idx}.content`, "empty_content");
    }

    if (typeof content === "string") {
      if (!content.trim()) {
        throw new ValidationException("Message content cannot be empty", `messages.${idx}.content`, "empty_content");
      }
    } else if (Array.isArray(content)) {
      if (content.length === 0) {
        throw new ValidationException("Message content cannot be an empty array", `messages.${idx}.content`, "empty_content");
      }

      for (let bIdx = 0; bIdx < content.length; bIdx++) {
        const block = content[bIdx] as Record<string, unknown>;
        if (!block || typeof block !== "object") {
          throw new ValidationException("Content block must be an object", `messages.${idx}.content.${bIdx}`, "invalid_block");
        }
        const blockType = block.type as string;
        if (!blockType) {
          throw new ValidationException("Content block must have a 'type' field", `messages.${idx}.content.${bIdx}`, "missing_type");
        }

        if (msg.role === "user") {
          if (!USER_CONTENT_TYPES.has(blockType)) {
            throw new ValidationException(`Invalid content block type: '${blockType}'`, `messages.${idx}.content.${bIdx}.type`, "invalid_type");
          }
        } else if (blockType !== "text") {
          throw new ValidationException(
            `The \`${msg.role}\` role only supports 'text' type, got '${blockType}'`,
            `messages.${idx}.content.${bIdx}.type`,
            "invalid_type",
          );
        }

        if (blockType === "text") {
          const text = block.text as string;
          if (!text || !text.trim()) {
            throw new ValidationException("Text content cannot be empty", `messages.${idx}.content.${bIdx}.text`, "empty_text");
          }
        }
      }
    }
  }

  // Validate stream
  if (req.stream !== undefined && typeof req.stream !== "boolean") {
    const s = String(req.stream).toLowerCase();
    if (["true", "1", "yes"].includes(s)) req.stream = true;
    else if (["false", "0", "no"].includes(s)) req.stream = false;
    else throw new ValidationException("stream must be a boolean", "stream", "invalid_stream");
  }

  // Validate reasoning effort
  const allowedEfforts = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
  if (req.reasoning_effort !== undefined && !allowedEfforts.has(req.reasoning_effort)) {
    throw new ValidationException(
      `reasoning_effort must be one of ${[...allowedEfforts].sort().join(", ")}`,
      "reasoning_effort",
      "invalid_reasoning_effort",
    );
  }

  // Validate temperature
  if (req.temperature === undefined || req.temperature === null) {
    req.temperature = 0.8;
  } else {
    req.temperature = Number(req.temperature);
    if (isNaN(req.temperature) || req.temperature < 0 || req.temperature > 2) {
      throw new ValidationException("temperature must be between 0 and 2", "temperature", "invalid_temperature");
    }
  }

  // Validate top_p
  if (req.top_p === undefined || req.top_p === null) {
    req.top_p = 0.95;
  } else {
    req.top_p = Number(req.top_p);
    if (isNaN(req.top_p) || req.top_p < 0 || req.top_p > 1) {
      throw new ValidationException("top_p must be between 0 and 1", "top_p", "invalid_top_p");
    }
  }

  // Validate tools
  if (req.tools) {
    if (!Array.isArray(req.tools)) {
      throw new ValidationException("tools must be an array", "tools", "invalid_tools");
    }
    for (let i = 0; i < req.tools.length; i++) {
      const tool = req.tools[i];
      if (!tool || tool.type !== "function") {
        throw new ValidationException("Each tool must have type='function'", `tools.${i}.type`, "invalid_tool_type");
      }
      if (!tool.function?.name) {
        throw new ValidationException("Each tool function must have a 'name'", `tools.${i}.function.name`, "missing_function_name");
      }
    }
  }

  // Validate tool_choice
  if (req.tool_choice !== undefined) {
    if (typeof req.tool_choice === "string") {
      if (!["auto", "required", "none"].includes(req.tool_choice)) {
        throw new ValidationException(
          "tool_choice must be 'auto', 'required', 'none', or a specific function object",
          "tool_choice",
          "invalid_tool_choice",
        );
      }
    } else if (typeof req.tool_choice === "object") {
      const tc = req.tool_choice as ToolChoiceObject;
      if (tc.type !== "function" || !tc.function?.name) {
        throw new ValidationException(
          "tool_choice object must have type='function' and function.name",
          "tool_choice",
          "invalid_tool_choice",
        );
      }
    }
  }
}

export function createChatRouter(config: ConfigManager, tokenMgr: TokenManager) {
  const app = new Hono<{ Bindings: Env }>();

  app.post("/chat/completions", async (c) => {
    const body = await c.req.json<ChatCompletionRequest>();
    validateRequest(body);

    const modelInfo = ModelService.get(body.model);

    // Only support chat models (not image/video models in this CF Worker version)
    if (modelInfo && (modelInfo.is_image || modelInfo.is_image_edit || modelInfo.is_video)) {
      throw new ValidationException(
        `Image/Video generation models are not supported in the Cloudflare Worker version. Use model: ${body.model}`,
        "model",
        "unsupported_model",
      );
    }

    try {
      return await chatCompletions(body.model, body.messages, config, tokenMgr, {
        stream: body.stream,
        reasoningEffort: body.reasoning_effort,
        temperature: body.temperature,
        topP: body.top_p,
        tools: body.tools as ToolDefinition[],
        toolChoice: body.tool_choice as string | ToolChoiceObject | undefined,
        parallelToolCalls: body.parallel_tool_calls,
      });
    } catch (e) {
      // For stream requests, return SSE error
      if (body.stream !== false && e instanceof AppException) {
        const payload = {
          error: { message: e.message, type: e.errorType, code: e.code },
        };
        const encoder = new TextEncoder();
        const readable = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify(payload)}\n\n`));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        });
        return new Response(readable, {
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
        });
      }
      throw e;
    }
  });

  return app;
}
