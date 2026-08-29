// CloudSigma plugin entrypoint registers its OpenClaw integration.
import { readConfiguredProviderCatalogEntries } from "openclaw/plugin-sdk/provider-catalog-shared";
import type {
  OpenClawPluginApi,
  OpenClawPluginDefinition,
  ProviderResolveTransportTurnStateContext,
  ProviderTransportTurnState,
  ProviderWrapStreamFnContext,
} from "openclaw/plugin-sdk/core";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";
import { applyCloudsigmaConfig, CLOUDSIGMA_DEFAULT_MODEL_REF } from "./onboard.js";
import {
  buildCloudsigmaProvider,
  buildCloudsigmaProviderWithDiscovery,
} from "./provider-catalog.js";
import { buildCloudsigmaRealtimeVoiceProvider } from "./realtime-voice.js";

const PROVIDER_ID = "cloudsigma";
const PLUGIN_VERSION = "0.2.2";
const CORRELATION_SCHEMA_VERSION = "2026-08-29";
const CORRELATION_SOURCE = "@cloudsigma/openclaw-taas-provider";
const IDENTITY_LIMIT = 200;
const AUTOROUTER_SESSION_LIMIT = 256;
const AUTOROUTER_ALGORITHMS = new Set([
  "best_fit",
  "price_performance",
  "savings_curve",
  "cost",
  "ttft",
  "tps",
]);

const SESSION_HEADER = "X-Session-Id";
const OPENCLAW_SESSION_HEADER = "X-OpenClaw-Session-Id";
const OPENCLAW_AGENT_HEADER = "X-OpenClaw-Agent-Id";
const OPENCLAW_PLUGIN_VERSION_HEADER = "X-OpenClaw-Plugin-Version";
const OPENCLAW_TURN_HEADER = "X-OpenClaw-Turn-Id";
const OPENCLAW_ATTEMPT_HEADER = "X-OpenClaw-Attempt";
const AUTOROUTER_ALGORITHM_HEADER = "X-TaaS-Autorouter-Algorithm";

type JsonRecord = Record<string, unknown>;

type AutorouterCapture = {
  sessionId: string;
  capturedAt: number;
  taasRequestId: string | null;
  taasTraceId: string | null;
  openclawTurnId: string | null;
  openclawAttempt: string | null;
  autorouterModel: string | null;
  autorouterAlgo: string | null;
  autorouterAlgoSource: string | null;
  thinkingApplied: string | null;
  routedContextWindow: number | null;
};

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

/**
 * Session identity enters this plugin only through OpenClaw's native sessionId
 * fields. Keep it bounded and header-safe before reusing it on the wire.
 */
function boundedIdentity(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.trim();
  if (!clean || clean.length > IDENTITY_LIMIT || /[\u0000-\u001f\u007f]/u.test(clean)) return undefined;
  return clean;
}

function agentIdFromSession(sessionId: string): string | undefined {
  return boundedIdentity(/^agent:([^:]+):/u.exec(sessionId)?.[1]);
}

function optionalAttempt(value: unknown): string | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  return boundedIdentity(String(value));
}

function modelIdFromContext(ctx: ProviderWrapStreamFnContext): string | undefined {
  const model = asRecord(ctx.model);
  return boundedIdentity(ctx.modelId) ?? boundedIdentity(model?.id);
}

function buildCorrelationMetadata(args: {
  sessionId: string;
  agentId?: string;
  provider?: unknown;
  modelId?: unknown;
}): JsonRecord {
  const provider = boundedIdentity(args.provider);
  const modelId = boundedIdentity(args.modelId);
  return {
    schema_version: CORRELATION_SCHEMA_VERSION,
    source: CORRELATION_SOURCE,
    plugin_version: PLUGIN_VERSION,
    session_id: args.sessionId,
    sticky_key: args.sessionId,
    session_identity_scope: "native_openclaw_session",
    ...(args.agentId ? { agent_id: args.agentId } : {}),
    ...(provider ? { provider } : {}),
    ...(modelId ? { model_id: modelId } : {}),
  };
}

/**
 * Preserve every caller metadata value. TaaS affinity fields are added only
 * when absent, so explicit caller session/sticky/correlation choices remain
 * authoritative. Invalid metadata is left untouched rather than replaced.
 */
function patchPayloadMetadata(payload: JsonRecord, sessionId: string, correlation: JsonRecord): JsonRecord {
  const metadata = payload.metadata;
  if (metadata !== undefined && !asRecord(metadata)) return payload;

  const existingMetadata = asRecord(metadata) ?? {};
  const needsSessionId = existingMetadata.session_id === undefined;
  const needsStickyKey = existingMetadata.sticky_key === undefined;
  const needsCorrelation = existingMetadata.openclaw_correlation === undefined;
  if (!needsSessionId && !needsStickyKey && !needsCorrelation) return payload;

  return {
    ...payload,
    metadata: {
      ...existingMetadata,
      ...(needsSessionId ? { session_id: sessionId } : {}),
      ...(needsStickyKey ? { sticky_key: sessionId } : {}),
      ...(needsCorrelation ? { openclaw_correlation: correlation } : {}),
    },
  };
}

function touchBoundedMap<T>(map: Map<string, T>, key: string, value: T, limit: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) {
    const oldest = map.keys().next().value as string | undefined;
    if (!oldest) return;
    map.delete(oldest);
  }
}

const autorouterAlgorithmBySessionId = new Map<string, string>();
const lastAutorouterRouteBySessionId = new Map<string, AutorouterCapture>();

function setAutorouterAlgorithm(sessionId: string, algorithm: string | null): void {
  autorouterAlgorithmBySessionId.delete(sessionId);
  if (algorithm !== null) touchBoundedMap(autorouterAlgorithmBySessionId, sessionId, algorithm, AUTOROUTER_SESSION_LIMIT);
}

function getAutorouterAlgorithm(sessionId: string): string | undefined {
  const algorithm = autorouterAlgorithmBySessionId.get(sessionId);
  if (algorithm) touchBoundedMap(autorouterAlgorithmBySessionId, sessionId, algorithm, AUTOROUTER_SESSION_LIMIT);
  return algorithm;
}

function captureAutorouterResponse(sessionId: string, headers: Headers | Record<string, string> | undefined): void {
  if (!headers) return;
  const getHeader = (name: string): string | undefined => {
    if (headers instanceof Headers) return boundedIdentity(headers.get(name));
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === name.toLowerCase()) return boundedIdentity(value);
    }
    return undefined;
  };

  if (getHeader("x-taas-autorouted") !== "true") return;
  const routedContextWindow = Number(getHeader("x-taas-routed-context-window"));
  touchBoundedMap(lastAutorouterRouteBySessionId, sessionId, {
    sessionId,
    capturedAt: Date.now(),
    taasRequestId: getHeader("x-request-id") ?? getHeader("x-taas-request-id") ?? null,
    taasTraceId: getHeader("x-trace-id") ?? getHeader("x-taas-trace-id") ?? null,
    openclawTurnId: getHeader("x-openclaw-turn-id") ?? null,
    openclawAttempt: getHeader("x-openclaw-attempt") ?? null,
    autorouterModel: getHeader("x-taas-autorouter-model") ?? null,
    autorouterAlgo: getHeader("x-taas-autorouter-mode") ?? null,
    autorouterAlgoSource: getHeader("x-taas-autorouter-algorithm-source") ?? null,
    thinkingApplied: getHeader("x-taas-thinking-applied") ?? null,
    routedContextWindow: Number.isFinite(routedContextWindow) && routedContextWindow > 0 ? routedContextWindow : null,
  }, AUTOROUTER_SESSION_LIMIT);
}

/**
 * Full agent/tool streams and direct/simple completions use distinct OpenClaw
 * wrapper registrations. Both paths use the same native session-only payload
 * patch so TaaS sees identical affinity metadata.
 */
function wrapCloudsigmaStreamFn(ctx: ProviderWrapStreamFnContext) {
  const inner = ctx.streamFn;
  if (!inner) return undefined;

  return function cloudsigmaAffinityStreamFn(...args: Parameters<typeof inner>) {
    const [model, context, options] = args;
    const optionRecord = options as (Record<string, unknown> | undefined);
    const sessionId = boundedIdentity(optionRecord?.sessionId);
    if (!sessionId) return inner(model, context, options);

    const correlation = buildCorrelationMetadata({
      sessionId,
      agentId: agentIdFromSession(sessionId),
      provider: ctx.provider,
      modelId: modelIdFromContext(ctx),
    });
    const previousOnPayload = options?.onPayload;
    const previousOnResponse = options?.onResponse;
    const algorithm = getAutorouterAlgorithm(sessionId);

    return inner(model, context, {
      ...options,
      ...(algorithm
        ? {
            headers: {
              ...options?.headers,
              [AUTOROUTER_ALGORITHM_HEADER]: algorithm,
            },
          }
        : {}),
      onPayload: async (payload, payloadModel) => {
        const patched = asRecord(payload)
          ? patchPayloadMetadata(asRecord(payload)!, sessionId, correlation)
          : payload;
        return previousOnPayload ? previousOnPayload(patched, payloadModel) : patched;
      },
      onResponse: async (response, responseModel) => {
        captureAutorouterResponse(sessionId, response?.headers);
        if (previousOnResponse) await previousOnResponse(response, responseModel);
      },
    });
  } as typeof inner;
}

function resolveCloudsigmaTransportTurnState(
  ctx: ProviderResolveTransportTurnStateContext,
): ProviderTransportTurnState | undefined {
  const sessionId = boundedIdentity(ctx.sessionId);
  if (!sessionId) return undefined;

  const agentId = agentIdFromSession(sessionId);
  const turnId = boundedIdentity(ctx.turnId);
  const attempt = optionalAttempt(ctx.attempt);
  const headers: Record<string, string> = {
    [SESSION_HEADER]: sessionId,
    [OPENCLAW_SESSION_HEADER]: sessionId,
    [OPENCLAW_PLUGIN_VERSION_HEADER]: PLUGIN_VERSION,
  };
  if (agentId) headers[OPENCLAW_AGENT_HEADER] = agentId;
  if (turnId) headers[OPENCLAW_TURN_HEADER] = turnId;
  if (attempt) headers[OPENCLAW_ATTEMPT_HEADER] = attempt;

  const algorithm = getAutorouterAlgorithm(sessionId);
  if (algorithm) headers[AUTOROUTER_ALGORITHM_HEADER] = algorithm;
  return { headers };
}

function registerAutorouterGatewayMethods(api: OpenClawPluginApi): void {
  if (typeof api.registerGatewayMethod !== "function") return;

  api.registerGatewayMethod(
    "taas.autorouter.setAlgorithm",
    async ({ params, respond }) => {
      const request = asRecord(params);
      const sessionId = boundedIdentity(request?.sessionId);
      const rawAlgorithm = request?.algorithm;
      const algorithm = rawAlgorithm === null ? null : boundedIdentity(rawAlgorithm);
      if (!sessionId || (rawAlgorithm !== null && (!algorithm || !AUTOROUTER_ALGORITHMS.has(algorithm)))) {
        respond(false, undefined, {
          code: "invalid_request",
          message: "sessionId and a supported AutoRouter algorithm (or null) are required",
        });
        return;
      }
      // The validation above narrows the request contract; make the accepted
      // value explicit for TypeScript and the operator-facing response.
      const acceptedAlgorithm = rawAlgorithm === null ? null : algorithm!;
      setAutorouterAlgorithm(sessionId, acceptedAlgorithm);
      respond(true, { ok: true, sessionId, algorithm: acceptedAlgorithm });
    },
    { scope: "operator.write" },
  );

  api.registerGatewayMethod(
    "taas.autorouter.lastRoute",
    async ({ params, respond }) => {
      const sessionId = boundedIdentity(asRecord(params)?.sessionId);
      if (!sessionId) {
        respond(false, undefined, { code: "invalid_request", message: "sessionId is required" });
        return;
      }
      respond(true, { sessionId, capture: lastAutorouterRouteBySessionId.get(sessionId) ?? null });
    },
    { scope: "operator.read" },
  );
}

function legacyAffinityIsEnabled(config: unknown): boolean {
  const plugins = asRecord(asRecord(config)?.plugins);
  const entries = asRecord(plugins?.entries);
  const legacyEntry = asRecord(entries?.["openclaw-taas-affinity"]);
  if (legacyEntry && legacyEntry.enabled !== false) return true;
  const allow = plugins?.allow;
  return Array.isArray(allow) && allow.includes("openclaw-taas-affinity");
}

function warnOnLegacyAffinityCoexistence(api: OpenClawPluginApi): void {
  if (!legacyAffinityIsEnabled(api.config)) return;
  api.logger?.warn?.(
    "[cloudsigma] legacy openclaw-taas-affinity is also enabled; " +
      "@cloudsigma/openclaw-taas-provider owns CloudSigma runtime hooks and now supplies supported affinity behavior. " +
      "Remove the legacy plugin in the next controlled configuration update.",
  );
}

const providerPlugin = defineSingleProviderPluginEntry({
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
    // The first-class provider owns the active hook surface. It carries only
    // native OpenClaw session identity; there is no workspace, process, or
    // time-based fallback that could conflate conversations.
    resolveTransportTurnState: resolveCloudsigmaTransportTurnState,
    wrapStreamFn: wrapCloudsigmaStreamFn,
    wrapSimpleCompletionStreamFn: wrapCloudsigmaStreamFn,
  },
});

const plugin: OpenClawPluginDefinition & { __test__?: Record<string, unknown> } = {
  ...providerPlugin,
  register(api) {
    providerPlugin.register?.(api);
    warnOnLegacyAffinityCoexistence(api);
    registerAutorouterGatewayMethods(api);
    api.registerRealtimeVoiceProvider(buildCloudsigmaRealtimeVoiceProvider());
  },
  __test__: {
    buildCorrelationMetadata,
    patchPayloadMetadata,
    resolveCloudsigmaTransportTurnState,
    wrapCloudsigmaStreamFn,
    captureAutorouterResponse,
    getAutorouterAlgorithm,
    setAutorouterAlgorithm,
    autorouterAlgorithmBySessionId,
    lastAutorouterRouteBySessionId,
  },
};

export default plugin;
