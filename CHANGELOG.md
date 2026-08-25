# Changelog

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
