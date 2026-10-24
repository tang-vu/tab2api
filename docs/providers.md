# Providers and explicit transports

The default remains `chatgpt-web`: one owner, one dedicated manually authenticated browser
profile, loopback-only API/DevTools, no private service endpoints or credential extraction.
This update does not silently replace browser use with a paid API gateway.

## Implemented surface

| Provider ID   | Status                                                                             | Capabilities                                                                      |
| ------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `chatgpt-web` | Existing adapter; unchanged default                                                | Existing chat, media, projects, conversations, temporary chat and effort controls |
| `claude-web`  | Experimental, disabled by default; actual provider permission required             | New text turns only; synthetic offline tests, **not live-selector verified**      |
| `grok-web`    | Experimental, disabled by default; actual provider permission required             | New text turns only; synthetic offline tests, **not live-selector verified**      |
| `claude-api`  | Official API, implemented and mock-tested; live-unverified                         | Text-only, explicit key/model and paid-API opt-in                                 |
| `grok-api`    | Official legacy Chat Completions API, implemented and mock-tested; live-unverified | Text-only, explicit key/model and paid-API opt-in                                 |
| `meta-api`    | Official Meta Model API / Muse Spark, implemented and mock-tested; live-unverified | Text-only, explicit key/model and paid-API opt-in                                 |
| `meta-ai-web` | Catalog only, not selectable or implemented                                        | No browser capabilities advertised                                                |

Meta AI's Muse Spark model family and the separate Muse personal-agent application are not
interchangeable endpoints. `meta-ai-web` refers only to Meta AI at `meta.ai`; no ambiguous `muse`
alias is accepted. Meta publishes a separate [Model API](https://dev.meta.ai/docs/overview).
That is an independent integration path, not evidence of browser automation permission.

`GET /v1/providers` requires the local API key and returns the selected provider, implementation
status, public documentation links and capabilities without opening a browser. `GET /v1/models`
only advertises the selected provider's implemented API surface, plus local OS speech. Provider IDs
identify the transport, not the underlying model selected in the account UI.

Only one provider is selected per runtime. There is no model/account rotation or automatic
fallback to another provider. Run separate loopback ports and dedicated data/profile directories
if you have independently authorized use of more than one service. New providers require their
exact model ID, or `claude-tab2api-<provider-id>` for Anthropic compatibility. Legacy arbitrary
ChatGPT aliases remain accepted, but reserved provider IDs and Claude/Grok/Muse/Meta model-name
prefixes cannot silently route to ChatGPT.

## Authorization comes before enabling an experimental adapter

[Anthropic Consumer Terms §3.7](https://www.anthropic.com/legal/consumer-terms) restrict automated
consumer-service access except API-key access or explicit Anthropic permission. The
[Grok AUP](https://x.ai/legal/acceptable-use-policy) restricts unauthorized automated access.
A paid consumer subscription and a successful manual login do **not** by themselves establish
permission for these adapters. These are unofficial implementations, not provider endorsements.

Do not enable an adapter unless you have actual applicable permission from that provider.
The following configuration is an operator attestation, not a permission grant and not a way
to override terms. There is no challenge bypass, scraping of private endpoints, cookie/session
export, subscription impersonation or rate-limit workaround.

After independently establishing permission, a CLI-only instance can be selected explicitly:

```dotenv
TAB2API_PROVIDER=claude-web
TAB2API_EXPERIMENTAL_PROVIDERS=true
TAB2API_PROVIDER_PERMISSION=claude-web
TAB2API_DATA_DIR=.tab2api-claude
TAB2API_PROFILE_DIR=.tab2api-claude/browser-profile
TAB2API_PORT=3211
TAB2API_TEMPORARY_CHAT=false
```

For Grok, use `grok-web` consistently and a different dedicated directory/port. A permission
attestation for Claude never unlocks Grok. Run `npm run login` and complete the login yourself;
then `npm start`. The packaged desktop login shell still supports ChatGPT only and rejects other
provider selections instead of opening the wrong service.

```sh
curl http://127.0.0.1:3211/v1/chat/completions \
  -H "Authorization: Bearer $TAB2API_CLIENT_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"claude-web","messages":[{"role":"user","content":"Hello"}]}'
```

## Reliability and limitations

- New adapters accept text only. Attachments, image generation, transcription, projects,
  conversation continuation, temporary chat and effort selection fail explicitly before a tab
  opens. They are not silently ignored and do not fall back to ChatGPT.
- UI candidates are centralized and volatile. Synthetic DOM fixtures test the contract, not
  current production selectors. Missing or ambiguous UI elements fail closed as `ui_changed`.
- Only the configured public origin is permitted before filling/submitting. Login/security
  challenges/rate limits require manual remediation. No automatic retries after submission.
- Deadlines and cancellation close owned request tabs; new completion must be distinct from
  the baseline and positively ended. A failed submission gesture returns `submission_uncertain`
  rather than trying Enter/click again and potentially duplicating a prompt.
- Streaming remains buffered, not token streaming. OpenAI response/chunk models and Anthropic
  compatibility IDs name the actual selected provider. Anthropic streams keep existing
  keepalive and typed-error behavior; a failed turn never emits successful completion.
- Usage is not provider billing data. The local o200k prompt-budget estimate is **not** Claude's
  or Grok's native tokenizer, observed context size or authoritative token usage. ChatGPT-only
  platform reserves are not applied to other providers.
- No live provider account, provider credentials, paid API calls or authenticated production DOM
  was used to validate this implementation. A selected adapter's health probe is not a blanket
  guarantee that generation works across account tiers, locales or UI changes.

## Explicit official API mode

The optional `claude-api`, `grok-api` and `meta-api` transports are independently implemented,
not fallbacks. `TAB2API_PROVIDER=chatgpt-web` never uses an API key or creates API charges.
Only the key matching the selected API provider is used; keys for another provider are ignored.
No key is generated, obtained from your browser, printed, or validated by a startup request.

Choose an API mode yourself, obtain the applicable account access and key, and set it locally:

```dotenv
TAB2API_PROVIDER=meta-api
TAB2API_ENABLE_PAID_API=true
TAB2API_META_API_KEY=your-own-key
TAB2API_API_MODEL=exact-model-id-from-your-provider-console
TAB2API_API_MAX_OUTPUT_TOKENS=4096
TAB2API_CONCURRENCY=1
TAB2API_TEMPORARY_CHAT=false
```

For Claude, select `claude-api` with `TAB2API_CLAUDE_API_KEY`; use a **workspace-scoped key**.
Unscoped-key workspace selection is not implemented. For Grok, select `grok-api` with
`TAB2API_GROK_API_KEY`. Never commit these keys or paste them into issue reports.
`npm run login` deliberately refuses API mode because there is no browser login to perform.
The packaged desktop remains ChatGPT-only; optional transports currently use the CLI/server.

Generation may incur charges according to your provider account. The output-token bound defaults
to 4096 and can be set from 1 to 16384; it is **not a monetary spending cap**. Configure provider-side
budgets yourself. The service does not retry failed, rate-limited, cancelled or timed-out calls.
Cancellation aborts local I/O but cannot prove that provider processing or billing stopped.

Fixed official HTTPS destinations are used, with redirects rejected:

- Claude: `https://api.anthropic.com/v1/messages`, version `2026-10-21`.
- Grok: `https://api.x.ai/v1/chat/completions`. This is the documented legacy Chat Completions
  surface, not a claim of support for xAI Responses-only capabilities.
- Meta: `https://api.meta.ai/v1/chat/completions`, documented Meta Model API / Muse Spark access.

Supply an **exact model ID**, not an alias that resolves to a different returned identity. A response
from a different model, incomplete output, tool call or unsupported non-text block is rejected
without returning a misleading partial answer. Responses are bounded to 2 MiB / 4096 chunks;
request deadlines include both headers and every response-body read. JSON parsing and all errors
are sanitized so keys, headers, prompts and provider response bodies are never included in errors.

The current implementation sends the existing serialized transcript as one user message. It does
not claim provider-native system-message, media, tools, citation, effort or token-usage fidelity.
The Anthropic compatibility route can still parse caller-declared textual tool envelopes; tab2api
never executes tools. Streaming stays explicitly buffered, and usage stays labelled unavailable
rather than presenting local estimates as provider billing data.

`health()` and `/admin/session` report `api_configured` without network activity. `/readyz` therefore
returns `503 not_ready` until a verified readiness mechanism is implemented; configuration alone
is not successful authentication or model access. `/healthz` continues to report local process
liveness, and normal generation routes can be used when the operator explicitly chooses to make
a potentially billable request. `doctor` reports configuration-only API status and sends no probe.

All API tests use synthetic mocked responses. No real API credentials, requests or account access
were used for verification; provider model availability and account permissions remain live-unverified.

## Primary references checked October 24, 2026

- [Claude consumer terms](https://www.anthropic.com/legal/consumer-terms)
- [Grok acceptable use policy](https://x.ai/legal/acceptable-use-policy)
- [Grok consumer terms](https://x.ai/legal/terms-of-service)
- [Meta Muse Spark and Model API announcement](https://ai.meta.com/blog/introducing-muse-spark-meta-model-api/)
- [Meta Model API documentation](https://dev.meta.ai/docs/overview)

- [Claude Messages API](https://platform.claude.com/docs/en/api/messages/create)
- [Claude authentication](https://platform.claude.com/docs/en/api/overview)
- [Claude API versioning](https://platform.claude.com/docs/en/api/versioning)
- [Grok legacy Chat Completions](https://docs.x.ai/developers/model-capabilities/legacy/chat-completions)
- [Meta Chat Completions protocol](https://dev.meta.ai/docs/protocols/chat-completions)
