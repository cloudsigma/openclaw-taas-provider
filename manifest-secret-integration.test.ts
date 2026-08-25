import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

const { fetchWithSsrFGuard } = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard,
}));

import { resolveConfiguredRealtimeVoiceProvider } from "openclaw/plugin-sdk/realtime-voice";
import { buildCloudsigmaRealtimeVoiceProvider } from "./realtime-voice.js";

describe("plugin secret-input contract", () => {
  it("materializes plugin config and carries it through host resolution to minting", async () => {
    // OpenClaw 2026.7.1-2 has no public secret-snapshot test export. This one
    // pinned hashed import is intentionally coupled to that exact devDependency;
    // provider registration, resolution, and request behavior use public APIs.
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

    const provider = buildCloudsigmaRealtimeVoiceProvider();
    const resolved = resolveConfiguredRealtimeVoiceProvider({
      configuredProviderId: "cloudsigma",
      cfg: snapshot.config as never,
      providers: [provider],
      // Deliberately no duplicated Talk-provider apiKey or browserOrigin.
      providerConfigs: { cloudsigma: {} },
    });
    expect(resolved.provider).toBe(provider);
    expect(resolved.providerConfig).toEqual({
      apiKey: "materialized-key",
      browserOrigin: "https://studio.example",
    });

    const release = vi.fn(async () => undefined);
    fetchWithSsrFGuard.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ value: "ephemeral-key" }), {
        headers: { "content-type": "application/json" },
      }),
      release,
    });
    const session = await resolved.provider.createBrowserSession({
      cfg: snapshot.config as never,
      providerConfig: resolved.providerConfig,
    } as never);
    expect(session.clientSecret).toBe("ephemeral-key");
    expect(fetchWithSsrFGuard).toHaveBeenCalledTimes(1);
    expect(fetchWithSsrFGuard.mock.calls[0]![0].init.headers).toMatchObject({
      Authorization: "Bearer materialized-key",
      Origin: "https://studio.example",
    });
    expect(release).toHaveBeenCalledOnce();
  });
});
