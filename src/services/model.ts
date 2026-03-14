import type { ModelInfo, Tier } from "../types";

const MODELS: ModelInfo[] = [
  {
    model_id: "grok-3",
    grok_model: "grok-3",
    model_mode: "MODEL_MODE_GROK_3",
    tier: "basic",
    cost: "low",
    display_name: "GROK-3",
    description: "",
    is_image: false,
    is_image_edit: false,
    is_video: false,
  },
  {
    model_id: "grok-3-mini",
    grok_model: "grok-3",
    model_mode: "MODEL_MODE_GROK_3_MINI_THINKING",
    tier: "basic",
    cost: "low",
    display_name: "GROK-3-MINI",
    description: "",
    is_image: false,
    is_image_edit: false,
    is_video: false,
  },
  {
    model_id: "grok-3-thinking",
    grok_model: "grok-3",
    model_mode: "MODEL_MODE_GROK_3_THINKING",
    tier: "basic",
    cost: "low",
    display_name: "GROK-3-THINKING",
    description: "",
    is_image: false,
    is_image_edit: false,
    is_video: false,
  },
  {
    model_id: "grok-4",
    grok_model: "grok-4",
    model_mode: "MODEL_MODE_GROK_4",
    tier: "basic",
    cost: "low",
    display_name: "GROK-4",
    description: "",
    is_image: false,
    is_image_edit: false,
    is_video: false,
  },
  {
    model_id: "grok-4-thinking",
    grok_model: "grok-4",
    model_mode: "MODEL_MODE_GROK_4_THINKING",
    tier: "basic",
    cost: "low",
    display_name: "GROK-4-THINKING",
    description: "",
    is_image: false,
    is_image_edit: false,
    is_video: false,
  },
  {
    model_id: "grok-4-heavy",
    grok_model: "grok-4",
    model_mode: "MODEL_MODE_HEAVY",
    tier: "super",
    cost: "high",
    display_name: "GROK-4-HEAVY",
    description: "",
    is_image: false,
    is_image_edit: false,
    is_video: false,
  },
  {
    model_id: "grok-4.1-mini",
    grok_model: "grok-4-1-thinking-1129",
    model_mode: "MODEL_MODE_GROK_4_1_MINI_THINKING",
    tier: "basic",
    cost: "low",
    display_name: "GROK-4.1-MINI",
    description: "",
    is_image: false,
    is_image_edit: false,
    is_video: false,
  },
  {
    model_id: "grok-4.1-fast",
    grok_model: "grok-4-1-thinking-1129",
    model_mode: "MODEL_MODE_FAST",
    tier: "basic",
    cost: "low",
    display_name: "GROK-4.1-FAST",
    description: "",
    is_image: false,
    is_image_edit: false,
    is_video: false,
  },
  {
    model_id: "grok-4.1-expert",
    grok_model: "grok-4-1-thinking-1129",
    model_mode: "MODEL_MODE_EXPERT",
    tier: "basic",
    cost: "high",
    display_name: "GROK-4.1-EXPERT",
    description: "",
    is_image: false,
    is_image_edit: false,
    is_video: false,
  },
  {
    model_id: "grok-4.1-thinking",
    grok_model: "grok-4-1-thinking-1129",
    model_mode: "MODEL_MODE_GROK_4_1_THINKING",
    tier: "basic",
    cost: "high",
    display_name: "GROK-4.1-THINKING",
    description: "",
    is_image: false,
    is_image_edit: false,
    is_video: false,
  },
  {
    model_id: "grok-4.20-beta",
    grok_model: "grok-420",
    model_mode: "MODEL_MODE_GROK_420",
    tier: "basic",
    cost: "low",
    display_name: "GROK-4.20-BETA",
    description: "",
    is_image: false,
    is_image_edit: false,
    is_video: false,
  },
];

const MODEL_MAP = new Map<string, ModelInfo>(MODELS.map((m) => [m.model_id, m]));

export class ModelService {
  static get(modelId: string): ModelInfo | undefined {
    return MODEL_MAP.get(modelId);
  }

  static list(): ModelInfo[] {
    return MODELS;
  }

  static valid(modelId: string): boolean {
    return MODEL_MAP.has(modelId);
  }

  static toGrok(modelId: string): [string, string] {
    const model = MODEL_MAP.get(modelId);
    if (!model) throw new Error(`Invalid model ID: ${modelId}`);
    return [model.grok_model, model.model_mode];
  }

  static poolForModel(modelId: string): string {
    const model = MODEL_MAP.get(modelId);
    if (model && model.tier === "super") return "ssoSuper";
    return "ssoBasic";
  }

  static poolCandidatesForModel(modelId: string): string[] {
    const model = MODEL_MAP.get(modelId);
    if (model && model.tier === "super") return ["ssoSuper"];
    return ["ssoBasic", "ssoSuper"];
  }
}
