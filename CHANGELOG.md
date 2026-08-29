# Changelog

## 0.2.5

- Correct the runtime `X-OpenClaw-Plugin-Version` header and correlation metadata to report `0.2.5` instead of the stale `0.2.3` value found during the Snowcrash/Rufus fleet canary.
- Add regression expectations for both the transport header and payload correlation version.

## 0.2.4

- Rename the public plugin and marketplace listing to **CloudSigma AI Mission Control**.
- Describe the one-plugin experience across GPT, Claude, Gemini, Kimi, Qwen, and other models, including streaming, tool calling, live discovery, session affinity, optimised AutoRouter, and prompt-cache-aware routing.
- Keep the package name, provider id, configuration keys, and installation path unchanged for compatibility.

## 0.2.3

- Consolidate native OpenClaw session affinity into the first-class CloudSigma provider for full agent/tool and simple-completion streams.
- Forward bounded session, agent, turn, attempt, and plugin-version transport headers to TaaS.
- Add no-overwrite session/sticky/correlation payload metadata across GPT, Claude, AutoRouter, and generic CloudSigma models.
- Preserve generic/background identity through a bounded, exact W3C trace/span bridge that fails closed on malformed or conflicting correlation.
- Add bounded per-session AutoRouter controls and response capture, plus a coexistence warning for the legacy affinity optimizer.
- Activate at Gateway startup so lifecycle subscriptions and operator RPC methods are reliably registered.

## 0.2.2

- Request `gpt-4o-mini-transcribe` input transcription in browser WebRTC sessions so completed speech produces the final transcript required by OpenClaw agent consults.

## 0.2.1

- Raise the bounded realtime client-secret mint deadline to 25 seconds, with an explicit 5–60 second plugin configuration range, while preserving one-attempt semantics and all SSRF, redirect, body-size, and credential-redaction safeguards.

## 0.2.0

- Add first-class CloudSigma realtime Talk registration for browser WebRTC.
- Mint scoped credentials through the fixed TaaS client-secret endpoint for `gpt-realtime-2.1`.
- Add strict credential precedence, exact browser-origin binding, SSRF/redirect protections, bounded response parsing, and GA/legacy response compatibility.
- Materialize plugin `apiKey` SecretRefs through the OpenClaw runtime config contract.
- Mint browser sessions with OpenAI-compatible server VAD and return effective expiry/model/voice metadata.
- Document the static `browserOrigin` requirement in OpenClaw `2026.7.1-2`.
- Upgrade the public OpenClaw plugin SDK contract to `2026.7.1-2`.

## 0.1.2

- Expands the public README/ClawHub listing with full install, setup, model catalog, discovery, security, compatibility, validation, and troubleshooting documentation.
- Clarifies package identity, provider id, alias, default endpoint, default model, and supported behavior.
- Improves package and manifest descriptions so registry/search surfaces communicate what the plugin actually does.

## 0.1.1

- Adds explicit package-level OpenClaw provider metadata and minimum gateway compatibility metadata.

## 0.1.0

- Initial CloudSigma TaaS provider plugin for OpenClaw.
- Adds provider id `cloudsigma` and alias `cloudsigma-taas`.
- Supports API-key auth through `CLOUDSIGMA_API_KEY`.
- Provides a conservative static model catalog plus live CloudSigma TaaS model discovery when credentials are available.
- Registers OpenAI-compatible replay/tool compatibility hooks for CloudSigma TaaS routes.
