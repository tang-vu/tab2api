# API contract

Local base URL: `http://127.0.0.1:3210`. Protected endpoints require `Authorization: Bearer <tab2api-key>`. Only `/healthz` is unauthenticated; `/readyz` performs browser work and therefore requires a key. Cloudflare Access is recommended for the optional remote hostname, with explicitly selected bearer-only operation also supported for one owner.

## Endpoints

### `GET /healthz`

Process liveness only: `{"status":"ok","service":"tab2api"}`. It does not launch/check ChatGPT.

### `GET /readyz`

Requires a bearer key. Checks browser/UI state. HTTP 200 only for `ready`; otherwise 503 with `session` set to `login_required`, `security_challenge`, `generation_in_progress`, `rate_limited`, `ui_changed`, or `browser_disconnected`.

### `GET /v1/models`

Returns honest capability identifiers: `chatgpt-web`, `chatgpt-web-image`, `chatgpt-web-transcribe`, and `system-tts`. Incoming model strings remain client metadata and do not select a hidden ChatGPT model.

### `POST /v1/chat/completions`

Required: `model`, non-empty `messages`. Supported roles are `system`, `developer`, `user`, and `assistant`. Content is a non-empty string or an array containing text parts and OpenAI-shaped `{ "type":"image_url", "image_url":{"url":"data:image/png;base64,..."} }` parts. PNG, JPEG, and WebP data URLs are supported; remote URLs are rejected to prevent SSRF. Optional accepted fields are `stream` and client metadata `user`.

Non-stream responses use `object: "chat.completion"`, model `chatgpt-web`, and one assistant choice. Usage counts are zero placeholders accompanied by `tab2api.usage_available: false`.

Optional `conversation_id` continues an existing ChatGPT conversation instead of opening a new one. It must match the conversation id format ChatGPT uses; anything else is rejected as `invalid_request` before a browser tab is opened. When the UI exposed a conversation, the response carries it back as `tab2api.conversation_id`.

For `stream: true`, `Content-Type` is `text/event-stream`, `X-Tab2api-Stream-Mode` is `buffered`, role/content/final chunks are emitted, and the stream ends with `data: [DONE]`.

### `POST /v1/responses`

Required: `model` and `input`. Input is a non-empty string or ordered message array. Message content may contain `input_text` and `input_image` data-URL parts. Optional `instructions` becomes a leading developer message. Accepted optional fields are `stream` and client metadata `user`.

Non-stream responses contain one completed assistant `message`/`output_text`; `usage` is `null`. Optional `conversation_id` behaves as it does for Chat Completions, and the resulting conversation is reported as `metadata.tab2api_conversation_id`. Buffered streaming emits sequenced `response.created`, item/content events, one `response.output_text.delta`, and finally `response.completed`; unlike Chat Completions, the typed Responses event stream does not add `[DONE]`.

### Projects

ChatGPT projects hold files and instructions that apply to every conversation inside them. Asking inside a project is the supported way to work against a large codebase: upload the sources once, then ask repeatedly without resending them. tab2api stores nothing locally — the project lives in the ChatGPT account, and the client owns whichever identifiers it chooses to pass back.

Project ids always take the `g-p-<hex>` form and conversation ids the ChatGPT conversation format. Both are interpolated into a chatgpt.com URL, so both are validated against anchored, charset-restricted patterns in the API layer and again in the adapter; a value that does not match is rejected with `invalid_request` and never reaches the browser.

- `POST /v1/projects` with `{ "name": "my codebase" }`: creates a project and returns `{ id, name }`.
- `GET /v1/projects`: reports the projects the projects page currently lists as `{ object: "list", data: [{ id, name }] }`. This reads live browser state rather than a tab2api-owned database, so it includes projects created outside tab2api.
- `DELETE /v1/projects/:projectId`: deletes that project through the UI and returns `{ id, object: "project", deleted: true }`. Deletion is irreversible and applies to whatever id the client supplies, including projects tab2api did not create.
- `POST /v1/projects/:projectId/files`: `multipart/form-data` with one or more file parts. At most 20 files per request, with the combined size capped by `TAB2API_MEDIA_LIMIT_BYTES`. Upload filenames are reduced to a bare, sanitised name before reaching the browser's file chooser. Types outside a small known set are uploaded as `text/plain`, which suits source files. Returns `{ projectId, uploaded }`.
- `POST /v1/projects/:projectId/chat/completions` and `POST /v1/projects/:projectId/responses`: identical bodies and responses to the routes above, but the conversation happens inside the project so its files and instructions apply. Omitting `conversation_id` starts a fresh conversation in the project; supplying one continues that thread.

These routes drive the same public web UI as everything else: they click the controls a person would click. They inherit every limitation documented below, and a ChatGPT UI change can break them.

### `POST /v1/images/generations`

JSON body: `prompt` is required; `model` is metadata; `n` must be `1`, `size` and `quality` must be `auto`, and `response_format` must be `b64_json`. The adapter requests one image through the public UI, waits for the generated image element, hides every other node so nothing else can share the frame, renders that already-loaded element at its intrinsic pixel dimensions, and clips the capture to exactly its box as lossless PNG. The captured frame is rejected unless its dimensions match the element's natural size. The response contains `created` and one `data[].b64_json`; `X-Tab2api-Image-Mode: ui-intrinsic-render` discloses the extraction method. This preserves the pixels exposed by the UI (rather than its smaller chat preview), but it is not the original asset byte-for-byte and may omit source metadata.

### `POST /v1/audio/speech`

JSON body requires `model`, `input`, and `voice`; only `response_format: "wav"` is supported. `speed` accepts 0.5–2. The response is `audio/wav` with `X-Tab2api-Audio-Backend: operating-system`. Speech is generated by Windows System.Speech, macOS `say`, or Linux `espeak`; it does **not** claim to be a ChatGPT/OpenAI voice. `model` and `voice` are compatibility metadata because OS voice catalogs do not map to OpenAI voice names.

```powershell
curl.exe http://127.0.0.1:3210/v1/audio/speech `
  -H "Authorization: Bearer $token" `
  -H "Content-Type: application/json" `
  -d '{"model":"system-tts","input":"Hello","voice":"system","response_format":"wav"}' `
  --output speech.wav
```

### `POST /v1/audio/transcriptions`

Send `multipart/form-data` with one `file` and a non-empty `model`. Optional fields are `language`, `prompt`, and `response_format` (`json` or `text`). Supported MIME types cover WAV, MP3/MPEG, M4A/MP4, WebM, Ogg, FLAC, and AAC. The audio is attached through the public ChatGPT file chooser with an explicit verbatim-transcription instruction. This is UI-mediated transcription, not a claim that the UI selected Whisper or another exact model.

```powershell
curl.exe http://127.0.0.1:3210/v1/audio/transcriptions `
  -H "Authorization: Bearer $token" `
  -F "model=chatgpt-web-transcribe" `
  -F "response_format=json" `
  -F "file=@speech.wav;type=audio/wav"
```

### `POST /admin/session/reset`

Requires the administrator bearer token. Closes the current browser context. The next operation relaunches it. Dedicated profile/login data is deliberately preserved. This endpoint does not delete files. Client keys receive HTTP 401.

### API-key administration

- `GET /admin/api-keys`: list the administrator identity plus active/revoked client-key metadata; no plaintext secret is returned.
- `POST /admin/api-keys` with strict `{ "label": "personal laptop" }`: create a client key and return its plaintext token exactly once.
- `DELETE /admin/api-keys/:id`: revoke a client key immediately.

All require the administrator token. Client keys may call `/v1/*` but no `/admin/*` route.

### Usage administration

- `GET /admin/usage`: per-key and per-endpoint request/success/failure, latency, byte totals, and `estimatedInputTokens`/`estimatedOutputTokens`.
- `DELETE /admin/usage`: reset counters.

`tokenCounts` is always `"estimated"`. The UI provides no real tokenizer/account usage, so these byte-based estimates are unsuitable for billing or quota claims. No prompt or response text is persisted.

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

Codes: `authentication_error` (401), `invalid_request` (400), `cancelled` (499), `queue_full`/`rate_limited` (429), `login_required`/`security_challenge`/`ui_changed`/`browser_disconnected`/`audio_unavailable` (503), and `timeout` (504).

## Request IDs and limits

Each request receives an internal UUID request ID used only in structured logs. Text bodies default to 256 KiB; media is capped by `TAB2API_MEDIA_LIMIT_BYTES` (10 MiB, including at most four images or one audio file). Queue capacity defaults to 16, concurrency to one (configurable from 1–4), text/audio timeout to 120 seconds, and image timeout to 300 seconds. Configuration keys are documented in `.env.example`.
