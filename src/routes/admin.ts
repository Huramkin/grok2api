import { Hono } from "hono";
import type { Env, TokenPoolData } from "../types";
import type { ConfigManager } from "../core/config";
import type { TokenManager } from "../services/token";
import { verifyAppKey } from "../core/auth";

export function createAdminRouter(config: ConfigManager, tokenMgr: TokenManager) {
  const app = new Hono<{ Bindings: Env }>();

  // Auth middleware for all admin routes
  app.use("/*", verifyAppKey(config));

  app.get("/verify", (c) => c.json({ status: "ok" }));

  app.get("/config", (c) => c.json(config.getAll()));

  app.post("/config", async (c) => {
    const body = await c.req.json();
    await config.update(body);
    return c.json({ status: "ok" });
  });

  app.get("/tokens", (c) => {
    const data = tokenMgr.getAllTokens();
    const stats = tokenMgr.getStats();
    return c.json({ pools: data, stats });
  });

  app.post("/tokens", async (c) => {
    const body = await c.req.json<TokenPoolData>();
    await tokenMgr.updateTokens(body);
    return c.json({ status: "ok" });
  });

  app.post("/tokens/refresh", async (c) => {
    const count = await tokenMgr.resetAll();
    return c.json({ status: "ok", reset: count });
  });

  return app;
}
