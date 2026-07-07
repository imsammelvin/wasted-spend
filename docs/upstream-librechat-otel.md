# Upstream contribution draft — LibreChat OpenTelemetry support

> Post as a GitHub Discussion/issue on danny-avila/LibreChat titled
> **"Docs/recipe: zero-fork OpenTelemetry instrumentation for LibreChat"**,
> or as a docs PR adding a page under deployment guides. Text below is ready to paste.

---

## Summary

LibreChat can be fully instrumented with OpenTelemetry — traces for every HTTP
request, MongoDB query, and outbound LLM call — **without any code changes**,
using Node's preload mechanism and OTel's auto-instrumentation. We've been running
this in production-style demos (ClickHouse Click-a-thon 2026) and it also enables
end-to-end trace correlation with LLM observability tools (Langfuse via LiteLLM).

## Recipe

**1. A Dockerfile layer (not a fork) adds the packages:**

```dockerfile
FROM ghcr.io/danny-avila/librechat-dev:latest
USER root
RUN mkdir /otel && cd /otel && npm init -y >/dev/null \
    && npm install --omit=dev @opentelemetry/api @opentelemetry/auto-instrumentations-node \
    && chown -R node:node /otel
USER node
```

**2. Environment variables activate it:**

```yaml
NODE_OPTIONS: --require /otel/node_modules/@opentelemetry/auto-instrumentations-node/build/src/register.js
OTEL_SERVICE_NAME: librechat
OTEL_EXPORTER_OTLP_ENDPOINT: http://<your-collector>:4318
OTEL_TRACES_EXPORTER: otlp
OTEL_LOGS_EXPORTER: otlp
OTEL_METRICS_EXPORTER: otlp
OTEL_NODE_DISABLED_INSTRUMENTATIONS: fs,dns,net   # noise control
```

Notes we learned the hard way (worth documenting):
- The `--require` path must be the **file** (`build/src/register.js`) — an absolute
  path bypasses the package's `exports` map, so `.../register` does not resolve.
- Disabling `fs,dns,net` instrumentations matters; they drown Node apps in spans.
- The auto-instrumented HTTP client also **propagates W3C `traceparent`** on
  outbound calls — so downstream proxies (e.g. LiteLLM) can correlate LLM telemetry
  with the originating request. This is what enables full-stack tracing for AI apps.

## Why upstream

AI apps have a torn observability story: infra tools can't see tokens/cost, LLM
tools can't see infra. LibreChat is the reference self-hosted AI chat — a documented
OTel recipe makes it the reference *observable* AI chat too. Happy to contribute
this as a docs page + compose example; no core changes required.

Working reference: https://github.com/imsammelvin/wasted-spend
