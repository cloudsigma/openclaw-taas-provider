// Cloudsigma plugin entrypoint registers its OpenClaw integration.
import { readConfiguredProviderCatalogEntries } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { OpenClawPluginDefinition } from "openclaw/plugin-sdk/plugin-entry";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";
import { applyCloudsigmaConfig, CLOUDSIGMA_DEFAULT_MODEL_REF } from "./onboard.js";
import {
  buildCloudsigmaProvider,
  buildCloudsigmaProviderWithDiscovery,
} from "./provider-catalog.js";

const PROVIDER_ID = "cloudsigma";

const plugin: OpenClawPluginDefinition = defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "CloudSigma TaaS Provider",
  description: "CloudSigma TaaS provider plugin",
  provider: {
    label: "CloudSigma TaaS",
    docsPath: "/providers/cloudsigma",
    aliases: ["cloudsigma-taas"],
    envVars: ["CLOUDSIGMA_API_KEY"],
    auth: [
      {
        methodId: "api-key",
        label: "CloudSigma TaaS API key",
        hint: "OpenAI-compatible multi-model gateway",
        optionKey: "cloudsigmaApiKey",
        flagName: "--cloudsigma-api-key",
        envVar: "CLOUDSIGMA_API_KEY",
        promptMessage: "Enter CloudSigma TaaS API key",
        defaultModel: CLOUDSIGMA_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyCloudsigmaConfig(cfg),
        noteMessage: [
          "CloudSigma TaaS is an OpenAI-compatible multi-model gateway: Claude, GPT, Gemini, Kimi, Qwen, GLM, Llama, and Pixtral routes behind one key.",
          "Create an API key at: https://taas.cloudsigma.com",
        ].join("\n"),
        noteTitle: "CloudSigma TaaS",
        wizard: {
          groupLabel: "CloudSigma TaaS",
          groupHint: "OpenAI-compatible multi-model gateway",
        },
      },
    ],
    catalog: {
      buildProvider: buildCloudsigmaProviderWithDiscovery,
      buildStaticProvider: buildCloudsigmaProvider,
    },
    augmentModelCatalog: ({ config }) =>
      readConfiguredProviderCatalogEntries({
        config,
        providerId: PROVIDER_ID,
      }),
    ...buildProviderReplayFamilyHooks({
      family: "openai-compatible",
      dropReasoningFromHistory: false,
    }),
    ...buildProviderToolCompatFamilyHooks("openai"),
  },
});

export default plugin;
