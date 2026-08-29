# CloudSigma AI Mission Control

[![CI](https://github.com/cloudsigma/openclaw-taas-provider/actions/workflows/ci.yml/badge.svg)](https://github.com/cloudsigma/openclaw-taas-provider/actions/workflows/ci.yml)

**One plugin. Every leading AI model.** Connect OpenClaw to CloudSigma Mission Control for GPT, Claude, Gemini, Kimi, Qwen and more—with streaming, tool calling, live model discovery, session affinity, optimised autorouter and prompt-cache-aware routing built in.

CloudSigma AI Mission Control is the first-class OpenClaw provider for CloudSigma TaaS. It includes API-key onboarding, a conservative static model catalog, OpenAI-compatible request handling, native OpenClaw session affinity, and browser WebRTC Talk through `gpt-realtime-2.1`.

## What this plugin provides

- Provider id: `cloudsigma`
- Provider alias: `cloudsigma-taas`
- Default model: `cloudsigma/gpt-5.5`
- Default endpoint: `https://taas.cloudsigma.com/v1`
- Auth via `CLOUDSIGMA_API_KEY`
- OpenAI-compatible chat/completions transport
- Native session affinity and bounded request correlation for agent, tool, and simple-completion streams
- Streaming usage support
- Tool-call compatibility through OpenAI-style tool payloads
- Replay/history compatibility for OpenAI-compatible provider families
- Live model discovery from CloudSigma TaaS `/models`, with safe static fallback
- Conservative image-capability metadata: image support is advertised only for models verified or explicitly marked as vision-capable
- SSRF-safe model discovery restricted to the CloudSigma TaaS host

## Install

```bash
openclaw plugins install clawhub:@cloudsigma/openclaw-taas-provider
```

> [!IMPORTANT]
> This is the **one-plugin CloudSigma setup**. New installations must not also
> install `openclaw-taas-affinity`; this provider owns the `cloudsigma` runtime
> hooks and includes its supported affinity behavior. Legacy affinity-only
> installations can remain temporarily unchanged until migrated as a controlled
> configuration update.

OpenClaw install source:

```txt
clawhub:@cloudsigma/openclaw-taas-provider
```

ClawHub package page:

```txt
https://clawhub.ai/plugins/@cloudsigma/openclaw-taas-provider
```

Source repository:

```txt
https://github.com/cloudsigma/openclaw-taas-provider
```

## Requirements

- OpenClaw `>=2026.7.1-2`
- A CloudSigma Mission Control API key
- Network access to `https://taas.cloudsigma.com/v1`

## Configure

Set the CloudSigma Mission Control API key in the OpenClaw runtime environment:

```bash
export CLOUDSIGMA_API_KEY=...
```

Then use CloudSigma models with model refs like:

```txt
cloudsigma/gpt-5.5
cloudsigma/claude-sonnet-4.6
cloudsigma/gemini-3.1-flash-lite
```

The provider alias `cloudsigma-taas` resolves to the same provider auth as `cloudsigma`.

## Session affinity and request correlation

CloudSigma TaaS uses a stable logical session key to preserve eligible upstream
continuations and prompt-cache locality. The provider forwards this only when
OpenClaw supplies its native per-conversation `sessionId`; it never creates an
identity from a workspace path, hostname, process state, time, prompt content,
or agent name.

Some generic/background and direct-simple OpenClaw paths carry the same native
identity through the public `model_call_started` lifecycle event rather than
`options.sessionId`. Where that hook is available, the provider correlates only
an exact valid W3C `traceId` + `spanId` from that event with the invocation's
`traceparent` header. Invocation `options.sessionId` wins, then a runtime
wrapper `ctx.sessionId`, then this exact trace bridge. The bridge is bounded to
1,024 entries, has a 30-minute sliding TTL, supports retry-safe reuse, and
fails closed for malformed or conflicting traces. It never uses timing,
workspace, process, agent, or environment state to correlate calls.

For each eligible HTTP/WebSocket transport turn, the plugin sends:

- `X-Session-Id` and `X-OpenClaw-Session-Id`
- `X-OpenClaw-Plugin-Version`
- `X-OpenClaw-Agent-Id` when it is encoded in the native session key
- `X-OpenClaw-Turn-Id` and `X-OpenClaw-Attempt`

For both normal agent/tool streams and direct/simple completions, it adds the
following OpenAI-compatible payload metadata when the caller has not already
provided that field:

- `metadata.session_id`
- `metadata.sticky_key`
- `metadata.openclaw_correlation` (schema/source/plugin version/session,
  agent when available, provider, and model)

Existing `metadata` fields are preserved, including caller-supplied session,
sticky, correlation, and `requester_runtime` values. A missing native session
means no affinity metadata is added. This makes unattributable traffic explicit
rather than silently conflating independent conversations.

AutoRouter response details and an optional AutoRouter algorithm preference are
kept in a bounded in-memory map keyed by that same native session id. They are
not shared across sessions and are not a replacement identity mechanism.

The plugin requests startup activation because its optional AutoRouter gateway
RPC methods and trace lifecycle subscription must be registered in the live
Gateway dispatch table. Provider-only lazy activation is not sufficient for
those Gateway surfaces.

### Privacy and security

Session identifiers are sent to CloudSigma TaaS because they are necessary for
session affinity. The provider validates them as bounded, header-safe strings
before forwarding. The correlation envelope contains no prompt text, workspace
paths, hostnames, environment values, git metadata, secrets, or requester-bridge
data. The plugin does not implement the retired requester bridge, does not poll
external services, and does not persist affinity state locally.

### Realtime Talk (WebRTC)

CloudSigma Talk is registered as realtime voice provider `cloudsigma`. It currently supports browser WebRTC only and uses the fixed model `gpt-realtime-2.1`.

> [!IMPORTANT]
> **In OpenClaw `2026.7.1-2`, `browserOrigin` is static plugin configuration; it is not inferred from each browser request. It must exactly equal the active OpenClaw UI origin and an origin on the CloudSigma TaaS allowlist.** Scheme, hostname, and port must all match. If the UI is served from another origin (including another port), update this setting and the TaaS allowlist before using Talk. Do not use a page URL: paths, queries, fragments, credentials, and a trailing slash are rejected.

```json5
{
  plugins: {
    entries: {
      cloudsigma: {
        enabled: true,
        config: {
          // Optional. SecretInput literals and secret references are supported.
          apiKey: { source: "env", provider: "default", id: "CLOUDSIGMA_API_KEY" },
          browserOrigin: "https://openclaw.example.com",
          realtimeRequestTimeoutMs: 25000
        }
      }
    }
  },
  talk: {
    realtime: {
      provider: "cloudsigma",
      transport: "webrtc"
    }
  }
}
```

Talk credential precedence is deliberately isolated from OpenAI authentication:

1. Explicit `plugins.entries.cloudsigma.config.apiKey`
2. A CloudSigma `api_key` auth profile
3. `CLOUDSIGMA_API_KEY`
4. `TAAS_API_KEY`

OpenAI API keys, OpenAI/Codex OAuth, and external OpenAI CLI credentials are never considered. The long-lived key remains server-side; the browser receives only the short-lived client secret and the fixed offer URL `https://taas.cloudsigma.com/v1/realtime/calls`.

`apiKey`, `browserOrigin`, and `realtimeRequestTimeoutMs` are authoritative only in `plugins.entries.cloudsigma.config`. Values with those names under `talk.realtime.providers.cloudsigma` are ignored; there are currently no supported provider-local Talk fields. OpenClaw materializes plugin `SecretInput` references before provider resolution, and the resolved configuration is then passed unchanged through readiness checks and browser-session minting. The realtime mint timeout defaults to 25 seconds and is clamped to 5–60 seconds; it remains a single bounded attempt and does not retry or reuse ephemeral credentials.

Browser sessions are minted with OpenAI-compatible `audio.input.turn_detection` server VAD, automatic response creation, and response interruption enabled. OpenClaw's `vadThreshold`, `prefixPaddingMs`, and `silenceDurationMs` Talk options are forwarded when set. This provider therefore advertises server-VAD barge-in support for its browser WebRTC transport.

## Onboarding behavior

During OpenClaw provider setup, the plugin exposes an API-key auth choice:

- Label: `CloudSigma Mission Control API key`
- CLI flag: `--cloudsigma-api-key <key>`
- Environment variable: `CLOUDSIGMA_API_KEY`
- Default model: `cloudsigma/gpt-5.5`

The plugin writes the CloudSigma provider catalog into OpenClaw config and retains the existing `CloudSigma TaaS` default-model alias for compatibility.

## Static catalog included in the package

The package ships a conservative static catalog so OpenClaw can start even before live model discovery succeeds.

Current seed models include:

| Model ref | Capabilities | Context | Max output | Notes |
|---|---:|---:|---:|---|
| `cloudsigma/gpt-5.5` | text | 400k | 128k | Default route |
| `cloudsigma/gpt-5.4` | text | 1.05M | 128k | Large-context GPT route |
| `cloudsigma/claude-fable-5` | text | 1M | 128k | Reasoning-capable Claude route |
| `cloudsigma/claude-opus-4.8` | text | 200k | 32k | High-end Claude route |
| `cloudsigma/claude-sonnet-4.6` | text | 1M | 64k | Balanced Claude route |
| `cloudsigma/gemini-3.1-flash-lite` | text, image | 1M | 65k | Vision-capable Gemini route |
| `cloudsigma/kimi-k2.6` | text | 262k | 262k | Long-output route |
| `cloudsigma/qwen3-vl` | text, image | 262k | 8k | Vision-language route |
| `cloudsigma/pixtral-large` | text, image | 128k | 4k | Vision-language route |
| `cloudsigma/qwen2.5-vl-72b` | text, image | 32k | 8k | Vision-language route |
| `cloudsigma/llama-3.3-70b` | text | 128k | 8k | Open model route |
| `cloudsigma/qwen3-235b` | text | 256k | 8k | Large Qwen route |
| `cloudsigma/glm-4.5-air` | text | 128k | 8k | Lightweight GLM route |

Live discovery can supplement this list with additional CloudSigma TaaS chat-capable models when the API key is available.

## Model discovery

At runtime, the plugin attempts to fetch CloudSigma TaaS model metadata from:

```txt
https://taas.cloudsigma.com/v1/models
```

Discovery behavior:

1. If no usable API key is present, OpenClaw uses the static catalog.
2. If the endpoint returns an error, malformed JSON, or no usable chat models, OpenClaw uses the static catalog.
3. If discovery succeeds, live models supplement the static catalog.
4. Static seed rows remain authoritative for known model ids, so verified defaults do not drift unexpectedly.

## Security notes

- The plugin does not store API keys in the package.
- Authentication is delegated to OpenClaw provider auth via `CLOUDSIGMA_API_KEY` / setup flow.
- Model discovery uses OpenClaw's SSRF-safe fetch helpers and restricts network access to the configured CloudSigma TaaS hostname.
- Talk client-secret minting is pinned to the exact `https://taas.cloudsigma.com` origin, denies redirects, bounds JSON and error bodies, and rejects conflicting GA/legacy credentials.
- Realtime server bridges fail closed; the initial Talk implementation is browser WebRTC only.
- The package manifest declares no tools, services, HTTP routes, bundled skills, or background daemons.
- The plugin executes provider registration code only; it does not install native dependencies.

## Compatibility metadata

This package declares the OpenClaw compatibility and build contract required for external ClawHub plugins:

```json
{
  "openclaw": {
    "extensions": ["./dist/index.js"],
    "providers": ["cloudsigma"],
    "compat": {
      "pluginApi": ">=2026.7.1-2",
      "minGatewayVersion": "2026.7.1-2"
    },
    "build": {
      "openclawVersion": "2026.7.1-2",
      "pluginSdkVersion": "2026.7.1-2"
    }
  }
}
```

## Validation and release gates

Before publishing, releases are expected to pass:

```bash
npm ci
npm run typecheck
npm run build
npm test
npx -y clawhub@0.21.0 package validate . --json
npx -y clawhub@0.21.0 package pack . --pack-destination artifacts --json
```

The test suite covers:

- Plugin registration
- Provider id, alias, auth metadata, and catalog registration
- Native transport headers (session, plugin version, agent, turn, and attempt)
- Session/sticky/correlation metadata for GPT, Claude, AutoRouter, and simple-completion paths
- Preservation of caller-provided metadata and no identity fallback without a native session
- Onboarding/default-model config writes
- Static catalog shape
- Live discovery success path
- Live discovery fallback on HTTP errors, network failures, malformed JSON, and empty model lists
- Conservative image-capability filtering

## Troubleshooting

### `CLOUDSIGMA_API_KEY` is missing

Set the key in the OpenClaw runtime environment and restart/reload the gateway process that loads plugins.

```bash
export CLOUDSIGMA_API_KEY=...
```

### A model is missing from the picker

The plugin always ships a static seed catalog. Additional models require live discovery, which needs a valid key and a successful response from `https://taas.cloudsigma.com/v1/models`.

### A vision model is not marked as image-capable

That is intentional unless the route is verified or the CloudSigma TaaS metadata explicitly declares vision/image support. The plugin avoids advertising image input for routes that are only text-safe.

### Requests fail with auth errors

Confirm the same environment that runs OpenClaw has `CLOUDSIGMA_API_KEY` set. Shell-local exports do not help if OpenClaw is running under a service manager with a different environment.

### Continuations do not stay on one TaaS route

Confirm that this provider plugin is enabled and that the OpenClaw request has a
native session id. The provider deliberately does not derive identity from a
workspace or process. On a new setup, remove any legacy
`openclaw-taas-affinity` plugin configuration so the single provider owns the
CloudSigma hook surface, then reload/restart OpenClaw through your normal
controlled operations process.

## Package identity

- Package: `@cloudsigma/openclaw-taas-provider`
- Runtime/provider id: `cloudsigma`
- Alias: `cloudsigma-taas`
- License: MIT
- Publisher: CloudSigma
