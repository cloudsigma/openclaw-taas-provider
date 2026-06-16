# CloudSigma TaaS Provider for OpenClaw

[![CI](https://github.com/cloudsigma/openclaw-taas-provider/actions/workflows/ci.yml/badge.svg)](https://github.com/cloudsigma/openclaw-taas-provider/actions/workflows/ci.yml)

OpenClaw provider plugin for **CloudSigma TaaS** — an OpenAI-compatible, multi-model gateway that exposes CloudSigma-hosted model routes through one OpenClaw provider.

This plugin lets OpenClaw use CloudSigma TaaS as a first-class model provider with API-key onboarding, a conservative static model catalog, live model discovery when credentials are available, and OpenAI-compatible request handling.

## What this plugin provides

- Provider id: `cloudsigma`
- Provider alias: `cloudsigma-taas`
- Default model: `cloudsigma/gpt-5.5`
- Default endpoint: `https://taas.cloudsigma.com/v1`
- Auth via `CLOUDSIGMA_API_KEY`
- OpenAI-compatible chat/completions transport
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

- OpenClaw `>=2026.6.6`
- A CloudSigma TaaS API key
- Network access to `https://taas.cloudsigma.com/v1`

## Configure

Set the CloudSigma TaaS API key in the OpenClaw runtime environment:

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

## Onboarding behavior

During OpenClaw provider setup, the plugin exposes an API-key auth choice:

- Label: `CloudSigma TaaS API key`
- CLI flag: `--cloudsigma-api-key <key>`
- Environment variable: `CLOUDSIGMA_API_KEY`
- Default model: `cloudsigma/gpt-5.5`

The plugin writes the CloudSigma provider catalog into OpenClaw config and adds a friendly alias named `CloudSigma TaaS` for the default model.

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
      "pluginApi": ">=2026.6.6",
      "minGatewayVersion": "2026.6.6"
    },
    "build": {
      "openclawVersion": "2026.6.6",
      "pluginSdkVersion": "2026.6.6"
    }
  }
}
```

## Validation and release gates

Before publishing, releases are expected to pass:

```bash
npm ci
npm run build
npm test
npx -y clawhub@0.21.0 package validate . --json
npx -y clawhub@0.21.0 package pack . --pack-destination artifacts --json
```

The test suite covers:

- Plugin registration
- Provider id, alias, auth metadata, and catalog registration
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

## Package identity

- Package: `@cloudsigma/openclaw-taas-provider`
- Runtime/provider id: `cloudsigma`
- Alias: `cloudsigma-taas`
- License: MIT
- Publisher: CloudSigma
