// Cloudsigma tests cover onboarding config behavior.
import { describe, expect, it } from "vitest";
import { applyCloudsigmaConfig, CLOUDSIGMA_DEFAULT_MODEL_REF } from "./onboard.js";

type ConfigWithProviders = {
  models?: {
    providers?: Record<
      string,
      { baseUrl?: string; api?: string; models?: Array<{ id: string }> }
    >;
  };
};

describe("applyCloudsigmaConfig", () => {
  it("uses gpt-5.5 as the default model ref", () => {
    expect(CLOUDSIGMA_DEFAULT_MODEL_REF).toBe("cloudsigma/gpt-5.5");
  });

  it("writes the cloudsigma provider catalog into config", () => {
    const cfg = applyCloudsigmaConfig({} as never) as ConfigWithProviders;
    const provider = cfg.models?.providers?.cloudsigma;
    expect(provider?.baseUrl).toBe("https://taas.cloudsigma.com/v1");
    expect(provider?.api).toBe("openai-completions");

    const ids = provider?.models?.map((model) => model.id) ?? [];
    expect(ids).toHaveLength(13);
    expect(ids).toContain("gpt-5.5");
    expect(ids).toContain("claude-fable-5");
    expect(ids).toContain("gemini-3.1-flash-lite");
  });
});
