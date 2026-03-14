import type { Env, TokenInfo, TokenPoolData, EffortType, TokenStatus } from "../types";
import { BASIC_DEFAULT_QUOTA, SUPER_DEFAULT_QUOTA, EFFORT_COST, FAIL_THRESHOLD } from "../types";
import type { ConfigManager } from "../core/config";

const TOKENS_KV_KEY = "grok2api:tokens";
const SUPER_POOL_NAME = "ssoSuper";
const BASIC_POOL_NAME = "ssoBasic";

function defaultQuotaForPool(poolName: string): number {
  return poolName === SUPER_POOL_NAME ? SUPER_DEFAULT_QUOTA : BASIC_DEFAULT_QUOTA;
}

function normalizeTokenStr(t: string): string {
  return t.startsWith("sso=") ? t.slice(4) : t;
}

function createTokenInfo(token: string, poolName: string): TokenInfo {
  return {
    token: normalizeTokenStr(token),
    status: "active",
    quota: defaultQuotaForPool(poolName),
    created_at: Date.now(),
    last_used_at: null,
    use_count: 0,
    fail_count: 0,
    last_fail_at: null,
    last_fail_reason: null,
    last_sync_at: null,
    tags: [],
    note: "",
    last_asset_clear_at: null,
  };
}

export class TokenManager {
  private pools: Map<string, Map<string, TokenInfo>> = new Map();
  private env: Env;
  private config: ConfigManager;

  constructor(env: Env, config: ConfigManager) {
    this.env = env;
    this.config = config;
  }

  async load(): Promise<void> {
    try {
      const raw = await this.env.TOKENS_KV.get(TOKENS_KV_KEY, "text");
      if (!raw) return;

      const data: TokenPoolData = JSON.parse(raw);
      this.pools = new Map();

      for (const [poolName, tokens] of Object.entries(data)) {
        const pool = new Map<string, TokenInfo>();
        for (const t of tokens) {
          const tokenStr = normalizeTokenStr(t.token);
          const info: TokenInfo = {
            ...t,
            token: tokenStr,
            status: t.status || "active",
            quota: t.quota ?? defaultQuotaForPool(poolName),
            created_at: t.created_at ?? Date.now(),
            use_count: t.use_count ?? 0,
            fail_count: t.fail_count ?? 0,
            tags: t.tags ?? [],
            note: t.note ?? "",
            last_used_at: t.last_used_at ?? null,
            last_fail_at: t.last_fail_at ?? null,
            last_fail_reason: t.last_fail_reason ?? null,
            last_sync_at: t.last_sync_at ?? null,
            last_asset_clear_at: t.last_asset_clear_at ?? null,
          };
          pool.set(tokenStr, info);
        }
        this.pools.set(poolName, pool);
      }
    } catch {
      // fresh start
    }
  }

  async save(): Promise<void> {
    const data: TokenPoolData = {};
    for (const [poolName, pool] of this.pools) {
      data[poolName] = Array.from(pool.values());
    }
    await this.env.TOKENS_KV.put(TOKENS_KV_KEY, JSON.stringify(data));
  }

  getToken(poolName: string = BASIC_POOL_NAME, exclude?: Set<string>): string | null {
    const pool = this.pools.get(poolName);
    if (!pool) return null;

    const available: TokenInfo[] = [];
    for (const t of pool.values()) {
      if (t.status !== "active" || t.quota <= 0) continue;
      if (exclude && exclude.has(t.token)) continue;
      available.push(t);
    }

    if (available.length === 0) return null;

    const maxQuota = Math.max(...available.map((t) => t.quota));
    const candidates = available.filter((t) => t.quota === maxQuota);
    const selected = candidates[Math.floor(Math.random() * candidates.length)];
    return selected.token;
  }

  async consume(tokenStr: string, effort: EffortType = "low"): Promise<boolean> {
    const raw = normalizeTokenStr(tokenStr);
    for (const pool of this.pools.values()) {
      const token = pool.get(raw);
      if (!token) continue;

      const cost = EFFORT_COST[effort];
      const actualCost = Math.min(cost, token.quota);
      token.last_used_at = Date.now();
      token.use_count += actualCost;
      token.quota = Math.max(0, token.quota - actualCost);

      if (token.quota === 0) {
        token.status = "cooling";
      } else if (token.status === "cooling") {
        token.status = "active";
      }

      await this.save();
      return true;
    }
    return false;
  }

  async recordFail(tokenStr: string, statusCode: number = 401, reason: string = ""): Promise<boolean> {
    if (statusCode !== 401) return false;

    const raw = normalizeTokenStr(tokenStr);
    const threshold = this.config.get<number>("token.fail_threshold", FAIL_THRESHOLD);

    for (const pool of this.pools.values()) {
      const token = pool.get(raw);
      if (!token) continue;

      token.fail_count += 1;
      token.last_fail_at = Date.now();
      token.last_fail_reason = reason;

      if (token.fail_count >= threshold) {
        token.status = "expired";
      }

      await this.save();
      return true;
    }
    return false;
  }

  async markRateLimited(tokenStr: string): Promise<boolean> {
    const raw = normalizeTokenStr(tokenStr);
    for (const pool of this.pools.values()) {
      const token = pool.get(raw);
      if (!token) continue;
      token.quota = 0;
      token.status = "cooling";
      await this.save();
      return true;
    }
    return false;
  }

  getPoolNameForToken(tokenStr: string): string | null {
    const raw = normalizeTokenStr(tokenStr);
    for (const [poolName, pool] of this.pools) {
      if (pool.has(raw)) return poolName;
    }
    return null;
  }

  // Admin methods

  async addToken(token: string, poolName: string = BASIC_POOL_NAME): Promise<boolean> {
    if (!this.pools.has(poolName)) {
      this.pools.set(poolName, new Map());
    }
    const pool = this.pools.get(poolName)!;
    const raw = normalizeTokenStr(token);
    if (pool.has(raw)) return false;

    pool.set(raw, createTokenInfo(raw, poolName));
    await this.save();
    return true;
  }

  async removeToken(token: string): Promise<boolean> {
    const raw = normalizeTokenStr(token);
    for (const pool of this.pools.values()) {
      if (pool.delete(raw)) {
        await this.save();
        return true;
      }
    }
    return false;
  }

  async resetAll(): Promise<number> {
    let count = 0;
    for (const [poolName, pool] of this.pools) {
      const defaultQuota = defaultQuotaForPool(poolName);
      for (const token of pool.values()) {
        token.quota = defaultQuota;
        token.status = "active";
        token.fail_count = 0;
        token.last_fail_reason = null;
        count++;
      }
    }
    await this.save();
    return count;
  }

  getStats(): Record<string, Record<string, number>> {
    const stats: Record<string, Record<string, number>> = {};
    for (const [name, pool] of this.pools) {
      let active = 0,
        disabled = 0,
        expired = 0,
        cooling = 0,
        totalQuota = 0;
      for (const t of pool.values()) {
        totalQuota += t.quota;
        if (t.status === "active") active++;
        else if (t.status === "disabled") disabled++;
        else if (t.status === "expired") expired++;
        else if (t.status === "cooling") cooling++;
      }
      stats[name] = {
        total: pool.size,
        active,
        disabled,
        expired,
        cooling,
        total_quota: totalQuota,
        avg_quota: pool.size > 0 ? totalQuota / pool.size : 0,
      };
    }
    return stats;
  }

  getAllTokens(): TokenPoolData {
    const data: TokenPoolData = {};
    for (const [poolName, pool] of this.pools) {
      data[poolName] = Array.from(pool.values());
    }
    return data;
  }

  async updateTokens(data: TokenPoolData): Promise<void> {
    this.pools = new Map();
    for (const [poolName, tokens] of Object.entries(data)) {
      const pool = new Map<string, TokenInfo>();
      for (const t of tokens) {
        const raw = normalizeTokenStr(t.token);
        pool.set(raw, { ...t, token: raw });
      }
      this.pools.set(poolName, pool);
    }
    await this.save();
  }
}
