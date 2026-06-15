// Cloudsigma plugin module implements models behavior.
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const CLOUDSIGMA_MANIFEST_PROVIDER = buildManifestModelProviderConfig({
  providerId: "cloudsigma",
  catalog: manifest.modelCatalog.providers.cloudsigma,
});

export const CLOUDSIGMA_BASE_URL = CLOUDSIGMA_MANIFEST_PROVIDER.baseUrl;

export const CLOUDSIGMA_MODEL_CATALOG: ModelDefinitionConfig[] = CLOUDSIGMA_MANIFEST_PROVIDER.models;

export function buildCloudsigmaModelDefinition(
  model: (typeof CLOUDSIGMA_MODEL_CATALOG)[number],
): ModelDefinitionConfig {
  return {
    ...model,
    api: "openai-completions",
    input: [...model.input],
    cost: { ...model.cost },
  };
}
