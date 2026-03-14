import { Hono } from "hono";
import type { Env } from "../types";
import { ModelService } from "../services/model";

const app = new Hono<{ Bindings: Env }>();

app.get("/models", (c) => {
  const data = ModelService.list().map((m) => ({
    id: m.model_id,
    object: "model",
    created: 0,
    owned_by: "grok2api",
  }));
  return c.json({ object: "list", data });
});

export default app;
