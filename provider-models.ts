// Cloudsigma provider module implements live model discovery.
import { readProviderJsonArrayFieldResponse } from "openclaw/plugin-sdk/provider-http";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { asPositiveSafeInteger } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  buildCloudsigmaModelDefinition,
  CLOUDSIGMA_BASE_URL,
  CLOUDSIGMA_MODEL_CATALOG,
} from "./models.js";

const log = createSubsystemLogger("cloudsigma-models");

export const CLOUDSIGMA_MODELS_URL = `${CLOUDSIGMA_BASE_URL}/models`;

const DISCOVERY_TIMEOUT_MS = 5000;
const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 8192;

/** TaaS catalog row types projected into the chat model catalog. */
const CHAT_MODEL_TYPES = new Set(["chat", "vision"]);

interface TaasModelCapabilities {
  chat_completions?: boolean;
  reasoning?: boolean;
  thinking?: boolean;
  vision?: boolean;
}

interface TaasModelPricing {
  input?: number;
  output?: number;
}

interface TaasModelEntry {
  id: string;
  type?: string;
  context_window?: number | null;
  max_output_tokens?: number | null;
  capabilities?: TaasModelCapabilities;
  pricing?: TaasModelPricing;
}

function asPriceNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function readTaasModelId(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "";
  }
  const id = (value as Partial<TaasModelEntry>).id;
  return typeof id === "string" ? id.trim() : "";
}

function asTaasModelEntry(value: unknown): TaasModelEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("CloudSigma TaaS model list: malformed JSON response");
  }
  const entry = value as Partial<TaasModelEntry>;
  if (typeof entry.id !== "string") {
    throw new Error("CloudSigma TaaS model list: malformed JSON response");
  }
  return value as TaasModelEntry;
}

function isChatRoute(entry: TaasModelEntry): boolean {
  return CHAT_MODEL_TYPES.has(entry.type ?? "") && entry.capabilities?.chat_completions === true;
}

/** Image input stays conservative: only dedicated vision routes advertise it. */
function parseModality(entry: TaasModelEntry): Array<"text" | "image"> {
  return entry.type === "vision" && entry.capabilities?.vision === true
    ? ["text", "image"]
    : ["text"];
}

function toModelDefinition(entry: TaasModelEntry): ModelDefinitionConfig {
  return {
    id: entry.id,
    name: entry.id,
    reasoning: entry.capabilities?.reasoning === true || entry.capabilities?.thinking === true,
    input: parseModality(entry),
    cost: {
      input: asPriceNumber(entry.pricing?.input),
      output: asPriceNumber(entry.pricing?.output),
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: asPositiveSafeInteger(entry.context_window) ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: asPositiveSafeInteger(entry.max_output_tokens) ?? DEFAULT_MAX_TOKENS,
  };
}

function buildStaticCatalog(): ModelDefinitionConfig[] {
  return CLOUDSIGMA_MODEL_CATALOG.map(buildCloudsigmaModelDefinition);
}

/** Discovers chat-capable CloudSigma TaaS models; seed rows stay authoritative, live rows supplement. */
export async function discoverCloudsigmaModels(params?: {
  apiKey?: string;
}): Promise<ModelDefinitionConfig[]> {
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return buildStaticCatalog();
  }

  try {
    const { response, release } = await fetchWithSsrFGuard({
      url: CLOUDSIGMA_MODELS_URL,
      init: {
        headers: {
          Accept: "application/json",
          ...(params?.apiKey ? { Authorization: `Bearer ${params.apiKey}` } : {}),
        },
      },
      timeoutMs: DISCOVERY_TIMEOUT_MS,
      policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(CLOUDSIGMA_BASE_URL),
      auditContext: "cloudsigma.model_discovery",
    });
    try {
      if (!response.ok) {
        log.warn(`Failed to discover models: HTTP ${response.status}, using static catalog`);
        return buildStaticCatalog();
      }

      const data = await readProviderJsonArrayFieldResponse(
        response,
        "CloudSigma TaaS model list",
        "data",
      );
      if (data.length === 0) {
        log.warn("No models found from TaaS API, using static catalog");
        return buildStaticCatalog();
      }

      const discovered: ModelDefinitionConfig[] = [];
      const seedIds = new Set(CLOUDSIGMA_MODEL_CATALOG.map((model) => model.id));
      const discoveredIds = new Set<string>();

      for (const rawEntry of data) {
        const id = readTaasModelId(rawEntry);
        try {
          const entry = asTaasModelEntry(rawEntry);
          if (!id || discoveredIds.has(id) || seedIds.has(id) || !isChatRoute(entry)) {
            continue;
          }
          discovered.push(toModelDefinition(entry));
          discoveredIds.add(id);
        } catch (e) {
          log.warn(`Skipping malformed model entry "${id}": ${String(e)}`);
        }
      }

      // Live-verified seed rows lead the catalog; discovery only supplements them.
      return [...buildStaticCatalog(), ...discovered];
    } finally {
      await release();
    }
  } catch (error) {
    log.warn(`Discovery failed: ${String(error)}, using static catalog`);
    return buildStaticCatalog();
  }
}
