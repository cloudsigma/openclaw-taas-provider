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
  it("exposes only the approved WebRTC model and fails closed for bridges", () => {
    const provider = buildCloudsigmaRealtimeVoiceProvider();
    expect(provider).toMatchObject({
      id: "cloudsigma",
      defaultModel: CLOUDSIGMA_REALTIME_MODEL,
      models: [CLOUDSIGMA_REALTIME_MODEL],
      capabilities: { transports: ["webrtc"], supportsBrowserSession: true },
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

  it("pins the exact TaaS origin, denies redirects, sends exact origin, and fixes model/body", async () => {
    fetchWithSsrFGuard.mockResolvedValue(guardedJson({ value: "ephemeral" }));
    await createCloudsigmaBrowserSession(
      request({ apiKey: "key", browserOrigin: "https://studio.example:8443" }),
    );
    const call = fetchWithSsrFGuard.mock.calls[0]![0];
    expect(call).toMatchObject({
      url: CLOUDSIGMA_REALTIME_CLIENT_SECRETS_URL,
      timeoutMs: 10_000,
      policy: { allowedOrigin: CLOUDSIGMA_REALTIME_ORIGIN },
      init: {
        method: "POST",
        redirect: "error",
        headers: { Origin: "https://studio.example:8443" },
      },
    });
    expect(JSON.parse(call.init.body)).toEqual({
      session: { type: "realtime", model: CLOUDSIGMA_REALTIME_MODEL },
    });
    expect(ssrfPolicyFromHttpBaseUrlAllowedOrigin).toHaveBeenCalledWith(
      CLOUDSIGMA_REALTIME_ORIGIN,
    );
  });

  it("rejects model overrides", async () => {
    await expect(
      createCloudsigmaBrowserSession({
        ...request({ apiKey: "key", browserOrigin: "https://studio.example" }),
        model: "gpt-realtime",
      }),
    ).rejects.toThrow(`only ${CLOUDSIGMA_REALTIME_MODEL}`);
  });

  it("accepts GA and legacy shapes and rejects conflicting or missing credentials", () => {
    expect(
      parseCloudsigmaClientSecret({
        value: "ga",
        expires_at: 123,
        session: { model: CLOUDSIGMA_REALTIME_MODEL },
      }),
    ).toBe("ga");
    expect(parseCloudsigmaClientSecret({ client_secret: { value: "legacy", expires_at: 123 } })).toBe(
      "legacy",
    );
    expect(parseCloudsigmaClientSecret({ value: "same", client_secret: { value: "same" } })).toBe(
      "same",
    );
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
});
