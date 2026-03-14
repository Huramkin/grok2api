export interface Env {
  CONFIG_KV: KVNamespace;
  TOKENS_KV: KVNamespace;
  API_KEY?: string;
  APP_KEY?: string;
  BASE_PROXY_URL?: string;
  CF_CLEARANCE?: string;
  USER_AGENT?: string;
  BROWSER?: string;
}

// ---- Config ----

export interface AppConfig {
  app: {
    app_url: string;
    app_key: string;
    api_key: string;
    function_enabled: boolean;
    function_key: string;
    image_format: string;
    video_format: string;
    temporary: boolean;
    disable_memory: boolean;
    stream: boolean;
    thinking: boolean;
    dynamic_statsig: boolean;
    custom_instruction: string;
    filter_tags: string[];
  };
  proxy: {
    base_proxy_url: string;
    asset_proxy_url: string;
    cf_cookies: string;
    skip_proxy_ssl_verify: boolean;
    enabled: boolean;
    flaresolverr_url: string;
    refresh_interval: number;
    timeout: number;
    cf_clearance: string;
    browser: string;
    user_agent: string;
  };
  retry: {
    max_retry: number;
    retry_status_codes: number[];
    reset_session_status_codes: number[];
    retry_backoff_base: number;
    retry_backoff_factor: number;
    retry_backoff_max: number;
    retry_budget: number;
  };
  token: {
    auto_refresh: boolean;
    refresh_interval_hours: number;
    super_refresh_interval_hours: number;
    fail_threshold: number;
    save_delay_ms: number;
    usage_flush_interval_sec: number;
    reload_interval_sec: number;
  };
  chat: {
    concurrent: number;
    timeout: number;
    stream_timeout: number;
  };
  image: {
    timeout: number;
    stream_timeout: number;
    final_timeout: number;
    blocked_grace_seconds: number;
    nsfw: boolean;
    medium_min_bytes: number;
    final_min_bytes: number;
    blocked_parallel_attempts: number;
    blocked_parallel_enabled: boolean;
  };
  video: {
    concurrent: number;
    timeout: number;
    stream_timeout: number;
    upscale_timing: string;
  };
  [key: string]: Record<string, unknown>;
}

// ---- Token ----

export type TokenStatus = "active" | "disabled" | "expired" | "cooling";
export type EffortType = "low" | "high";

export const EFFORT_COST: Record<EffortType, number> = {
  low: 1,
  high: 4,
};

export const BASIC_DEFAULT_QUOTA = 80;
export const SUPER_DEFAULT_QUOTA = 140;
export const FAIL_THRESHOLD = 5;

export interface TokenInfo {
  token: string;
  status: TokenStatus;
  quota: number;
  created_at: number;
  last_used_at: number | null;
  use_count: number;
  fail_count: number;
  last_fail_at: number | null;
  last_fail_reason: string | null;
  last_sync_at: number | null;
  tags: string[];
  note: string;
  last_asset_clear_at: number | null;
}

export interface TokenPoolData {
  [poolName: string]: TokenInfo[];
}

// ---- Model ----

export type Tier = "basic" | "super";
export type Cost = "low" | "high";

export interface ModelInfo {
  model_id: string;
  grok_model: string;
  model_mode: string;
  tier: Tier;
  cost: Cost;
  display_name: string;
  description: string;
  is_image: boolean;
  is_image_edit: boolean;
  is_video: boolean;
}

// ---- Chat Completions ----

export interface MessageItem {
  role: string;
  content?: string | Record<string, unknown> | Record<string, unknown>[] | null;
  tool_calls?: ToolCallItem[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCallItem {
  id?: string;
  type?: string;
  function?: {
    name: string;
    arguments: string;
  };
}

export interface ChatCompletionRequest {
  model: string;
  messages: MessageItem[];
  stream?: boolean;
  reasoning_effort?: string;
  temperature?: number;
  top_p?: number;
  tools?: ToolDefinition[];
  tool_choice?: string | ToolChoiceObject;
  parallel_tool_calls?: boolean;
}

export interface ToolDefinition {
  type: string;
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ToolChoiceObject {
  type: string;
  function: {
    name: string;
  };
}

// ---- Error Response ----

export interface ErrorResponse {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string | null;
  };
}
