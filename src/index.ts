import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env, ChatCompletionRequest, ToolDefinition, ToolChoiceObject, TokenPoolData } from "./types";
import { ConfigManager } from "./core/config";
import { TokenManager } from "./services/token";
import { verifyApiKey, verifyAppKey } from "./core/auth";
import { AppException, errorResponse, ErrorType, ValidationException } from "./core/errors";
import { ModelService } from "./services/model";
import { chatCompletions } from "./services/grok/chat";

type AppEnv = { Bindings: Env; Variables: { config: ConfigManager; tokenMgr: TokenManager } };

const app = new Hono<AppEnv>();

app.use("/*", cors());

app.onError((err, c) => {
  if (err instanceof AppException) {
    return c.json(
      errorResponse(err.message, err.errorType, err.param, err.code),
      err.statusCode as 400,
    );
  }
  console.error("Unhandled error:", err);
  return c.json(errorResponse("Internal server error", ErrorType.SERVER, null, "internal_error"), 500);
});

app.get("/health", (c) => c.json({ status: "ok" }));

// Load config and tokens per request
app.use("/*", async (c, next) => {
  const config = new ConfigManager(c.env);
  await config.load();
  const tokenMgr = new TokenManager(c.env, config);
  await tokenMgr.load();
  c.set("config", config);
  c.set("tokenMgr", tokenMgr);
  await next();
});

// ========== v1 API routes (with api_key auth) ==========

app.get("/v1/models", async (c) => {
  const config = c.get("config");
  await verifyApiKey(config)(c, async () => {});

  const data = ModelService.list().map((m) => ({
    id: m.model_id,
    object: "model",
    created: 0,
    owned_by: "grok2api",
  }));
  return c.json({ object: "list", data });
});

app.post("/v1/chat/completions", async (c) => {
  const config = c.get("config");
  const tokenMgr = c.get("tokenMgr");
  await verifyApiKey(config)(c, async () => {});

  const body = await c.req.json<ChatCompletionRequest>();

  // Validate
  if (!ModelService.valid(body.model)) {
    throw new ValidationException(
      `The model \`${body.model}\` does not exist or you do not have access to it.`,
      "model",
      "model_not_found",
    );
  }

  const modelInfo = ModelService.get(body.model);
  if (modelInfo && (modelInfo.is_image || modelInfo.is_image_edit || modelInfo.is_video)) {
    throw new ValidationException(
      "Image/Video generation models are not supported in the Cloudflare Worker version.",
      "model",
      "unsupported_model",
    );
  }

  // Validate parameters
  validateChatRequest(body);

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
    if (body.stream !== false && e instanceof AppException) {
      return sseErrorResponse(e);
    }
    throw e;
  }
});

// ========== Admin routes (with app_key auth) ==========

app.get("/v1/admin/verify", async (c) => {
  const config = c.get("config");
  await verifyAppKey(config)(c, async () => {});
  return c.json({ status: "ok" });
});

app.get("/v1/admin/config", async (c) => {
  const config = c.get("config");
  await verifyAppKey(config)(c, async () => {});
  return c.json(config.getAll());
});

app.post("/v1/admin/config", async (c) => {
  const config = c.get("config");
  await verifyAppKey(config)(c, async () => {});
  const body = await c.req.json();
  await config.update(body);
  return c.json({ status: "ok" });
});

app.get("/v1/admin/tokens", async (c) => {
  const config = c.get("config");
  const tokenMgr = c.get("tokenMgr");
  await verifyAppKey(config)(c, async () => {});
  return c.json({ pools: tokenMgr.getAllTokens(), stats: tokenMgr.getStats() });
});

app.post("/v1/admin/tokens", async (c) => {
  const config = c.get("config");
  const tokenMgr = c.get("tokenMgr");
  await verifyAppKey(config)(c, async () => {});
  const body = await c.req.json<TokenPoolData>();
  await tokenMgr.updateTokens(body);
  return c.json({ status: "ok" });
});

app.post("/v1/admin/tokens/refresh", async (c) => {
  const config = c.get("config");
  const tokenMgr = c.get("tokenMgr");
  await verifyAppKey(config)(c, async () => {});
  const count = await tokenMgr.resetAll();
  return c.json({ status: "ok", reset: count });
});

// ========== Helpers ==========

const VALID_ROLES = new Set(["developer", "system", "user", "assistant", "tool"]);
const USER_CONTENT_TYPES = new Set(["text", "image_url", "input_audio", "file"]);

function validateChatRequest(req: ChatCompletionRequest): void {
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

    if (typeof content === "string" && !content.trim()) {
      throw new ValidationException("Message content cannot be empty", `messages.${idx}.content`, "empty_content");
    }

    if (Array.isArray(content)) {
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
        if (msg.role === "user" && !USER_CONTENT_TYPES.has(blockType)) {
          throw new ValidationException(`Invalid content block type: '${blockType}'`, `messages.${idx}.content.${bIdx}.type`, "invalid_type");
        }
        if (blockType === "text") {
          const text = block.text as string;
          if (!text?.trim()) {
            throw new ValidationException("Text content cannot be empty", `messages.${idx}.content.${bIdx}.text`, "empty_text");
          }
        }
      }
    }
  }

  if (req.stream !== undefined && typeof req.stream !== "boolean") {
    const s = String(req.stream).toLowerCase();
    if (["true", "1", "yes"].includes(s)) req.stream = true;
    else if (["false", "0", "no"].includes(s)) req.stream = false;
    else throw new ValidationException("stream must be a boolean", "stream", "invalid_stream");
  }

  const allowedEfforts = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
  if (req.reasoning_effort !== undefined && !allowedEfforts.has(req.reasoning_effort)) {
    throw new ValidationException(
      `reasoning_effort must be one of ${[...allowedEfforts].sort().join(", ")}`,
      "reasoning_effort",
      "invalid_reasoning_effort",
    );
  }

  req.temperature = req.temperature ?? 0.8;
  req.temperature = Number(req.temperature);
  if (isNaN(req.temperature) || req.temperature < 0 || req.temperature > 2) {
    throw new ValidationException("temperature must be between 0 and 2", "temperature", "invalid_temperature");
  }

  req.top_p = req.top_p ?? 0.95;
  req.top_p = Number(req.top_p);
  if (isNaN(req.top_p) || req.top_p < 0 || req.top_p > 1) {
    throw new ValidationException("top_p must be between 0 and 1", "top_p", "invalid_top_p");
  }

  if (req.tools) {
    if (!Array.isArray(req.tools)) {
      throw new ValidationException("tools must be an array", "tools", "invalid_tools");
    }
    for (let i = 0; i < req.tools.length; i++) {
      const tool = req.tools[i] as ToolDefinition;
      if (!tool || tool.type !== "function") {
        throw new ValidationException("Each tool must have type='function'", `tools.${i}.type`, "invalid_tool_type");
      }
      if (!tool.function?.name) {
        throw new ValidationException("Each tool function must have a 'name'", `tools.${i}.function.name`, "missing_function_name");
      }
    }
  }

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

function sseErrorResponse(e: AppException): Response {
  const payload = { error: { message: e.message, type: e.errorType, code: e.code } };
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

export default app;
