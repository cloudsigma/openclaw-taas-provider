// Cloudsigma tests cover index plugin behavior using public plugin entry surfaces.
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

async function registerSingleProviderPluginForTest() {
  const providers: Array<Record<string, any>> = [];
  const modelCatalogProviders: Array<Record<string, any>> = [];
  const realtimeVoiceProviders: Array<Record<string, any>> = [];

  plugin.register?.({
    registerProvider(provider: Record<string, any>) {
      providers.push(provider);
    },
    registerModelCatalogProvider(provider: Record<string, any>) {
      modelCatalogProviders.push(provider);
    },
    registerRealtimeVoiceProvider(provider: Record<string, any>) {
      realtimeVoiceProviders.push(provider);
    },
  } as never);

  expect(providers).toHaveLength(1);
  expect(modelCatalogProviders).toHaveLength(1);
  expect(realtimeVoiceProviders).toHaveLength(1);
  return { provider: providers[0]!, realtimeVoiceProvider: realtimeVoiceProviders[0]! };
}

function requireCatalogProvider(
  result:
    | { provider: { baseUrl?: string; models?: Array<{ id: string }> } }
    | { providers: Record<string, unknown> }
    | null
    | undefined,
): { baseUrl?: string; models?: Array<{ id: string }> } {
  if (!result || !("provider" in result)) {
    throw new Error("single provider catalog result missing");
  }
  return result.provider;
}

describe("cloudsigma provider plugin", () => {
  it("registers CloudSigma TaaS as an OpenAI-compatible provider", async () => {
    const { provider, realtimeVoiceProvider } = await registerSingleProviderPluginForTest();

    expect(provider.id).toBe("cloudsigma");
    expect(provider.aliases).toEqual(["cloudsigma-taas"]);
    expect(provider.envVars).toEqual(["CLOUDSIGMA_API_KEY"]);
    expect(provider.auth?.map((method) => method.id)).toEqual(["api-key"]);

    const result = await provider.staticCatalog?.run({
      config: {},
      env: {},
      resolveProviderApiKey: () => ({}),
    } as never);
    const catalogProvider = requireCatalogProvider(result);
    expect(catalogProvider.baseUrl).toBe("https://taas.cloudsigma.com/v1");
    expect(catalogProvider.models?.map((model) => model.id)).toContain("gpt-5.5");
    expect(realtimeVoiceProvider).toMatchObject({
      id: "cloudsigma",
      defaultModel: "gpt-realtime-2.1",
      capabilities: { transports: ["webrtc"], supportsBrowserSession: true },
    });
  });
});
