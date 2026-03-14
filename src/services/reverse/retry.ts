import type { ConfigManager } from "../../core/config";
import { UpstreamException } from "../../core/errors";

export interface RetryContext {
  attempt: number;
  maxRetry: number;
  retryCodes: number[];
  totalDelay: number;
  retryBudget: number;
  backoffBase: number;
  backoffFactor: number;
  backoffMax: number;
  lastDelay: number;
}

export function createRetryContext(config: ConfigManager): RetryContext {
  return {
    attempt: 0,
    maxRetry: config.get<number>("retry.max_retry", 3),
    retryCodes: config.get<number[]>("retry.retry_status_codes", [401, 429, 403]),
    totalDelay: 0,
    retryBudget: config.get<number>("retry.retry_budget", 60),
    backoffBase: config.get<number>("retry.retry_backoff_base", 0.5),
    backoffFactor: config.get<number>("retry.retry_backoff_factor", 2.0),
    backoffMax: config.get<number>("retry.retry_backoff_max", 20.0),
    lastDelay: config.get<number>("retry.retry_backoff_base", 0.5),
  };
}

export function shouldRetry(ctx: RetryContext, statusCode: number): boolean {
  if (ctx.attempt >= ctx.maxRetry) return false;
  if (!ctx.retryCodes.includes(statusCode)) return false;
  if (ctx.totalDelay >= ctx.retryBudget) return false;
  return true;
}

export function calculateDelay(ctx: RetryContext, statusCode: number): number {
  if (statusCode === 429) {
    const delay = Math.min(
      ctx.backoffBase + Math.random() * ctx.lastDelay * 3,
      ctx.backoffMax,
    );
    ctx.lastDelay = delay;
    return delay;
  }

  const expDelay = ctx.backoffBase * Math.pow(ctx.backoffFactor, ctx.attempt);
  return Math.random() * Math.min(expDelay, ctx.backoffMax);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function retryOnStatus<T>(
  fn: () => Promise<T>,
  config: ConfigManager,
  extractStatus?: (e: unknown) => number | null,
): Promise<T> {
  const ctx = createRetryContext(config);

  const defaultExtract = (e: unknown): number | null => {
    if (e instanceof UpstreamException) {
      const status = (e.details?.status as number) ?? null;
      return status;
    }
    return null;
  };

  const getStatus = extractStatus || defaultExtract;

  while (ctx.attempt <= ctx.maxRetry) {
    try {
      return await fn();
    } catch (e) {
      const status = getStatus(e);
      if (status === null) throw e;

      ctx.attempt++;

      if (!shouldRetry(ctx, status)) throw e;

      const delay = calculateDelay(ctx, status);
      if (ctx.totalDelay + delay > ctx.retryBudget) throw e;

      ctx.totalDelay += delay;
      await sleep(delay * 1000);
    }
  }

  throw new Error("Retry exhausted");
}
