#!/usr/bin/env bash
# Fault injection for the live demo. Toggles toxics on the toxiproxy switchboard
# and stamps a deploy marker so the RCA agent has a "deploy at 2:47" to blame.
#
#   ./loadgen/chaos.sh slow-llm [ms]     latency on LibreChat→LiteLLM (default 2500)
#   ./loadgen/chaos.sh slow-db  [ms]     latency on LibreChat→Mongo   (default 400)
#   ./loadgen/chaos.sh timeout           LLM calls hang until client timeout
#   ./loadgen/chaos.sh heal              remove all faults
#   ./loadgen/chaos.sh status            list active faults
#
# Demo recipe: loadgen running (patience 1-3s) → `chaos.sh slow-llm` → within
# ~60s the burn counter climbs and root cause names the slow call → `heal`.
set -euo pipefail
cd "$(dirname "$0")/.."

API=${TOXIPROXY_API:-http://localhost:8474}
CH_PASSWORD=$(grep '^CLICKHOUSE_PASSWORD=' .env | cut -d= -f2)

mark_deploy() {
  docker compose exec -T clickhouse clickhouse-client --password "$CH_PASSWORD" -q \
    "INSERT INTO deploy_events VALUES (now(), '$1', 'v9.$(date +%M).0', '$2')"
  echo "deploy marker: $1 — $2"
}

toxic() { # proxy name type json-attributes
  curl -sf -X POST "$API/proxies/$1/toxics" -d \
    "{\"name\":\"$2\",\"type\":\"$3\",\"stream\":\"downstream\",\"attributes\":$4}" >/dev/null
}

case "${1:-status}" in
  slow-llm)
    MS=${2:-2500}
    toxic litellm chaos-lag latency "{\"latency\":$MS,\"jitter\":$((MS / 5))}"
    mark_deploy llm-gateway "routing change — added ${MS}ms to every LLM call"
    echo "FAULT ON: LLM calls +${MS}ms. Impatient clients will start re-sending."
    ;;
  slow-db)
    MS=${2:-400}
    toxic mongo chaos-lag latency "{\"latency\":$MS,\"jitter\":$((MS / 4))}"
    mark_deploy chat-db "index rebuild — mongo +${MS}ms per query"
    echo "FAULT ON: Mongo +${MS}ms. Request handling crawls."
    ;;
  timeout)
    toxic litellm chaos-timeout timeout '{"timeout":30000}'
    mark_deploy llm-gateway 'upstream connections hanging (no data)'
    echo "FAULT ON: LLM calls hang. Expect client timeouts + retries."
    ;;
  heal)
    for p in litellm mongo; do
      for t in chaos-lag chaos-timeout; do
        curl -s -X DELETE "$API/proxies/$p/toxics/$t" >/dev/null 2>&1 || true
      done
    done
    echo "HEALED: all faults removed."
    ;;
  status)
    for p in litellm mongo; do
      echo "$p: $(curl -s "$API/proxies/$p/toxics")"
    done
    ;;
  *)
    echo "usage: $0 {slow-llm [ms]|slow-db [ms]|timeout|heal|status}"; exit 1
    ;;
esac
