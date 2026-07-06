# OTel auto-instrumentation layer on top of upstream LibreChat — NOT a fork.
# Packages install into /otel (own tree) so LibreChat's node_modules stay untouched.
FROM registry.librechat.ai/danny-avila/librechat-dev:latest

USER root
RUN mkdir /otel && cd /otel && npm init -y >/dev/null \
    && npm install --omit=dev \
       @opentelemetry/api \
       @opentelemetry/auto-instrumentations-node \
    && chown -R node:node /otel
USER node

# Activated via absolute path so module resolution never depends on /app:
#   NODE_OPTIONS=--require /otel/node_modules/@opentelemetry/auto-instrumentations-node/build/src/register.js
# (set in docker-compose.yml together with OTEL_* env vars)
# NB: must be the real file — an absolute path bypasses the package exports map,
# so ".../auto-instrumentations-node/register" does NOT resolve.
