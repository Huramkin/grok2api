import type { ConfigManager } from "../../core/config";
import { UpstreamException } from "../../core/errors";
import { buildHeaders } from "./headers";
import { retryOnStatus } from "./retry";

const CHAT_API = "https://grok.com/rest/app-chat/conversations/new";

export interface ChatPayload {
  deviceEnvInfo: Record<string, unknown>;
  disableMemory: boolean;
  disableSearch: boolean;
  disableSelfHarmShortCircuit: boolean;
  disableTextFollowUps: boolean;
  enableImageGeneration: boolean;
  enableImageStreaming: boolean;
  enableSideBySide: boolean;
  fileAttachments: string[];
  forceConcise: boolean;
  forceSideBySide: boolean;
  imageAttachments: string[];
  imageGenerationCount: number;
  isAsyncChat: boolean;
  isReasoning: boolean;
  message: string;
  modelMode: string | null;
  modelName: string;
  responseMetadata: Record<string, unknown>;
  returnImageBytes: boolean;
  returnRawGrokInXaiRequest: boolean;
  sendFinalMetadata: boolean;
  temporary: boolean;
  toolOverrides: Record<string, unknown>;
  enable420?: boolean;
  customPersonality?: string;
}

export function buildPayload(
  message: string,
  model: string,
  mode: string | null,
  config: ConfigManager,
  options: {
    fileAttachments?: string[];
    toolOverrides?: Record<string, unknown>;
    modelConfigOverride?: Record<string, unknown>;
  } = {},
): ChatPayload {
  const payload: ChatPayload = {
    deviceEnvInfo: {
      darkModeEnabled: false,
      devicePixelRatio: 2,
      screenHeight: 1329,
      screenWidth: 2056,
      viewportHeight: 1083,
      viewportWidth: 2056,
    },
    disableMemory: config.get<boolean>("app.disable_memory", true),
    disableSearch: false,
    disableSelfHarmShortCircuit: false,
    disableTextFollowUps: false,
    enableImageGeneration: true,
    enableImageStreaming: true,
    enableSideBySide: true,
    fileAttachments: options.fileAttachments || [],
    forceConcise: false,
    forceSideBySide: false,
    imageAttachments: [],
    imageGenerationCount: 2,
    isAsyncChat: false,
    isReasoning: false,
    message,
    modelMode: mode,
    modelName: model,
    responseMetadata: {
      requestModelDetails: { modelId: model },
    },
    returnImageBytes: false,
    returnRawGrokInXaiRequest: false,
    sendFinalMetadata: true,
    temporary: config.get<boolean>("app.temporary", true),
    toolOverrides: options.toolOverrides || {},
  };

  if (model === "grok-420") {
    payload.enable420 = true;
  }

  const customInstruction = config.get<string>("app.custom_instruction", "");
  if (customInstruction && customInstruction.trim()) {
    payload.customPersonality = customInstruction;
  }

  if (options.modelConfigOverride) {
    (payload.responseMetadata as Record<string, unknown>).modelConfigOverride = options.modelConfigOverride;
  }

  return payload;
}

export async function requestChat(
  token: string,
  message: string,
  model: string,
  mode: string | null,
  config: ConfigManager,
  options: {
    fileAttachments?: string[];
    toolOverrides?: Record<string, unknown>;
    modelConfigOverride?: Record<string, unknown>;
  } = {},
): Promise<Response> {
  const headers = buildHeaders(token, config, {
    contentType: "application/json",
    origin: "https://grok.com",
    referer: "https://grok.com/",
  });

  const payload = buildPayload(message, model, mode, config, options);
  const timeout = (config.get<number>("chat.timeout", 60) || 60) * 1000;

  const doRequest = async (): Promise<Response> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(CHAT_API, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        let body = "";
        try {
          body = await response.text();
        } catch {
          // ignore
        }
        throw new UpstreamException(
          `AppChatReverse: Chat failed, ${response.status}`,
          { status: response.status, body },
        );
      }

      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  };

  const extractStatus = (e: unknown): number | null => {
    if (e instanceof UpstreamException) {
      const status = e.details?.status as number | undefined;
      if (status === 429) return null; // don't retry 429 at this level
      return status ?? null;
    }
    return null;
  };

  return retryOnStatus(doRequest, config, extractStatus);
}
