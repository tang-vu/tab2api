# API contract

Base URL: `http://127.0.0.1:3210`. Protected endpoints require `Authorization: Bearer <local-token>`. `/healthz` and `/readyz` are unauthenticated but loopback-only.

## Endpoints

### `GET /healthz`

Process liveness only: `{"status":"ok","service":"tab2api"}`. It does not launch/check ChatGPT.

### `GET /readyz`

Checks browser/UI state. HTTP 200 only for `ready`; otherwise 503 with `session` set to `login_required`, `security_challenge`, `generation_in_progress`, `rate_limited`, `ui_changed`, or `browser_disconnected`.

### `GET /v1/models`

Returns one honest model record, `chatgpt-web`. The model selected by the ChatGPT UI is not asserted.

### `POST /v1/chat/completions`

Required: `model`, non-empty `messages`. Supported roles are `system`, `developer`, `user`, and `assistant`. Content is a non-empty string or an array of `{ "type": "text", "text": "..." }`. Optional accepted fields are `stream` and client metadata `user`. Sampling/length controls, unknown fields, tools, and multimodal parts return `invalid_request` because the browser UI cannot honor them reliably.

Non-stream responses use `object: "chat.completion"`, model `chatgpt-web`, and one assistant choice. Usage counts are zero placeholders accompanied by `tab2api.usage_available: false`.

For `stream: true`, `Content-Type` is `text/event-stream`, `X-Tab2api-Stream-Mode` is `buffered`, role/content/final chunks are emitted, and the stream ends with `data: [DONE]`.

### `POST /v1/responses`

Required: `model` and `input`. Input is a non-empty string or ordered text message array. Optional `instructions` becomes a leading developer message. Accepted optional fields are `stream` and client metadata `user`. Sampling/length controls and other unsupported inputs are rejected.

Non-stream responses contain one completed assistant `message`/`output_text`; `usage` is `null`. Buffered streaming emits sequenced `response.created`, item/content events, one `response.output_text.delta`, and finally `response.completed`; unlike Chat Completions, the typed Responses event stream does not add `[DONE]`.

### `POST /admin/session/reset`

Closes the current browser context. The next operation relaunches it. Dedicated profile/login data is deliberately preserved. This endpoint does not delete files.

## Errors

Errors are consistent OpenAI-like envelopes:

```json
{
  "error": {
    "message": "Manual ChatGPT login is required.",
    "type": "tab2api_error",
    "code": "login_required",
    "param": null,
    "remediation": "Run `npm run login`."
  }
}
```

Codes: `authentication_error` (401), `invalid_request` (400), `cancelled` (499), `queue_full`/`rate_limited` (429), `login_required`/`security_challenge`/`ui_changed`/`browser_disconnected` (503), and `timeout` (504).

## Request IDs and limits

Each request receives an internal UUID request ID used only in structured logs. Bodies default to 256 KiB, queue capacity to 16 total active/pending jobs, concurrency to one (configurable from 1–4), and timeout to 120 seconds. Configuration keys are documented in `.env.example`.
