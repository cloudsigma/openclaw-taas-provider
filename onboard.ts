// Cloudsigma setup module handles plugin onboarding behavior.
import {
  createModelCatalogPresetAppliers,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  buildCloudsigmaModelDefinition,
  CLOUDSIGMA_BASE_URL,
  CLOUDSIGMA_MODEL_CATALOG,
} from "./models.js";

/** Default CloudSigma TaaS model reference used after onboarding. */
export const CLOUDSIGMA_DEFAULT_MODEL_REF = "cloudsigma/gpt-5.5";

const cloudsigmaPresetAppliers = createModelCatalogPresetAppliers({
  primaryModelRef: CLOUDSIGMA_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: OpenClawConfig) => ({
    providerId: "cloudsigma",
    api: "openai-completions",
    baseUrl: CLOUDSIGMA_BASE_URL,
    catalogModels: CLOUDSIGMA_MODEL_CATALOG.map(buildCloudsigmaModelDefinition),
    aliases: [{ modelRef: CLOUDSIGMA_DEFAULT_MODEL_REF, alias: "CloudSigma TaaS" }],
  }),
});

/** Applies CloudSigma TaaS provider/catalog config and default model aliases. */
export function applyCloudsigmaConfig(cfg: OpenClawConfig): OpenClawConfig {
  return cloudsigmaPresetAppliers.applyConfig(cfg);
}
