# Browser providers

The default remains `chatgpt-web`: one owner, one dedicated manually authenticated browser
profile, loopback-only API/DevTools, no private service endpoints or credential extraction.
This update does not silently replace browser use with a paid API gateway.

## Implemented surface

| Provider ID   | Status                                                                 | Capabilities                                                                      |
| ------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `chatgpt-web` | Existing adapter; unchanged default                                    | Existing chat, media, projects, conversations, temporary chat and effort controls |
| `claude-web`  | Experimental, disabled by default; actual provider permission required | New text turns only; synthetic offline tests, **not live-selector verified**      |
| `grok-web`    | Experimental, disabled by default; actual provider permission required | New text turns only; synthetic offline tests, **not live-selector verified**      |
| `meta-ai-web` | Catalog only, not selectable or implemented                            | No browser capabilities advertised                                                |

Meta AI's Muse Spark model family and the separate Muse personal-agent application are not
interchangeable endpoints. `meta-ai-web` refers only to Meta AI at `meta.ai`; no ambiguous `muse`
alias is accepted. Meta publishes a separate [Model API](https://dev.meta.ai/docs/overview).
That is an independent integration path, not evidence of browser automation permission.

`GET /v1/providers` requires the local API key and returns the selected provider, implementation
status, public documentation links and capabilities without opening a browser. `GET /v1/models`
only advertises the selected provider's working API surface, plus local OS speech. Provider IDs
identify the transport, not the underlying model selected in the account UI.

Only one provider is selected per runtime. There is no model/account rotation or automatic
fallback to another provider. Run separate loopback ports and dedicated data/profile directories
if you have independently authorized use of more than one service. New providers require their
exact model ID, or `claude-tab2api-<provider-id>` for Anthropic compatibility. Legacy arbitrary
ChatGPT aliases remain accepted, but reserved provider IDs cannot silently route to ChatGPT.

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

## Primary references checked October 24, 2026

- [Claude consumer terms](https://www.anthropic.com/legal/consumer-terms)
- [Grok acceptable use policy](https://x.ai/legal/acceptable-use-policy)
- [Grok consumer terms](https://x.ai/legal/terms-of-service)
- [Meta Muse Spark and Model API announcement](https://ai.meta.com/blog/introducing-muse-spark-meta-model-api/)
- [Meta Model API documentation](https://dev.meta.ai/docs/overview)
