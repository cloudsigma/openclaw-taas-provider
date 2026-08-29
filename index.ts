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
const PLUGIN_VERSION = "0.2.3";
const CORRELATION_SCHEMA_VERSION = "2026-08-29";
const CORRELATION_SOURCE = "@cloudsigma/openclaw-taas-provider";
const IDENTITY_LIMIT = 200;
const AUTOROUTER_SESSION_LIMIT = 256;
const TRACE_BRIDGE_LIMIT = 1024;
const TRACE_BRIDGE_TTL_MS = 30 * 60 * 1000;
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

type TraceBridgeEntry = {
  sessionId: string | null;
  ambiguous: boolean;
  expiresAt: number;
};

/**
 * Correlates a public model-call lifecycle event with the later provider
 * invocation only when both sides contain the same complete W3C trace/span.
 * Entries are non-consuming for retry safety and are bounded in time and size.
 */
class TraceSessionBridge {
  private readonly entries = new Map<string, TraceBridgeEntry>();

  constructor(
    private readonly limit = TRACE_BRIDGE_LIMIT,
    private readonly ttlMs = TRACE_BRIDGE_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  private pruneExpired(now = this.now()): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }

  private enforceLimit(): void {
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) return;
      this.entries.delete(oldest);
    }
  }

  record(key: string, sessionId: string): void {
    const now = this.now();
    this.pruneExpired(now);
    const existing = this.entries.get(key);
    const ambiguous = existing?.ambiguous === true ||
      (existing?.sessionId !== undefined && existing.sessionId !== sessionId);
    this.entries.delete(key);
    this.entries.set(key, {
      sessionId: ambiguous ? null : sessionId,
      ambiguous,
      expiresAt: now + this.ttlMs,
    });
    this.enforceLimit();
  }

  markAmbiguous(key: string): void {
    const now = this.now();
    this.pruneExpired(now);
    this.entries.delete(key);
    this.entries.set(key, { sessionId: null, ambiguous: true, expiresAt: now + this.ttlMs });
    this.enforceLimit();
  }

  resolve(key: string): string | undefined {
    const now = this.now();
    const entry = this.entries.get(key);
    if (!entry || entry.expiresAt <= now) {
      if (entry) this.entries.delete(key);
      this.pruneExpired(now);
      return undefined;
    }
    if (entry.ambiguous || !entry.sessionId) return undefined;
    // Refresh the sliding TTL and LRU position after an exact successful match.
    entry.expiresAt = now + this.ttlMs;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.sessionId;
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    this.pruneExpired();
    return this.entries.size;
  }

  get limitValue(): number {
    return this.limit;
  }

  get ttlMsValue(): number {
    return this.ttlMs;
  }
}

const traceSessionBridge = new TraceSessionBridge();

function isNonZeroHex(value: string): boolean {
  return /[1-9a-f]/iu.test(value);
}

function traceKeyFromContext(value: unknown): string | undefined {
  const trace = asRecord(value);
  const traceId = boundedIdentity(trace?.traceId)?.toLowerCase();
  const spanId = boundedIdentity(trace?.spanId)?.toLowerCase();
  if (!traceId || !/^[0-9a-f]{32}$/u.test(traceId) || !isNonZeroHex(traceId)) return undefined;
  if (!spanId || !/^[0-9a-f]{16}$/u.test(spanId) || !isNonZeroHex(spanId)) return undefined;
  return `${traceId}:${spanId}`;
}

function traceKeyFromTraceparent(value: unknown): string | undefined {
  const traceparent = boundedIdentity(value);
  if (!traceparent) return undefined;
  // Restrict correlation to the exact canonical W3C form OpenClaw currently
  // emits. Reject extensions/future forms instead of weakening identity.
  const match = /^00-([0-9a-fA-F]{32})-([0-9a-fA-F]{16})-([0-9a-fA-F]{2})$/u.exec(traceparent);
  if (!match) return undefined;
  return traceKeyFromContext({ traceId: match[1], spanId: match[2] });
}

function traceKeyFromHeaders(value: unknown): string | undefined {
  const headers = asRecord(value);
  if (!headers) return undefined;
  let candidate: string | undefined;
  for (const [name, raw] of Object.entries(headers)) {
    if (name.toLowerCase() !== "traceparent") continue;
    if (typeof raw !== "string") return undefined;
    const normalized = raw.trim().toLowerCase();
    if (candidate !== undefined && candidate !== normalized) return undefined;
    candidate = normalized;
  }
  return traceKeyFromTraceparent(candidate);
}

function recordModelCallStarted(event: unknown, ctx: unknown): void {
  const context = asRecord(ctx);
  const traceKey = traceKeyFromContext(context?.trace);
  const sessionId = boundedIdentity(context?.sessionId);
  if (!traceKey || !sessionId) return;

  // The lifecycle context owns identity. An event session is only a
  // consistency check and must never stand in for a missing context session.
  const eventSessionId = boundedIdentity(asRecord(event)?.sessionId);
  if (eventSessionId && eventSessionId !== sessionId) {
    traceSessionBridge.markAmbiguous(traceKey);
    return;
  }
  traceSessionBridge.record(traceKey, sessionId);
}

function registerTraceSessionBridgeHook(api: OpenClawPluginApi): boolean {
  const on = (api as unknown as { on?: unknown }).on;
  if (typeof on !== "function") return false;
  try {
    (on as (name: string, handler: (event: unknown, ctx: unknown) => void) => void).call(
      api,
      "model_call_started",
      recordModelCallStarted,
    );
    return true;
  } catch {
    return false;
  }
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
    const directOptionsSessionId = boundedIdentity(optionRecord?.sessionId);
    const wrapperSessionId = boundedIdentity((ctx as { sessionId?: unknown }).sessionId);
    const traceKey = traceKeyFromHeaders(optionRecord?.headers);
    let resolvedSessionId: string | undefined;
    const resolveSessionId = (): string | undefined => {
      if (resolvedSessionId) return resolvedSessionId;
      const sessionId = directOptionsSessionId ?? wrapperSessionId ??
        (traceKey ? traceSessionBridge.resolve(traceKey) : undefined);
      if (sessionId) resolvedSessionId = sessionId;
      return sessionId;
    };
    const previousOnPayload = options?.onPayload;
    const previousOnResponse = options?.onResponse;
    // A trace entry that already exists can safely carry the scoped override
    // on the first attempt. A queued lifecycle hook may arrive later; payload
    // identity resolution below yields once for that race but never guesses.
    const initialSessionId = resolveSessionId();
    const algorithm = initialSessionId ? getAutorouterAlgorithm(initialSessionId) : undefined;

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
        // OpenClaw dispatches model_call_started through a queued microtask.
        // Yield once only when direct native identities are unavailable; the
        // later resolution still requires an exact validated trace/span match.
        if (!directOptionsSessionId && !wrapperSessionId && traceKey) await Promise.resolve();
        const sessionId = resolveSessionId();
        if (!sessionId) return previousOnPayload ? previousOnPayload(payload, payloadModel) : payload;
        const correlation = buildCorrelationMetadata({
          sessionId,
          agentId: agentIdFromSession(sessionId),
          provider: ctx.provider,
          modelId: modelIdFromContext(ctx),
        });
        const patched = asRecord(payload)
          ? patchPayloadMetadata(asRecord(payload)!, sessionId, correlation)
          : payload;
        return previousOnPayload ? previousOnPayload(patched, payloadModel) : patched;
      },
      onResponse: async (response, responseModel) => {
        const sessionId = resolveSessionId();
        if (sessionId) captureAutorouterResponse(sessionId, response?.headers);
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
  name: "CloudSigma AI Mission Control",
  description:
    "One plugin. Every leading AI model. Connect OpenClaw to CloudSigma Mission Control with streaming, tool calling, live model discovery, session affinity, optimised autorouter, and prompt-cache-aware routing.",
  provider: {
    label: "CloudSigma AI Mission Control",
    docsPath: "/providers/cloudsigma",
    aliases: ["cloudsigma-taas"],
    envVars: ["CLOUDSIGMA_API_KEY"],
    auth: [
      {
        methodId: "api-key",
        label: "CloudSigma Mission Control API key",
        hint: "OpenAI-compatible multi-model gateway",
        optionKey: "cloudsigmaApiKey",
        flagName: "--cloudsigma-api-key",
        envVar: "CLOUDSIGMA_API_KEY",
        promptMessage: "Enter CloudSigma Mission Control API key",
        defaultModel: CLOUDSIGMA_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyCloudsigmaConfig(cfg),
        noteMessage: [
          "CloudSigma Mission Control is an OpenAI-compatible multi-model gateway: Claude, GPT, Gemini, Kimi, Qwen, GLM, Llama, and Pixtral routes behind one key.",
          "Create an API key at: https://taas.cloudsigma.com",
        ].join("\n"),
        noteTitle: "CloudSigma AI Mission Control",
        wizard: {
          groupLabel: "CloudSigma AI Mission Control",
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
    registerTraceSessionBridgeHook(api);
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
    TraceSessionBridge,
    traceSessionBridge,
    traceKeyFromContext,
    traceKeyFromTraceparent,
    traceKeyFromHeaders,
    recordModelCallStarted,
  },
};

export default plugin;
