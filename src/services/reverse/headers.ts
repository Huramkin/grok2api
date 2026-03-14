import type { ConfigManager } from "../../core/config";
import { genStatsigId } from "./statsig";

function sanitizeHeaderValue(value: string | undefined): string {
  if (!value) return "";
  return value
    .replace(/[\u2010-\u2014\u2212]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u00a0\u2007\u202f]/g, " ")
    .replace(/[\u200b\u200c\u200d\ufeff]/g, "")
    .trim();
}

export function buildSsoCookie(ssoToken: string, config: ConfigManager): string {
  let token = ssoToken.startsWith("sso=") ? ssoToken.slice(4) : ssoToken;
  token = sanitizeHeaderValue(token).replace(/\s+/g, "");

  let cookie = `sso=${token}; sso-rw=${token}`;

  let cfCookies = sanitizeHeaderValue(config.get<string>("proxy.cf_cookies", ""));
  const cfClearance = sanitizeHeaderValue(config.get<string>("proxy.cf_clearance", "")).replace(/\s+/g, "");
  const cfRefreshEnabled = Boolean(config.get<boolean>("proxy.enabled", false));

  if (cfRefreshEnabled) {
    if (!cfCookies && cfClearance) {
      cfCookies = `cf_clearance=${cfClearance}`;
    }
  } else if (cfClearance) {
    if (cfCookies) {
      if (/(?:^|;\s*)cf_clearance=/.test(cfCookies)) {
        cfCookies = cfCookies.replace(/(^|;\s*)cf_clearance=[^;]*/, `$1cf_clearance=${cfClearance}`);
      } else {
        cfCookies = `${cfCookies.replace(/[; ]+$/, "")}; cf_clearance=${cfClearance}`;
      }
    } else {
      cfCookies = `cf_clearance=${cfClearance}`;
    }
  }

  if (cfCookies) {
    if (cookie && !cookie.endsWith(";")) cookie += "; ";
    cookie += cfCookies;
  }

  return cookie;
}

export function buildHeaders(
  cookieToken: string,
  config: ConfigManager,
  options: {
    contentType?: string;
    origin?: string;
    referer?: string;
  } = {},
): Record<string, string> {
  const userAgent = sanitizeHeaderValue(config.get<string>("proxy.user_agent", ""));
  const origin = sanitizeHeaderValue(options.origin || "https://grok.com");
  const referer = sanitizeHeaderValue(options.referer || "https://grok.com/");
  const dynamicStatsig = config.get<boolean>("app.dynamic_statsig", true);

  const headers: Record<string, string> = {
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    Baggage:
      "sentry-environment=production,sentry-release=d6add6fb0460641fd482d767a335ef72b9b6abb8,sentry-public_key=b311e0f2690c81f25e2c4cf6d4f7ce1c",
    Origin: origin,
    Priority: "u=1, i",
    Referer: referer,
    "Sec-Fetch-Mode": "cors",
    "User-Agent": userAgent,
    Cookie: buildSsoCookie(cookieToken, config),
    "Content-Type": "application/json",
    Accept: "*/*",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Site": "same-origin",
    "x-statsig-id": genStatsigId(dynamicStatsig),
    "x-xai-request-id": crypto.randomUUID(),
  };

  return headers;
}
