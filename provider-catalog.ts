// Cloudsigma provider module implements model/runtime integration.
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  buildCloudsigmaModelDefinition,
  CLOUDSIGMA_BASE_URL,
  CLOUDSIGMA_MODEL_CATALOG,
} from "./models.js";
import { discoverCloudsigmaModels } from "./provider-models.js";

/** Builds the CloudSigma TaaS OpenAI-compatible model provider config from the static seed. */
export function buildCloudsigmaProvider(): ModelProviderConfig {
  return {
    baseUrl: CLOUDSIGMA_BASE_URL,
    api: "openai-completions",
    models: CLOUDSIGMA_MODEL_CATALOG.map(buildCloudsigmaModelDefinition),
  };
}

/** Builds the CloudSigma TaaS provider config with live model discovery and static fallback. */
export async function buildCloudsigmaProviderWithDiscovery(params?: {
  apiKey?: string;
}): Promise<ModelProviderConfig> {
  const models = await discoverCloudsigmaModels({ apiKey: params?.apiKey });
  return {
    baseUrl: CLOUDSIGMA_BASE_URL,
    api: "openai-completions",
    models,
  };
}
