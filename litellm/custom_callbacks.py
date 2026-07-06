"""THE STITCH — one trace_id in both observability worlds.

LibreChat runs with OTel auto-instrumentation, so its outbound HTTP call to this
proxy carries a W3C `traceparent` header (00-<32hex trace_id>-<16hex span_id>-<flags>).
This pre-call hook reads that header and sets the Langfuse trace id to the SAME
32-hex OTel trace id. Result in the shared ClickHouse:

    otel_traces.TraceId  ==  langfuse traces.id      → correlation is an INNER JOIN.

Fallback keys (always set, even without traceparent): raw headers we can join on
by (key, time-bucket) proximity if propagation ever breaks — never let the demo
depend on the hard part.
"""
import re
from litellm.integrations.custom_logger import CustomLogger

TRACEPARENT_RE = re.compile(r'^[0-9a-f]{2}-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$')


class TraceStitcher(CustomLogger):
    async def async_pre_call_hook(self, user_api_key_dict, cache, data: dict, call_type: str):
        headers = {}
        try:
            headers = {k.lower(): v for k, v in
                       (data.get('proxy_server_request') or {}).get('headers', {}).items()}
        except Exception:
            pass

        md = data.setdefault('metadata', {}) or {}

        tp = headers.get('traceparent', '')
        m = TRACEPARENT_RE.match(tp)
        if m:
            otel_trace_id, parent_span_id = m.group(1), m.group(2)
            # langfuse trace id := otel trace id — the join key IS the primary key
            md['trace_id'] = otel_trace_id
            md['otel_trace_id'] = otel_trace_id        # also as metadata (redundant, join-friendly)
            md['otel_parent_span_id'] = parent_span_id
            md['stitch'] = 'traceparent'
        else:
            md['stitch'] = 'fallback'

        # fallback correlation keys — harmless to always record
        for h in ('x-request-id', 'x-librechat-conversation-id', 'user-agent'):
            if headers.get(h):
                md[f'hdr_{h.replace("-", "_")}'] = headers[h]

        data['metadata'] = md
        return data


proxy_handler_instance = TraceStitcher()
