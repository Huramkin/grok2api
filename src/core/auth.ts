import type { Context } from "hono";
import type { ConfigManager } from "./config";
import { AuthenticationException } from "./errors";

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const encoder = new TextEncoder();
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  let result = 0;
  for (let i = 0; i < ab.length; i++) {
    result |= ab[i] ^ bb[i];
  }
  return result === 0;
}

function normalizeApiKeys(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

function extractBearerToken(c: Context): string | null {
  const authHeader = c.req.header("Authorization");
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

export function verifyApiKey(config: ConfigManager) {
  return async (c: Context, next: () => Promise<void>) => {
    const apiKey = config.get<string>("app.api_key", "");
    const keys = normalizeApiKeys(apiKey);

    if (keys.length === 0) {
      await next();
      return;
    }

    const token = extractBearerToken(c);
    if (!token) {
      throw new AuthenticationException("Missing authentication token");
    }

    const matched = keys.some((key) => timingSafeEqual(token, key));
    if (!matched) {
      throw new AuthenticationException("Invalid authentication token");
    }

    await next();
  };
}

export function verifyAppKey(config: ConfigManager) {
  return async (c: Context, next: () => Promise<void>) => {
    const appKey = config.get<string>("app.app_key", "grok2api");
    if (!appKey) {
      throw new AuthenticationException("App key is not configured");
    }

    const token = extractBearerToken(c);
    if (!token) {
      throw new AuthenticationException("Missing authentication token");
    }

    if (!timingSafeEqual(token, appKey)) {
      throw new AuthenticationException("Invalid authentication token");
    }

    await next();
  };
}
