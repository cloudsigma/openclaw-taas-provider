// Cloudsigma tests cover live model discovery behavior.
import { describe, expect, it, vi } from "vitest";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
  ssrfPolicyFromHttpBaseUrlAllowedHostname: (baseUrl: string) => ({
    allowedHostnames: [new URL(baseUrl).hostname],
  }),
}));

import { CLOUDSIGMA_MODEL_CATALOG } from "./models.js";
import { CLOUDSIGMA_MODELS_URL, discoverCloudsigmaModels } from "./provider-models.js";

const SEED_IDS = CLOUDSIGMA_MODEL_CATALOG.map((model) => model.id);

const VERIFIED_IMAGE_IDS = new Set([
  "gemini-3.1-flash-lite",
  "qwen3-vl",
  "pixtral-large",
  "qwen2.5-vl-72b",
]);

interface TaasEntryOverrides {
  id?: string;
  type?: string;
  context_window?: number | null;
  max_output_tokens?: number | null;
  capabilities?: Record<string, boolean>;
  pricing?: Record<string, number>;
}

function makeTaasEntry(overrides: TaasEntryOverrides = {}) {
  return {
    id: "new-chat-model",
    type: "chat",
    context_window: 200000,
    max_output_tokens: 16384,
    capabilities: { chat_completions: true, reasoning: false, vision: false },
    pricing: { input: 0.5, output: 1.5 },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function withFetchPathTest(fn: () => Promise<void>): Promise<void> {
  const prevNodeEnv = process.env.NODE_ENV;
  const prevVitest = process.env.VITEST;
  process.env.NODE_ENV = "production";
  delete process.env.VITEST;
  try {
    await fn();
  } finally {
    if (prevNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = prevNodeEnv;
    }
    if (prevVitest === undefined) {
      delete process.env.VITEST;
    } else {
      process.env.VITEST = prevVitest;
    }
    fetchWithSsrFGuardMock.mockReset();
  }
}

describe("discoverCloudsigmaModels", () => {
  it("returns the static seed catalog in test environment", async () => {
    const models = await discoverCloudsigmaModels();
    expect(models.map((model) => model.id)).toEqual(SEED_IDS);
    expect(models).toHaveLength(13);
    for (const model of models) {
      expect(model.api).toBe("openai-completions");
    }
  });

  it("static catalog has live-verified defaults for gpt-5.5", async () => {
    const models = await discoverCloudsigmaModels();
    const defaultModel = models.find((model) => model.id === "gpt-5.5");
    expect(defaultModel?.name).toBe("GPT-5.5");
    expect(defaultModel?.reasoning).toBe(false);
    expect(defaultModel?.input).toEqual(["text"]);
    expect(defaultModel?.contextWindow).toBe(400000);
    expect(defaultModel?.maxTokens).toBe(128000);
    expect(defaultModel?.cost).toEqual({ input: 1.75, output: 14, cacheRead: 0, cacheWrite: 0 });
  });

  it("marks image input only on live-verified vision routes", async () => {
    const models = await discoverCloudsigmaModels();
    const imageIds = models
      .filter((model) => model.input.includes("image"))
      .map((model) => model.id);
    expect(new Set(imageIds)).toEqual(VERIFIED_IMAGE_IDS);
  });
});

describe("discoverCloudsigmaModels (fetch path)", () => {
  it("supplements seeds with chat-capable live rows and sends the API key", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: jsonResponse({
        data: [
          makeTaasEntry(),
          makeTaasEntry({ id: "bge-m3", type: "embedding", capabilities: {} }),
          makeTaasEntry({ id: "gpt-5.5" }),
        ],
      }),
      release: vi.fn(async () => {}),
    });

    await withFetchPathTest(async () => {
      const models = await discoverCloudsigmaModels({ apiKey: "test-key" });

      expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
      const params = fetchWithSsrFGuardMock.mock.calls[0]?.[0] as {
        url?: string;
        init?: { headers?: Record<string, string> };
        timeoutMs?: number;
        auditContext?: string;
        policy?: { allowedHostnames?: string[] };
      };
      expect(params.url).toBe(CLOUDSIGMA_MODELS_URL);
      expect(params.init?.headers).toEqual({
        Accept: "application/json",
        Authorization: "Bearer test-key",
      });
      expect(params.timeoutMs).toBe(5000);
      expect(params.auditContext).toBe("cloudsigma.model_discovery");
      expect(params.policy).toEqual({ allowedHostnames: ["taas.cloudsigma.com"] });

      const ids = models.map((model) => model.id);
      // Seed rows stay authoritative and lead the catalog.
      expect(ids.slice(0, SEED_IDS.length)).toEqual(SEED_IDS);
      expect(ids).toContain("new-chat-model");
      // Non-chat routes are excluded; seed ids are never duplicated.
      expect(ids).not.toContain("bge-m3");
      expect(ids.filter((id) => id === "gpt-5.5")).toHaveLength(1);
    });
  });

  it("omits the Authorization header without an API key", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: jsonResponse({ data: [makeTaasEntry()] }),
      release: vi.fn(async () => {}),
    });

    await withFetchPathTest(async () => {
      await discoverCloudsigmaModels();
      const params = fetchWithSsrFGuardMock.mock.calls[0]?.[0] as {
        init?: { headers?: Record<string, string> };
      };
      expect(params.init?.headers).toEqual({ Accept: "application/json" });
    });
  });

  it("falls back to the static catalog on HTTP errors", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response("", { status: 401 }),
      release: vi.fn(async () => {}),
    });

    await withFetchPathTest(async () => {
      const models = await discoverCloudsigmaModels({ apiKey: "test-key" });
      expect(models.map((model) => model.id)).toEqual(SEED_IDS);
    });
  });

  it("falls back to the static catalog when the fetch throws", async () => {
    fetchWithSsrFGuardMock.mockRejectedValue(new Error("network down"));

    await withFetchPathTest(async () => {
      const models = await discoverCloudsigmaModels();
      expect(models.map((model) => model.id)).toEqual(SEED_IDS);
    });
  });
});
