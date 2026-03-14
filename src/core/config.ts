import type { AppConfig, Env } from "../types";

const CONFIG_KV_KEY = "grok2api:config";

const DEFAULT_CONFIG: AppConfig = {
  app: {
    app_url: "",
    app_key: "grok2api",
    api_key: "",
    function_enabled: false,
    function_key: "",
    image_format: "url",
    video_format: "html",
    temporary: true,
    disable_memory: true,
    stream: true,
    thinking: true,
    dynamic_statsig: true,
    custom_instruction: "",
    filter_tags: ["xaiartifact", "xai:tool_usage_card", "grok:render"],
  },
  proxy: {
    base_proxy_url: "",
    asset_proxy_url: "",
    cf_cookies: "",
    skip_proxy_ssl_verify: false,
    enabled: false,
    flaresolverr_url: "",
    refresh_interval: 3600,
    timeout: 60,
    cf_clearance: "",
    browser: "chrome136",
    user_agent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  },
  retry: {
    max_retry: 3,
    retry_status_codes: [401, 429, 403],
    reset_session_status_codes: [403],
    retry_backoff_base: 0.5,
    retry_backoff_factor: 2.0,
    retry_backoff_max: 20.0,
    retry_budget: 60.0,
  },
  token: {
    auto_refresh: true,
    refresh_interval_hours: 8,
    super_refresh_interval_hours: 2,
    fail_threshold: 5,
    save_delay_ms: 500,
    usage_flush_interval_sec: 5,
    reload_interval_sec: 30,
  },
  chat: {
    concurrent: 50,
    timeout: 60,
    stream_timeout: 60,
  },
  image: {
    timeout: 60,
    stream_timeout: 60,
    final_timeout: 15,
    blocked_grace_seconds: 10,
    nsfw: true,
    medium_min_bytes: 30000,
    final_min_bytes: 100000,
    blocked_parallel_attempts: 5,
    blocked_parallel_enabled: true,
  },
  video: {
    concurrent: 100,
    timeout: 60,
    stream_timeout: 60,
    upscale_timing: "complete",
  },
};

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    const bv = base[key];
    const ov = override[key];
    if (bv && typeof bv === "object" && !Array.isArray(bv) && ov && typeof ov === "object" && !Array.isArray(ov)) {
      result[key] = deepMerge(bv as Record<string, unknown>, ov as Record<string, unknown>);
    } else {
      result[key] = ov;
    }
  }
  return result;
}

export class ConfigManager {
  private config: AppConfig;
  private env: Env;

  constructor(env: Env) {
    this.env = env;
    this.config = structuredClone(DEFAULT_CONFIG);
  }

  async load(): Promise<void> {
    try {
      const raw = await this.env.CONFIG_KV.get(CONFIG_KV_KEY, "text");
      if (raw) {
        const stored = JSON.parse(raw) as Partial<AppConfig>;
        this.config = deepMerge(DEFAULT_CONFIG as unknown as Record<string, unknown>, stored as unknown as Record<string, unknown>) as unknown as AppConfig;
      }
    } catch {
      // keep defaults
    }

    // Override from env vars
    if (this.env.API_KEY) this.config.app.api_key = this.env.API_KEY;
    if (this.env.APP_KEY) this.config.app.app_key = this.env.APP_KEY;
    if (this.env.BASE_PROXY_URL) this.config.proxy.base_proxy_url = this.env.BASE_PROXY_URL;
    if (this.env.CF_CLEARANCE) this.config.proxy.cf_clearance = this.env.CF_CLEARANCE;
    if (this.env.USER_AGENT) this.config.proxy.user_agent = this.env.USER_AGENT;
    if (this.env.BROWSER) this.config.proxy.browser = this.env.BROWSER;
  }

  get<T = unknown>(key: string, defaultVal?: T): T {
    if (key.includes(".")) {
      const [section, attr] = key.split(".", 2);
      const sec = (this.config as Record<string, Record<string, unknown>>)[section];
      if (sec && attr in sec) return sec[attr] as T;
      return defaultVal as T;
    }
    return ((this.config as unknown as Record<string, unknown>)[key] as T) ?? (defaultVal as T);
  }

  async update(newConfig: Partial<AppConfig>): Promise<void> {
    this.config = deepMerge(
      this.config as unknown as Record<string, unknown>,
      newConfig as unknown as Record<string, unknown>,
    ) as unknown as AppConfig;
    await this.env.CONFIG_KV.put(CONFIG_KV_KEY, JSON.stringify(this.config));
  }

  getAll(): AppConfig {
    return this.config;
  }
}
