# CloudSigma TaaS Provider for OpenClaw

OpenClaw provider plugin for CloudSigma TaaS, an OpenAI-compatible multi-model gateway.

## Install

```bash
openclaw plugins install clawhub:@cloudsigma/openclaw-taas-provider
```

OpenClaw install source:

```txt
clawhub:@cloudsigma/openclaw-taas-provider
```

## Configure

Set a CloudSigma TaaS API key:

```bash
export CLOUDSIGMA_API_KEY=...
```

The provider id is `cloudsigma`; the provider alias is `cloudsigma-taas`.

Default endpoint:

```txt
https://taas.cloudsigma.com/v1
```

## Notes

Dynamic model discovery uses CloudSigma TaaS model metadata and is gated on a usable API key. The static catalog is conservative: image support is advertised only for routes verified or declared as true vision-capable.
