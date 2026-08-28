import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedOrigin,
  resolveProviderAuthProfileApiKey,
  isProviderAuthProfileConfigured,
} = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(),
  ssrfPolicyFromHttpBaseUrlAllowedOrigin: vi.fn((origin: string) => ({ allowedOrigin: origin })),
  resolveProviderAuthProfileApiKey: vi.fn(),
  isProviderAuthProfileConfigured: vi.fn(() => false),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedOrigin,
}));
vi.mock("openclaw/plugin-sdk/provider-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth")>()),
  resolveProviderAuthProfileApiKey,
  isProviderAuthProfileConfigured,
}));

import {
  buildCloudsigmaRealtimeVoiceProvider,
  CLOUDSIGMA_REALTIME_CALLS_URL,
  CLOUDSIGMA_REALTIME_CLIENT_SECRETS_URL,
  CLOUDSIGMA_REALTIME_INPUT_TRANSCRIPTION_MODEL,
  CLOUDSIGMA_REALTIME_MODEL,
  CLOUDSIGMA_REALTIME_ORIGIN,
  createCloudsigmaBrowserSession,
  parseCloudsigmaClientSecret,
} from "./realtime-voice.js";

function guardedJson(payload: unknown, status = 200, headers = { "content-type": "application/json" }) {
  return {
    response: new Response(JSON.stringify(payload), { status, headers }),
    release: vi.fn(async () => undefined),
  };
}

function request(providerConfig: Record<string, unknown> = {}) {
  return { cfg: {}, providerConfig } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveProviderAuthProfileApiKey.mockResolvedValue(undefined);
  delete process.env.CLOUDSIGMA_API_KEY;
  delete process.env.TAAS_API_KEY;
});

afterEach(() => {
  delete process.env.CLOUDSIGMA_API_KEY;
  delete process.env.TAAS_API_KEY;
});

describe("CloudSigma Talk provider", () => {
  it("resolves credentials only from authoritative plugin-owned config", () => {
    const provider = buildCloudsigmaRealtimeVoiceProvider();
    const providerConfig = provider.resolveConfig?.({
      cfg: {
        plugins: {
          entries: {
            cloudsigma: {
              config: {
                apiKey: "plugin-key",
                browserOrigin: "https://plugin.example",
              },
            },
          },
        },
      },
      rawConfig: {
        apiKey: "ignored-talk-key",
        browserOrigin: "https://ignored.example",
        unsupported: true,
      },
    });

    expect(providerConfig).toEqual({
      apiKey: "plugin-key",
      browserOrigin: "https://plugin.example",
      realtimeRequestTimeoutMs: 25_000,
    });
  });

  it("fails closed when plugin-owned browserOrigin is missing or invalid", () => {
    const provider = buildCloudsigmaRealtimeVoiceProvider();
    for (const pluginConfig of [
      { apiKey: "plugin-key" },
      { apiKey: "plugin-key", browserOrigin: "http://plugin.example" },
    ]) {
      const cfg = { plugins: { entries: { cloudsigma: { config: pluginConfig } } } };
      const providerConfig = provider.resolveConfig?.({
        cfg,
        rawConfig: {
          apiKey: "ignored-talk-key",
          browserOrigin: "https://ignored-valid.example",
        },
      });
      expect(provider.isConfigured({ cfg, providerConfig: providerConfig ?? {} })).toBe(false);
    }
  });

  it("exposes only the approved WebRTC model and fails closed for bridges", () => {
    const provider = buildCloudsigmaRealtimeVoiceProvider();
    expect(provider).toMatchObject({
      id: "cloudsigma",
      defaultModel: CLOUDSIGMA_REALTIME_MODEL,
      models: [CLOUDSIGMA_REALTIME_MODEL],
      capabilities: {
        transports: ["webrtc"],
        supportsBrowserSession: true,
        supportsBargeIn: true,
        handlesInputAudioBargeIn: true,
      },
    });
    expect(() => provider.createBridge({} as never)).toThrow("browser WebRTC only");
  });

  it("requires exact HTTPS browser origins", async () => {
    for (const browserOrigin of [
      undefined,
      "http://studio.example",
      "https://studio.example/path",
      "https://user@studio.example",
      "https://studio.example?next=bad",
      "https://studio.example/",
    ]) {
      await expect(
        createCloudsigmaBrowserSession(request({ apiKey: "explicit", browserOrigin })),
      ).rejects.toThrow(/browserOrigin/);
    }
    expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
  });

  it("prefers explicit Talk apiKey over profile and environment", async () => {
    process.env.CLOUDSIGMA_API_KEY = "env-key";
    process.env.TAAS_API_KEY = "taas-env-key";
    resolveProviderAuthProfileApiKey.mockResolvedValue("profile-key");
    fetchWithSsrFGuard.mockResolvedValue(guardedJson({ value: "ephemeral" }));

    const result = await createCloudsigmaBrowserSession(
      request({ apiKey: "explicit-key", browserOrigin: "https://studio.example" }),
    );

    expect(resolveProviderAuthProfileApiKey).not.toHaveBeenCalled();
    const call = fetchWithSsrFGuard.mock.calls[0]![0];
    expect(call.init.headers.Authorization).toBe("Bearer explicit-key");
    expect(result).toEqual({
      provider: "cloudsigma",
      transport: "webrtc",
      clientSecret: "ephemeral",
      offerUrl: CLOUDSIGMA_REALTIME_CALLS_URL,
      model: CLOUDSIGMA_REALTIME_MODEL,
    });
  });

  it("prefers the CloudSigma API-key auth profile over both environment variables", async () => {
    process.env.CLOUDSIGMA_API_KEY = "env-key";
    process.env.TAAS_API_KEY = "taas-env-key";
    resolveProviderAuthProfileApiKey.mockResolvedValue("profile-key");
    fetchWithSsrFGuard.mockResolvedValue(guardedJson({ value: "ephemeral" }));

    await createCloudsigmaBrowserSession(request({ browserOrigin: "https://studio.example" }));

    expect(resolveProviderAuthProfileApiKey).toHaveBeenCalledWith({
      provider: "cloudsigma",
      cfg: {},
      profileTypes: ["api_key"],
    });
    expect(fetchWithSsrFGuard.mock.calls[0]![0].init.headers.Authorization).toBe(
      "Bearer profile-key",
    );
  });

  it("uses CLOUDSIGMA_API_KEY before TAAS_API_KEY and never requests OpenAI auth", async () => {
    process.env.CLOUDSIGMA_API_KEY = "cloudsigma-env";
    process.env.TAAS_API_KEY = "taas-env";
    fetchWithSsrFGuard.mockResolvedValue(guardedJson({ value: "ephemeral" }));

    await createCloudsigmaBrowserSession(request({ browserOrigin: "https://studio.example" }));

    expect(fetchWithSsrFGuard.mock.calls[0]![0].init.headers.Authorization).toBe(
      "Bearer cloudsigma-env",
    );
    expect(resolveProviderAuthProfileApiKey).toHaveBeenCalledTimes(1);
    expect(resolveProviderAuthProfileApiKey.mock.calls[0]![0].provider).toBe("cloudsigma");
  });

  it("uses TAAS_API_KEY only as the final fallback", async () => {
    process.env.TAAS_API_KEY = "taas-env";
    fetchWithSsrFGuard.mockResolvedValue(guardedJson({ value: "ephemeral" }));
    await createCloudsigmaBrowserSession(request({ browserOrigin: "https://studio.example" }));
    expect(fetchWithSsrFGuard.mock.calls[0]![0].init.headers.Authorization).toBe("Bearer taas-env");
  });

  it("clamps the configurable realtime mint timeout without weakening request policy", async () => {
    fetchWithSsrFGuard.mockResolvedValue(guardedJson({ value: "ephemeral" }));

    for (const [configured, expected] of [
      [1_000, 5_000],
      [20_000.9, 20_000],
      [90_000, 60_000],
      [Number.NaN, 25_000],
    ] as const) {
      fetchWithSsrFGuard.mockReset();
      fetchWithSsrFGuard.mockResolvedValue(guardedJson({ value: "ephemeral" }));
      await createCloudsigmaBrowserSession(
        request({
          apiKey: "key",
          browserOrigin: "https://studio.example",
          realtimeRequestTimeoutMs: configured,
        }),
      );
      expect(fetchWithSsrFGuard.mock.calls[0]![0]).toMatchObject({
        timeoutMs: expected,
        policy: { allowedOrigin: CLOUDSIGMA_REALTIME_ORIGIN },
        init: { method: "POST", redirect: "error" },
      });
    }
  });

  it("pins endpoints and mints an OpenAI-compatible server-VAD session without dropping options", async () => {
    fetchWithSsrFGuard.mockResolvedValue(
      guardedJson({
        value: "ephemeral",
        expires_at: 1_800_000_000,
        session: {
          model: CLOUDSIGMA_REALTIME_MODEL,
          audio: { output: { voice: "echo" } },
        },
      }),
    );
    const result = await createCloudsigmaBrowserSession(
      {
        ...request({ apiKey: "key", browserOrigin: "https://studio.example:8443" }),
        instructions: "Keep answers concise",
        voice: "echo",
        vadThreshold: 0.42,
        prefixPaddingMs: 275,
        silenceDurationMs: 650,
        tools: [
          {
            name: "lookup",
            description: "Look something up",
            parameters: { type: "object", properties: { query: { type: "string" } } },
          },
        ],
      },
    );
    const call = fetchWithSsrFGuard.mock.calls[0]![0];
    expect(call).toMatchObject({
      url: CLOUDSIGMA_REALTIME_CLIENT_SECRETS_URL,
      timeoutMs: 25_000,
      policy: { allowedOrigin: CLOUDSIGMA_REALTIME_ORIGIN },
      init: {
        method: "POST",
        redirect: "error",
        headers: { Origin: "https://studio.example:8443" },
      },
    });
    expect(JSON.parse(call.init.body)).toEqual({
      session: {
        type: "realtime",
        model: CLOUDSIGMA_REALTIME_MODEL,
        instructions: "Keep answers concise",
        audio: {
          input: {
            transcription: { model: CLOUDSIGMA_REALTIME_INPUT_TRANSCRIPTION_MODEL },
            turn_detection: {
              type: "server_vad",
              create_response: true,
              interrupt_response: true,
              threshold: 0.42,
              prefix_padding_ms: 275,
              silence_duration_ms: 650,
            },
          },
          output: { voice: "echo" },
        },
        tools: [
          {
            type: "function",
            name: "lookup",
            description: "Look something up",
            parameters: { type: "object", properties: { query: { type: "string" } } },
          },
        ],
        tool_choice: "auto",
      },
    });
    expect(ssrfPolicyFromHttpBaseUrlAllowedOrigin).toHaveBeenCalledWith(
      CLOUDSIGMA_REALTIME_ORIGIN,
    );
    expect(result).toEqual({
      provider: "cloudsigma",
      transport: "webrtc",
      clientSecret: "ephemeral",
      offerUrl: CLOUDSIGMA_REALTIME_CALLS_URL,
      model: CLOUDSIGMA_REALTIME_MODEL,
      voice: "echo",
      expiresAt: 1_800_000_000_000,
    });
  });

  it("rejects model overrides", async () => {
    await expect(
      createCloudsigmaBrowserSession({
        ...request({ apiKey: "key", browserOrigin: "https://studio.example" }),
        model: "gpt-realtime",
      }),
    ).rejects.toThrow(`only ${CLOUDSIGMA_REALTIME_MODEL}`);
  });

  it("safely parses GA expiry and effective session metadata", () => {
    expect(
      parseCloudsigmaClientSecret({
        value: "ga",
        expires_at: 1_800_000_000,
        session: {
          model: "effective-model",
          audio: { output: { voice: "effective-voice" } },
        },
      }),
    ).toEqual({
      value: "ga",
      expiresAt: 1_800_000_000_000,
      model: "effective-model",
      voice: "effective-voice",
    });
    expect(
      parseCloudsigmaClientSecret({
        client_secret: { value: "legacy", expires_at: 1_800_000_001 },
      }),
    ).toEqual({ value: "legacy", expiresAt: 1_800_000_001_000 });
    expect(parseCloudsigmaClientSecret({ value: "same", client_secret: { value: "same" } })).toEqual({
      value: "same",
    });
  });

  it("omits malformed expiry and rejects conflicting or missing credentials", () => {
    expect(parseCloudsigmaClientSecret({ value: "ga", expires_at: "not-a-timestamp" })).toEqual({
      value: "ga",
    });
    expect(parseCloudsigmaClientSecret({ value: "ga", expires_at: -1 })).toEqual({ value: "ga" });
    expect(
      parseCloudsigmaClientSecret({
        value: "ga",
        expires_at: "invalid",
        client_secret: { value: "ga", expires_at: 1_800_000_002 },
      }),
    ).toEqual({ value: "ga", expiresAt: 1_800_000_002_000 });
    expect(() =>
      parseCloudsigmaClientSecret({ value: "one", client_secret: { value: "two" } }),
    ).toThrow("conflicting");
    expect(() => parseCloudsigmaClientSecret({ session: {} })).toThrow("ephemeral");
  });

  it("rejects non-JSON, oversized JSON, and bounded provider errors while releasing resources", async () => {
    const nonJson = guardedJson({}, 200, { "content-type": "text/html" });
    fetchWithSsrFGuard.mockResolvedValueOnce(nonJson);
    await expect(
      createCloudsigmaBrowserSession(
        request({ apiKey: "key", browserOrigin: "https://studio.example" }),
      ),
    ).rejects.toThrow("non-JSON");
    expect(nonJson.release).toHaveBeenCalled();

    const oversized = {
      response: new Response(JSON.stringify({ value: "x".repeat(70 * 1024) }), {
        headers: { "content-type": "application/json" },
      }),
      release: vi.fn(async () => undefined),
    };
    fetchWithSsrFGuard.mockResolvedValueOnce(oversized);
    await expect(
      createCloudsigmaBrowserSession(
        request({ apiKey: "key", browserOrigin: "https://studio.example" }),
      ),
    ).rejects.toThrow(/exceeds 65536 bytes/);
    expect(oversized.release).toHaveBeenCalled();

    const failure = {
      response: new Response("sensitive provider detail", { status: 429 }),
      release: vi.fn(async () => undefined),
    };
    fetchWithSsrFGuard.mockResolvedValueOnce(failure);
    const error = await createCloudsigmaBrowserSession(
      request({ apiKey: "key", browserOrigin: "https://studio.example" }),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("HTTP 429");
    expect((error as Error).message).not.toContain("sensitive provider detail");
    expect(failure.release).toHaveBeenCalled();
  });

  it("treats browserOrigin as exact static configuration when reporting readiness", () => {
    const provider = buildCloudsigmaRealtimeVoiceProvider();
    expect(
      provider.isConfigured({
        cfg: {},
        providerConfig: { apiKey: "key", browserOrigin: "https://studio.example" },
      }),
    ).toBe(true);
    for (const browserOrigin of [
      "https://studio.example/",
      "https://studio.example/talk",
      "http://studio.example",
    ]) {
      expect(
        provider.isConfigured({ cfg: {}, providerConfig: { apiKey: "key", browserOrigin } }),
      ).toBe(false);
    }
    // The 2026.7.1-2 request contract has no per-request browser origin. Any
    // exact configured origin is accepted here, so operators must keep it in
    // sync with both the active UI origin and the provider allowlist.
    expect(
      provider.isConfigured({
        cfg: {},
        providerConfig: { apiKey: "key", browserOrigin: "https://other.example" },
      }),
    ).toBe(true);
  });
});
