# Changelog

## 0.1.0

- Initial CloudSigma TaaS provider plugin for OpenClaw.
- Adds provider id `cloudsigma` and alias `cloudsigma-taas`.
- Supports API-key auth through `CLOUDSIGMA_API_KEY`.
- Provides a conservative static model catalog plus live CloudSigma TaaS model discovery when credentials are available.
- Registers OpenAI-compatible replay/tool compatibility hooks for CloudSigma TaaS routes.
