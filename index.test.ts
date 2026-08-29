// CloudSigma tests cover index plugin behavior using public plugin entry surfaces.
import { beforeEach, describe, expect, it } from "vitest";
import plugin from "./index.js";

type TestProvider = Record<string, any>;

async function registerSingleProviderPluginForTest(config: Record<string, unknown> = {}) {
  const providers: TestProvider[] = [];
  const modelCatalogProviders: TestProvider[] = [];
  const realtimeVoiceProviders: TestProvider[] = [];
  const warnings: string[] = [];
  let modelCallStarted: ((event: unknown, ctx: unknown) => void) | undefined;

  plugin.register?.({
    registerProvider(provider: TestProvider) {
      providers.push(provider);
    },
    registerModelCatalogProvider(provider: TestProvider) {
      modelCatalogProviders.push(provider);
    },
    registerRealtimeVoiceProvider(provider: TestProvider) {
      realtimeVoiceProviders.push(provider);
    },
    registerGatewayMethod() {},
    on(name: string, handler: (event: unknown, ctx: unknown) => void) {
      if (name === "model_call_started") modelCallStarted = handler;
    },
    config,
    logger: { warn(message: string) { warnings.push(message); } },
  } as never);

  expect(providers).toHaveLength(1);
  expect(modelCatalogProviders).toHaveLength(1);
  expect(realtimeVoiceProviders).toHaveLength(1);
  return { provider: providers[0]!, realtimeVoiceProvider: realtimeVoiceProviders[0]!, warnings, modelCallStarted };
}

const TRACE_A = { traceId: "11111111111111111111111111111111", spanId: "aaaaaaaaaaaaaaaa" };
const TRACE_B = { traceId: "22222222222222222222222222222222", spanId: "bbbbbbbbbbbbbbbb" };

function traceparent(trace: { traceId: string; spanId: string }): string {
  return `00-${trace.traceId}-${trace.spanId}-01`;
}

function recordTrace(
  handler: ((event: unknown, ctx: unknown) => void) | undefined,
  trace: { traceId: string; spanId: string },
  sessionId: string,
  eventSessionId = sessionId,
): void {
  expect(handler).toBeTypeOf("function");
  handler?.({ sessionId: eventSessionId }, { sessionId, trace });
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

function sessionIdFor(model: string): string {
  return `agent:new-agent-4:main:${model}`;
}

async function invokeWrappedPayload(provider: TestProvider, hook: "wrapStreamFn" | "wrapSimpleCompletionStreamFn", args: {
  modelId: string;
  sessionId?: string;
  payload: Record<string, unknown>;
  options?: Record<string, unknown>;
}) {
  let observedPayload: unknown;
  let observedOptions: Record<string, unknown> | undefined;
  const streamFn = (_model: unknown, _context: unknown, options: Record<string, any> | undefined) => {
    observedOptions = options;
    return options?.onPayload?.(args.payload, { id: args.modelId });
  };
  const wrapped = provider[hook]({
    provider: "cloudsigma",
    modelId: args.modelId,
    streamFn,
  });
  const output = await wrapped(
    { provider: "cloudsigma", id: args.modelId },
    {},
    {
      sessionId: args.sessionId,
      ...args.options,
      onPayload: async (payload: unknown) => {
        observedPayload = payload;
        return payload;
      },
    },
  );
  return { output, observedPayload, observedOptions };
}

describe("cloudsigma provider plugin", () => {
  beforeEach(() => {
    const testHooks = plugin.__test__! as { traceSessionBridge: { clear(): void } };
    testHooks.traceSessionBridge.clear();
  });

  it("registers CloudSigma TaaS as an OpenAI-compatible provider", async () => {
    const { provider, realtimeVoiceProvider, modelCallStarted } = await registerSingleProviderPluginForTest();

    expect(provider.id).toBe("cloudsigma");
    expect(provider.aliases).toEqual(["cloudsigma-taas"]);
    expect(provider.envVars).toEqual(["CLOUDSIGMA_API_KEY"]);
    expect(provider.auth?.map((method: { id: string }) => method.id)).toEqual(["api-key"]);
    expect(provider.wrapStreamFn).toBeTypeOf("function");
    expect(provider.wrapSimpleCompletionStreamFn).toBeTypeOf("function");
    expect(modelCallStarted).toBeTypeOf("function");

    expect(provider.resolveTransportTurnState?.({
      provider: "cloudsigma",
      modelId: "claude-opus-4.8",
      sessionId: "agent:new-agent-4:main",
      turnId: "turn-1",
      attempt: 1,
      transport: "stream",
    })).toEqual({
      headers: {
        "X-Session-Id": "agent:new-agent-4:main",
        "X-OpenClaw-Session-Id": "agent:new-agent-4:main",
        "X-OpenClaw-Plugin-Version": "0.2.2",
        "X-OpenClaw-Agent-Id": "new-agent-4",
        "X-OpenClaw-Turn-Id": "turn-1",
        "X-OpenClaw-Attempt": "1",
      },
    });
    expect(provider.resolveTransportTurnState?.({
      provider: "cloudsigma",
      modelId: "claude-opus-4.8",
      turnId: "turn-2",
      attempt: 1,
      transport: "stream",
    })).toBeUndefined();

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

  it.each([
    ["GPT agent stream", "wrapStreamFn", "gpt-5.5"],
    ["Claude agent stream", "wrapStreamFn", "claude-sonnet-4.6"],
    ["AutoRouter/generic agent stream", "wrapStreamFn", "auto"],
    ["simple completion stream", "wrapSimpleCompletionStreamFn", "gpt-5.5"],
  ] as const)("injects the same native affinity metadata for %s", async (_name, hook, modelId) => {
    const { provider } = await registerSingleProviderPluginForTest();
    const sessionId = sessionIdFor(modelId);
    const { output, observedPayload } = await invokeWrappedPayload(provider, hook, {
      modelId,
      sessionId,
      payload: { model: modelId, messages: [], metadata: { caller_field: "preserved" } },
    });

    expect(output).toMatchObject({
      metadata: {
        caller_field: "preserved",
        session_id: sessionId,
        sticky_key: sessionId,
        openclaw_correlation: {
          schema_version: "2026-08-29",
          source: "@cloudsigma/openclaw-taas-provider",
          plugin_version: "0.2.2",
          session_id: sessionId,
          sticky_key: sessionId,
          session_identity_scope: "native_openclaw_session",
          agent_id: "new-agent-4",
          provider: "cloudsigma",
          model_id: modelId,
        },
      },
    });
    expect(observedPayload).toEqual(output);
  });

  it("never overwrites explicit caller metadata", async () => {
    const { provider } = await registerSingleProviderPluginForTest();
    const sessionId = sessionIdFor("gpt-5.5");
    const existingCorrelation = { source: "caller", request_id: "r-123" };
    const { output } = await invokeWrappedPayload(provider, "wrapStreamFn", {
      modelId: "gpt-5.5",
      sessionId,
      payload: {
        metadata: {
          caller_field: "keep",
          session_id: "caller-session",
          sticky_key: "caller-sticky",
          openclaw_correlation: existingCorrelation,
          requester_runtime: { legacy: "preserved" },
        },
      },
    });

    expect(output).toEqual({
      metadata: {
        caller_field: "keep",
        session_id: "caller-session",
        sticky_key: "caller-sticky",
        openclaw_correlation: existingCorrelation,
        requester_runtime: { legacy: "preserved" },
      },
    });
  });

  it("does not create affinity from workspace, agent, or process-global context", async () => {
    const { provider } = await registerSingleProviderPluginForTest();
    const { output } = await invokeWrappedPayload(provider, "wrapStreamFn", {
      modelId: "gpt-5.5",
      payload: { metadata: { caller_field: "keep" } },
    });

    expect(output).toEqual({ metadata: { caller_field: "keep" } });
  });

  it.each([
    ["generic", "wrapStreamFn"],
    ["simple", "wrapSimpleCompletionStreamFn"],
  ] as const)("resolves %s calls through exact lifecycle trace correlation", async (_name, hook) => {
    const { provider, modelCallStarted } = await registerSingleProviderPluginForTest();
    const sessionId = sessionIdFor(`${hook}-trace`);
    recordTrace(modelCallStarted, TRACE_A, sessionId);
    const { output } = await invokeWrappedPayload(provider, hook, {
      modelId: "auto",
      payload: { metadata: { caller_field: "preserved" } },
      options: { headers: { traceparent: traceparent(TRACE_A) } },
    });
    expect(output).toMatchObject({
      metadata: { caller_field: "preserved", session_id: sessionId, sticky_key: sessionId },
    });
  });

  it("waits one microtask for lifecycle trace correlation when direct identity is absent", async () => {
    const { provider, modelCallStarted } = await registerSingleProviderPluginForTest();
    const sessionId = sessionIdFor("queued-trace");
    queueMicrotask(() => recordTrace(modelCallStarted, TRACE_A, sessionId));
    const { output } = await invokeWrappedPayload(provider, "wrapStreamFn", {
      modelId: "auto",
      payload: { metadata: {} },
      options: { headers: { traceparent: traceparent(TRACE_A) } },
    });
    expect(output).toMatchObject({ metadata: { session_id: sessionId } });
  });

  it("keeps concurrent trace-correlated calls isolated and supports retry-safe reuse", async () => {
    const { provider, modelCallStarted } = await registerSingleProviderPluginForTest();
    const alpha = sessionIdFor("alpha");
    const beta = sessionIdFor("beta");
    recordTrace(modelCallStarted, TRACE_A, alpha);
    recordTrace(modelCallStarted, TRACE_B, beta);
    const invoke = (trace: typeof TRACE_A) => invokeWrappedPayload(provider, "wrapStreamFn", {
      modelId: "auto",
      payload: { metadata: {} },
      options: { headers: { traceparent: traceparent(trace) } },
    });
    const [firstAlpha, resolvedBeta, retryAlpha] = await Promise.all([invoke(TRACE_A), invoke(TRACE_B), invoke(TRACE_A)]);
    expect(firstAlpha.output).toMatchObject({ metadata: { session_id: alpha } });
    expect(resolvedBeta.output).toMatchObject({ metadata: { session_id: beta } });
    expect(retryAlpha.output).toMatchObject({ metadata: { session_id: alpha } });
  });

  it("fails closed for malformed, conflicting, and ambiguous trace correlation", async () => {
    const { provider, modelCallStarted } = await registerSingleProviderPluginForTest();
    const sessionId = sessionIdFor("trace-safe");
    recordTrace(modelCallStarted, TRACE_A, sessionId);
    recordTrace(modelCallStarted, TRACE_B, sessionId, "different-event-session");
    for (const headers of [
      { traceparent: "invalid" },
      { traceparent: `00-${TRACE_A.traceId}-0000000000000000-01` },
      { traceparent: traceparent(TRACE_A), TraceParent: traceparent(TRACE_B) },
      { traceparent: traceparent(TRACE_B) },
    ]) {
      const { output } = await invokeWrappedPayload(provider, "wrapStreamFn", {
        modelId: "auto",
        payload: { metadata: { caller_field: "keep" } },
        options: { headers },
      });
      expect(output).toEqual({ metadata: { caller_field: "keep" } });
    }
  });

  it("preserves caller metadata when identity comes from the trace bridge", async () => {
    const { provider, modelCallStarted } = await registerSingleProviderPluginForTest();
    recordTrace(modelCallStarted, TRACE_A, sessionIdFor("trace-no-overwrite"));
    const existingCorrelation = { source: "caller" };
    const { output } = await invokeWrappedPayload(provider, "wrapStreamFn", {
      modelId: "auto",
      payload: { metadata: { session_id: "caller", sticky_key: "caller", openclaw_correlation: existingCorrelation } },
      options: { headers: { traceparent: traceparent(TRACE_A) } },
    });
    expect(output).toEqual({
      metadata: { session_id: "caller", sticky_key: "caller", openclaw_correlation: existingCorrelation },
    });
  });

  it("keeps trace bridge entries bounded with a sliding thirty-minute TTL", () => {
    let now = 1_000;
    const testHooks = plugin.__test__! as {
      TraceSessionBridge: new (limit: number, ttlMs: number, now: () => number) => {
        record(key: string, sessionId: string): void;
        resolve(key: string): string | undefined;
        size: number;
      };
      traceSessionBridge: { limitValue: number; ttlMsValue: number };
    };
    const bridge = new testHooks.TraceSessionBridge(2, 100, () => now);
    bridge.record("trace-a", "session-a");
    now += 1;
    bridge.record("trace-b", "session-b");
    now += 1;
    bridge.record("trace-c", "session-c");
    expect(bridge.size).toBe(2);
    expect(bridge.resolve("trace-a")).toBeUndefined();
    expect(bridge.resolve("trace-b")).toBe("session-b");
    now += 90;
    expect(bridge.resolve("trace-b")).toBe("session-b");
    now += 101;
    expect(bridge.resolve("trace-b")).toBeUndefined();
    expect(testHooks.traceSessionBridge.limitValue).toBe(1024);
    expect(testHooks.traceSessionBridge.ttlMsValue).toBe(30 * 60 * 1000);
  });

  it("warns when the retired affinity plugin is also enabled", async () => {
    const { warnings } = await registerSingleProviderPluginForTest({
      plugins: { entries: { "openclaw-taas-affinity": { enabled: true } } },
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("legacy openclaw-taas-affinity is also enabled");
  });

  it("scopes AutoRouter algorithm and captured response state to the exact native session", async () => {
    const { provider } = await registerSingleProviderPluginForTest();
    const sessionId = sessionIdFor("auto");
    const otherSessionId = sessionIdFor("other");
    const testHooks = plugin.__test__! as {
      setAutorouterAlgorithm: (session: string, algorithm: string | null) => void;
      getAutorouterAlgorithm: (session: string) => string | undefined;
      lastAutorouterRouteBySessionId: Map<string, unknown>;
    };
    testHooks.setAutorouterAlgorithm(sessionId, "ttft");

    expect(provider.resolveTransportTurnState({
      provider: "cloudsigma",
      modelId: "auto",
      sessionId,
      turnId: "turn-auto",
      attempt: 2,
      transport: "stream",
    }).headers).toMatchObject({ "X-TaaS-Autorouter-Algorithm": "ttft" });
    expect(provider.resolveTransportTurnState({
      provider: "cloudsigma",
      modelId: "auto",
      sessionId: otherSessionId,
      turnId: "turn-other",
      attempt: 1,
      transport: "stream",
    }).headers).not.toHaveProperty("X-TaaS-Autorouter-Algorithm");

    const responseHeaders = new Headers({
      "x-taas-autorouted": "true",
      "x-taas-autorouter-model": "cloudsigma/gpt-5.5",
      "x-taas-autorouter-mode": "ttft",
      "x-request-id": "taas-request-1",
    });
    const streamFn = (_model: unknown, _context: unknown, options: Record<string, any>) =>
      options.onResponse({ headers: responseHeaders }, { id: "auto" });
    const wrapped = provider.wrapStreamFn({ provider: "cloudsigma", modelId: "auto", streamFn });
    await wrapped({}, {}, { sessionId });

    expect(testHooks.getAutorouterAlgorithm(sessionId)).toBe("ttft");
    expect(testHooks.lastAutorouterRouteBySessionId.get(sessionId)).toMatchObject({
      sessionId,
      autorouterModel: "cloudsigma/gpt-5.5",
      autorouterAlgo: "ttft",
      taasRequestId: "taas-request-1",
    });
    expect(testHooks.lastAutorouterRouteBySessionId.get(otherSessionId)).toBeUndefined();
    testHooks.setAutorouterAlgorithm(sessionId, null);
  });
});
