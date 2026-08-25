import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

describe("plugin secret-input contract", () => {
  it("materializes an apiKey SecretRef through the pinned OpenClaw runtime", async () => {
    const runtimeUrl = pathToFileURL(
      new URL("./node_modules/openclaw/dist/runtime-v3H-VKlD.js", import.meta.url).pathname,
    ).href;
    const { prepareSecretsRuntimeSnapshot } = (await import(runtimeUrl)) as {
      prepareSecretsRuntimeSnapshot(params: Record<string, unknown>): Promise<{
        config: {
          plugins: { entries: { cloudsigma: { config: Record<string, unknown> } } };
        };
      }>;
    };
    const config = {
      plugins: {
        load: { paths: [process.cwd()] },
        entries: {
          cloudsigma: {
            enabled: true,
            config: {
              apiKey: { source: "env", provider: "default", id: "CLOUDSIGMA_TEST_SECRET" },
              browserOrigin: "https://studio.example",
            },
          },
        },
      },
    };

    const snapshot = await prepareSecretsRuntimeSnapshot({
      config,
      env: { ...process.env, CLOUDSIGMA_TEST_SECRET: "materialized-key" },
      includeAuthStoreRefs: false,
      loadablePluginOrigins: new Map([["cloudsigma", "config"]]),
    });

    expect(snapshot.config.plugins.entries.cloudsigma.config).toEqual({
      apiKey: "materialized-key",
      browserOrigin: "https://studio.example",
    });
    expect(config.plugins.entries.cloudsigma.config.apiKey).toEqual({
      source: "env",
      provider: "default",
      id: "CLOUDSIGMA_TEST_SECRET",
    });
  });
});
