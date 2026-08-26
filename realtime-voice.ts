import { isProviderAuthProfileConfigured, resolveProviderAuthProfileApiKey } from "openclaw/plugin-sdk/provider-auth";
import { resolvePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { readProviderJsonResponse, readResponseTextLimited } from "openclaw/plugin-sdk/provider-http";
import type {
  RealtimeVoiceBrowserSession,
  RealtimeVoiceBrowserSessionCreateRequest,
  RealtimeVoiceProviderPlugin,
} from "openclaw/plugin-sdk/realtime-voice";
import { REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ } from "openclaw/plugin-sdk/realtime-voice";
import { hasConfiguredSecretInput, normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type { SecretInput } from "openclaw/plugin-sdk/secret-input";
import { resolveExpiresAtMsFromEpochSeconds } from "openclaw/plugin-sdk/number-runtime";
import { fetchWithSsrFGuard, ssrfPolicyFromHttpBaseUrlAllowedOrigin } from "openclaw/plugin-sdk/ssrf-runtime";

export const CLOUDSIGMA_REALTIME_PROVIDER_ID = "cloudsigma";
export const CLOUDSIGMA_REALTIME_MODEL = "gpt-realtime-2.1";
export const CLOUDSIGMA_REALTIME_ORIGIN = "https://taas.cloudsigma.com";
export const CLOUDSIGMA_REALTIME_CLIENT_SECRETS_URL = `${CLOUDSIGMA_REALTIME_ORIGIN}/v1/realtime/client_secrets`;
export const CLOUDSIGMA_REALTIME_CALLS_URL = `${CLOUDSIGMA_REALTIME_ORIGIN}/v1/realtime/calls`;

const DEFAULT_REQUEST_TIMEOUT_MS = 25_000;
const MIN_REQUEST_TIMEOUT_MS = 5_000;
const MAX_REQUEST_TIMEOUT_MS = 60_000;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_ERROR_BYTES = 4 * 1024;
const API_KEY_PATH = "plugins.entries.cloudsigma.config.apiKey";

export interface CloudsigmaRealtimeConfig extends Record<string, unknown> {
  apiKey?: SecretInput;
  browserOrigin?: string;
  realtimeRequestTimeoutMs?: number;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function normalizeConfig(raw: Record<string, unknown>): CloudsigmaRealtimeConfig {
  return {
    apiKey: raw.apiKey as SecretInput | undefined,
    browserOrigin: typeof raw.browserOrigin === "string" ? raw.browserOrigin : undefined,
    realtimeRequestTimeoutMs:
      typeof raw.realtimeRequestTimeoutMs === "number" && Number.isFinite(raw.realtimeRequestTimeoutMs)
        ? Math.min(
            MAX_REQUEST_TIMEOUT_MS,
            Math.max(MIN_REQUEST_TIMEOUT_MS, Math.floor(raw.realtimeRequestTimeoutMs)),
          )
        : DEFAULT_REQUEST_TIMEOUT_MS,
  };
}

function requireExactBrowserOrigin(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("CloudSigma Talk requires an exact browserOrigin");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("CloudSigma Talk browserOrigin must be an exact HTTPS origin");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "/" && parsed.pathname !== "") ||
    value !== parsed.origin
  ) {
    throw new Error("CloudSigma Talk browserOrigin must be an exact HTTPS origin");
  }
  return value;
}

function explicitApiKey(value: SecretInput | undefined): string | undefined {
  return normalizeResolvedSecretInputString({ value, path: API_KEY_PATH });
}

async function resolveCloudsigmaTalkApiKey(req: RealtimeVoiceBrowserSessionCreateRequest): Promise<string> {
  const config = normalizeConfig(req.providerConfig);
  const explicit = explicitApiKey(config.apiKey);
  if (explicit) return explicit;

  const profile = await resolveProviderAuthProfileApiKey({
    provider: CLOUDSIGMA_REALTIME_PROVIDER_ID,
    cfg: req.cfg,
    profileTypes: ["api_key"],
  });
  if (profile) return profile;

  const env = process.env.CLOUDSIGMA_API_KEY?.trim() || process.env.TAAS_API_KEY?.trim();
  if (env) return env;

  throw new Error(
    "CloudSigma Talk requires apiKey, a CloudSigma API-key auth profile, CLOUDSIGMA_API_KEY, or TAAS_API_KEY",
  );
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export interface CloudsigmaClientSecret {
  value: string;
  expiresAt?: number;
  model?: string;
  voice?: string;
}

function readSessionVoice(session: JsonRecord | undefined): string | undefined {
  const audio = asRecord(session?.audio);
  return readNonEmptyString(asRecord(audio?.output)?.voice) ?? readNonEmptyString(session?.voice);
}

/** Accepts the GA response and the former nested response, but never ambiguous credentials. */
export function parseCloudsigmaClientSecret(payload: unknown): CloudsigmaClientSecret {
  const root = asRecord(payload);
  if (!root) throw new Error("CloudSigma Talk returned malformed JSON");

  const gaValue = readNonEmptyString(root.value);
  const legacy = asRecord(root.client_secret);
  const legacyValue = readNonEmptyString(legacy?.value);
  if (gaValue && legacyValue && gaValue !== legacyValue) {
    throw new Error("CloudSigma Talk returned conflicting client credentials");
  }
  const value = gaValue ?? legacyValue;
  if (!value) throw new Error("CloudSigma Talk response did not include an ephemeral client secret");

  const expiresAt =
    resolveExpiresAtMsFromEpochSeconds(root.expires_at) ??
    resolveExpiresAtMsFromEpochSeconds(legacy?.expires_at);
  const session = asRecord(root.session);
  const model = readNonEmptyString(session?.model) ?? readNonEmptyString(root.model);
  const voice = readSessionVoice(session) ?? readNonEmptyString(root.voice);
  return {
    value,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(model ? { model } : {}),
    ...(voice ? { voice } : {}),
  };
}

async function requestClientSecret(params: {
  apiKey: string;
  browserOrigin: string;
  timeoutMs: number;
  req: RealtimeVoiceBrowserSessionCreateRequest;
}): Promise<CloudsigmaClientSecret> {
  const tools = params.req.tools?.map((tool) => ({
    type: "function",
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    parameters: tool.parameters,
  }));
  const session: JsonRecord = {
    type: "realtime",
    model: CLOUDSIGMA_REALTIME_MODEL,
    ...(params.req.instructions ? { instructions: params.req.instructions } : {}),
    audio: {
      input: {
        turn_detection: {
          type: "server_vad",
          create_response: true,
          interrupt_response: true,
          ...(typeof params.req.vadThreshold === "number"
            ? { threshold: params.req.vadThreshold }
            : {}),
          ...(typeof params.req.prefixPaddingMs === "number"
            ? { prefix_padding_ms: params.req.prefixPaddingMs }
            : {}),
          ...(typeof params.req.silenceDurationMs === "number"
            ? { silence_duration_ms: params.req.silenceDurationMs }
            : {}),
        },
      },
      ...(params.req.voice ? { output: { voice: params.req.voice } } : {}),
    },
    ...(tools?.length ? { tools, tool_choice: "auto" } : {}),
  };
  const { response, release } = await fetchWithSsrFGuard({
    url: CLOUDSIGMA_REALTIME_CLIENT_SECRETS_URL,
    init: {
      method: "POST",
      redirect: "error",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${params.apiKey}`,
        "Content-Type": "application/json",
        Origin: params.browserOrigin,
      },
      body: JSON.stringify({ session }),
    },
    timeoutMs: params.timeoutMs,
    policy: ssrfPolicyFromHttpBaseUrlAllowedOrigin(CLOUDSIGMA_REALTIME_ORIGIN),
    auditContext: "cloudsigma.realtime.client_secret",
  });
  try {
    if (!response.ok) {
      const detail = (await readResponseTextLimited(response, MAX_ERROR_BYTES)).trim();
      throw new Error(
        `CloudSigma Talk client secret request failed (HTTP ${response.status})${detail ? ": provider returned a bounded error" : ""}`,
      );
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
      throw new Error("CloudSigma Talk returned a non-JSON response");
    }
    const payload = await readProviderJsonResponse(response, "CloudSigma Talk client secret", {
      maxBytes: MAX_JSON_BYTES,
    });
    return parseCloudsigmaClientSecret(payload);
  } finally {
    await release();
  }
}

export async function createCloudsigmaBrowserSession(
  req: RealtimeVoiceBrowserSessionCreateRequest,
): Promise<RealtimeVoiceBrowserSession> {
  if (req.model !== undefined && req.model !== CLOUDSIGMA_REALTIME_MODEL) {
    throw new Error(`CloudSigma Talk supports only ${CLOUDSIGMA_REALTIME_MODEL}`);
  }
  const config = normalizeConfig(req.providerConfig);
  const browserOrigin = requireExactBrowserOrigin(config.browserOrigin);
  const apiKey = await resolveCloudsigmaTalkApiKey(req);
  const clientSecret = await requestClientSecret({
    apiKey,
    browserOrigin,
    timeoutMs: config.realtimeRequestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    req,
  });
  const model = clientSecret.model ?? CLOUDSIGMA_REALTIME_MODEL;
  const voice = clientSecret.voice ?? req.voice;
  return {
    provider: CLOUDSIGMA_REALTIME_PROVIDER_ID,
    transport: "webrtc",
    clientSecret: clientSecret.value,
    offerUrl: CLOUDSIGMA_REALTIME_CALLS_URL,
    model,
    ...(voice ? { voice } : {}),
    ...(clientSecret.expiresAt !== undefined ? { expiresAt: clientSecret.expiresAt } : {}),
  };
}

export function buildCloudsigmaRealtimeVoiceProvider(): RealtimeVoiceProviderPlugin {
  return {
    id: CLOUDSIGMA_REALTIME_PROVIDER_ID,
    label: "CloudSigma Talk",
    defaultModel: CLOUDSIGMA_REALTIME_MODEL,
    models: [CLOUDSIGMA_REALTIME_MODEL],
    capabilities: {
      transports: ["webrtc"],
      inputAudioFormats: [REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ],
      outputAudioFormats: [REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ],
      supportsBrowserSession: true,
      supportsBargeIn: true,
      handlesInputAudioBargeIn: true,
      supportsToolCalls: true,
    },
    resolveConfig: ({ cfg, rawConfig }) => {
      const pluginConfig = resolvePluginConfigObject(cfg, CLOUDSIGMA_REALTIME_PROVIDER_ID) ?? {};
      // Talk has no provider-local options today. In particular, never let raw
      // Talk config override the manifest-owned credential or browser origin.
      void rawConfig;
      return normalizeConfig(pluginConfig);
    },
    isConfigured: ({ cfg, providerConfig }) => {
      const config = normalizeConfig(providerConfig);
      const hasOrigin = (() => {
        try {
          requireExactBrowserOrigin(config.browserOrigin);
          return true;
        } catch {
          return false;
        }
      })();
      if (!hasOrigin) return false;
      return (
        hasConfiguredSecretInput(config.apiKey) ||
        isProviderAuthProfileConfigured({
          provider: CLOUDSIGMA_REALTIME_PROVIDER_ID,
          cfg,
          profileTypes: ["api_key"],
        }) ||
        Boolean(process.env.CLOUDSIGMA_API_KEY?.trim() || process.env.TAAS_API_KEY?.trim())
      );
    },
    createBridge: () => {
      throw new Error("CloudSigma Talk supports browser WebRTC only; server bridges are disabled");
    },
    createBrowserSession: createCloudsigmaBrowserSession,
  };
}
