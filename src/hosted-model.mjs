// NVIDIA-hosted Nemotron through the OpenAI-compatible endpoint at build.nvidia.com.
// Exactly one endpoint is allowed, the key comes only from the environment and is
// never logged, and the model can only choose the one read-only graph tool.
export const NVIDIA_ENDPOINT = "https://integrate.api.nvidia.com/v1/chat/completions";

export function validateHostedModelConfig({endpoint = NVIDIA_ENDPOINT, apiKey, model} = {}) {
  if (endpoint !== NVIDIA_ENDPOINT) throw new Error("Only the NVIDIA integrate endpoint is allowed");
  if (typeof apiKey !== "string" || !/^nvapi-[A-Za-z0-9_-]{20,200}$/.test(apiKey)) {
    throw new Error("NVIDIA_API_KEY (nvapi-...) required");
  }
  if (typeof model !== "string" || !/^nvidia\/[a-z0-9._-]{1,100}$/.test(model)) {
    throw new Error("NEMOTRON_MODEL must be an nvidia/... model id");
  }
  return {endpoint, apiKey, model};
}

export function hostedModelConfig(env = process.env) {
  return validateHostedModelConfig({apiKey: env.NVIDIA_API_KEY, model: env.NEMOTRON_MODEL});
}

export function createHostedModel(config = hostedModelConfig(), fetchImpl = fetch) {
  const {endpoint, apiKey, model} = validateHostedModelConfig(config);
  return async ({messages, tools, tool_choice, temperature = 0, max_tokens = 512, thinking}) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90000);
    try {
      const res = await fetchImpl(endpoint, {
        method: "POST",
        headers: {"content-type": "application/json", authorization: `Bearer ${apiKey}`},
        body: JSON.stringify({model, messages, tools, tool_choice, temperature, max_tokens: Math.min(Number(max_tokens) || 512, 4096),
          ...(thinking === false ? {chat_template_kwargs: {enable_thinking: false}} : {})}),
        signal: controller.signal
      });
      // Status only: response bodies of failed calls can echo request details.
      if (!res.ok) throw new Error("HOSTED_LLM_HTTP_" + res.status);
      const raw = await res.text();
      if (raw.length > 262144) throw new Error("HOSTED_LLM_RESPONSE_TOO_LARGE");
      return JSON.parse(raw);
    } finally {
      clearTimeout(timeout);
    }
  };
}

/** No model at all: the agent uses fixed routing rules and template answers (try the app without an API key). */
export const OFFLINE_MODEL = Object.freeze(Object.assign(async () => { throw new Error("OFFLINE_MODE"); }, {offline: true}));

/** The model adapter selected by MODEL_PROVIDER: "nvidia" (hosted Nemotron), "local" (loopback llama.cpp) or "offline". */
export async function modelFromEnv(env = process.env) {
  if (env.MODEL_PROVIDER === "offline") return {model: OFFLINE_MODEL, provider: "offline", modelId: "fixed rules (no LLM)"};
  if ((env.MODEL_PROVIDER || "nvidia") === "local") {
    const {createLocalModel, localModelConfig} = await import("./local-model.mjs");
    return {model: createLocalModel(localModelConfig(env)), provider: "local", modelId: env.LOCAL_LLM_MODEL};
  }
  const config = hostedModelConfig(env);
  return {model: createHostedModel(config), provider: "nvidia", modelId: config.model};
}
