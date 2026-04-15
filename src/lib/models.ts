export interface OpenRouterModel {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  supportsVision: boolean;
  promptPricing?: number;
  completionPricing?: number;
}

/** Alias for clarity when referencing the hardcoded fallback */
export { MODELS as FALLBACK_MODELS };

export const MODELS: OpenRouterModel[] = [
  // Anthropic
  { id: "anthropic/claude-opus-4", name: "Claude Opus 4", provider: "Anthropic", contextWindow: 200000, supportsVision: true },
  { id: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4", provider: "Anthropic", contextWindow: 200000, supportsVision: true },
  { id: "anthropic/claude-haiku-4", name: "Claude Haiku 4", provider: "Anthropic", contextWindow: 200000, supportsVision: true },
  // Google
  { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "Google", contextWindow: 1000000, supportsVision: true },
  { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "Google", contextWindow: 1000000, supportsVision: true },
  { id: "google/gemini-2.0-flash-001", name: "Gemini 2.0 Flash", provider: "Google", contextWindow: 1000000, supportsVision: true },
  // OpenAI
  { id: "openai/gpt-4o", name: "GPT-4o", provider: "OpenAI", contextWindow: 128000, supportsVision: true },
  { id: "openai/gpt-4o-mini", name: "GPT-4o Mini", provider: "OpenAI", contextWindow: 128000, supportsVision: true },
  { id: "openai/gpt-4.1", name: "GPT-4.1", provider: "OpenAI", contextWindow: 1000000, supportsVision: true },
  { id: "openai/gpt-4.1-mini", name: "GPT-4.1 Mini", provider: "OpenAI", contextWindow: 1000000, supportsVision: true },
  { id: "openai/o3-mini", name: "o3-mini", provider: "OpenAI", contextWindow: 200000, supportsVision: false },
  // Meta
  { id: "meta-llama/llama-4-maverick", name: "Llama 4 Maverick", provider: "Meta", contextWindow: 1000000, supportsVision: true },
  { id: "meta-llama/llama-3.3-70b-instruct", name: "Llama 3.3 70B", provider: "Meta", contextWindow: 131072, supportsVision: false },
  // Mistral
  { id: "mistralai/mistral-large-2411", name: "Mistral Large", provider: "Mistral", contextWindow: 128000, supportsVision: false },
  { id: "mistralai/mistral-small-2503", name: "Mistral Small", provider: "Mistral", contextWindow: 32000, supportsVision: false },
  // DeepSeek
  { id: "deepseek/deepseek-chat-v3-0324", name: "DeepSeek V3", provider: "DeepSeek", contextWindow: 131072, supportsVision: false },
  { id: "deepseek/deepseek-r1", name: "DeepSeek R1", provider: "DeepSeek", contextWindow: 163840, supportsVision: false },
];
