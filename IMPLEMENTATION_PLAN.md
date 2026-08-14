# Implementation plan

Living plan; update progress and decisions as implementation proceeds.

## Architecture

An authenticated Fastify server bound only to `127.0.0.1` validates OpenAI-shaped requests, serializes text conversations into an unambiguous prompt envelope, and submits work to a bounded FIFO queue (concurrency 1 by default). A provider interface isolates routes from a ChatGPT UI adapter. The adapter obtains a fresh tab from either a direct Playwright persistent context or one fixed GPM Login profile, classifies UI/session state, submits the prompt through semantic selector candidates, and extracts the new assistant message through a polled completion state machine. Responses are mapped to honest `chatgpt-web` JSON or documented buffered SSE. Runtime metadata is bounded and contains no content.

## Milestones

| Status | Milestone                                 | Acceptance criteria                                                                                                            | Validation                                  |
| ------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| done   | 0. Inspect/research/plan                  | Repository and environment inspected; current official OpenAI, Playwright and Fastify docs reviewed; safety decisions recorded | review this plan and `docs/architecture.md` |
| done   | 1. Foundation/config/security             | Strict toolchain; typed config; loopback/path/token enforcement; redacted logger                                               | `npm run check`; focused tests passed       |
| done   | 2. Core provider/browser/queue            | Provider abstraction, persistent profile, bounded FIFO, cancellation, health and typed errors                                  | queue/browser/state-machine tests passed    |
| done   | 3. API compatibility                      | Required routes, strict schemas, auth, mappings, buffered SSE, consistent errors                                               | API contract and smoke tests passed         |
| done   | 4. ChatGPT UI adapter                     | Centralized semantic selectors, state classifier, extraction state machine, debug opt-in                                       | DOM fixtures and adapter tests passed       |
| done   | 5. CLI/docs/OSS                           | start/login/doctor/reset/smoke; bilingual guides; security/API/troubleshooting; CI/templates/license                           | docs reviewed; CLI smoke passed             |
| done   | 6. Security review/release verification   | Full diff audit, no runtime/secrets, clean install/check/test/build/smoke/audit                                                | acceptance command transcript recorded      |
| done   | 7. Media compatibility                    | Vision/image generation, honest OS TTS, UI-mediated STT; bounded media and contract/live tests                                 | focused tests and live GPM E2E passed       |
| done   | 8. Personal remote access and accounting  | Revocable per-device API keys, content-free usage estimates, explicitly selected bearer-only dedicated Cloudflare tunnel       | focused/full tests and remote contract test |
| done   | 9. Self-contained Windows desktop preview | Tauri shell, app-local Playwright profile, graceful sidecar protocol, staged Node/Chromium resources, unsigned NSIS installer  | Rust/Node checks, package build and smoke   |

## Risks and decisions

- **Volatile UI:** candidate selectors and DOM state rules are centralized; failures become `ui_changed` with opt-in screenshots only.
- **False completion:** require a new assistant node, stable text observations, and either stopped generation or a new completed-turn action; no one-shot sleep.
- **Duplicate generation:** never resubmit after an ambiguous post-submit error; reconnect is limited to pre-submit browser acquisition.
- **Streaming fidelity:** v0.1 returns the completed text in a single content delta/event, then terminates correctly. It is explicitly buffered, not token streaming.
- **DevTools exposure:** direct Playwright uses private transport. GPM mode validates that both its Local API and returned CDP WebSocket are loopback; the unauthenticated GPM-owned port remains a documented residual risk.
- **Unknown token counts/model choice:** OpenAI response usage remains zero/omitted because the UI exposes no authoritative values. The separate admin report labels byte-based input/output counts as estimates; model identifier remains `chatgpt-web`.
- **Profile safety:** custom profile must resolve inside the configured data directory and cannot be a filesystem root or known default browser profile.
- **Headless login:** first login is headed; headless mode is opt-in only after an authenticated profile exists.
- **GPM Login restricted:** after an explicit scope change, support only one configured existing profile through get/start/stop. Do not expose GPM profile creation, listing, rotation, proxy, fingerprint, group, or extension features.
- **Desktop availability:** optional Windows per-user Scheduled Task starts at logon and restarts process failures. It is not a production SLA and still depends on an interactive GPM/login session.
- **Parallelism:** browser concurrency is configurable from 1–4 and defaults to 1. Higher values trade latency under load for memory use, UI race exposure, and account rate limits.
- **Media fidelity:** vision and STT upload through the public file chooser. Generated images are captured from the visible image element rather than fetched from private URLs. TTS uses the OS voice engine and is labelled honestly; unsupported size/quality/audio formats are rejected.
- **Remote access:** the origin stays on loopback and the tunnel remains single-owner. Access is the default/recommended installer path. After explicit operator acceptance, a separate bearer-only command may activate the dedicated tunnel; `/readyz`, all `/v1/*`, and all `/admin/*` remain authenticated while only cheap `/healthz` is public.
- **Usage privacy:** API-key files store SHA-256 digests, not generated plaintext keys. Usage persistence contains labels, endpoint names, counters, latency, byte totals, and explicitly estimated token totals; never content.
- **Desktop engine:** Tauri renders only a local CSP-restricted control UI. ChatGPT remains in Playwright-managed Chromium; this avoids platform-dependent system-WebView automation and preserves the tested adapter.
- **Desktop process boundary:** Rust forces loopback, Playwright, and app-local data/profile paths. It sends a bounded JSONL shutdown command over a private child stdin pipe, waits eight seconds, and only then uses a kill fallback.
- **Desktop distribution:** the Windows preview stages the current Node runtime, production-only npm dependencies, and the one headed Chromium revision matched to Playwright. Generated binaries are ignored and unsigned; signing and clean-VM install/uninstall validation remain release gates.

## Research record (official sources, reviewed 2026-08-14)

- OpenAI Chat Completions resource and stream chunk schema: https://developers.openai.com/api/reference/resources/chat
- OpenAI Responses streaming event lifecycle: https://developers.openai.com/api/docs/guides/streaming-responses
- OpenAI image generation model/endpoints: https://developers.openai.com/api/docs/models/gpt-image-2
- OpenAI audio speech endpoint: https://developers.openai.com/api/docs/models/tts-1
- OpenAI image-input model guidance: https://developers.openai.com/api/docs/models
- Playwright persistent context/default-profile warning: https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context
- Playwright locator guidance: https://playwright.dev/docs/locators
- Fastify server/body limit/listen/shutdown: https://fastify.dev/docs/latest/Reference/Server/
- Fastify validation: https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/
- Cloudflare published applications and Access requirement: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/
- Cloudflare Service Auth tokens: https://developers.cloudflare.com/cloudflare-one/access-controls/authenticate-agents/

## Final validation record

Completed on Windows/PowerShell with Node v24.14.1 and npm 11.11.0:

- `npm ci`: clean dependency install passed.
- `npm run check`: strict TypeScript, ESLint, and Prettier checks passed.
- `npm test`: 14 files / 75 offline tests passed; no ChatGPT request was made.
- `npm run build`: production ESM build passed.
- `npm run smoke`: authenticated fake-provider Chat Completions path passed.
- `npm run test:manual` without opt-in: one manual E2E test skipped as designed.
- Opt-in manual E2E against one already authenticated GPM profile: passed; the profile identifier and content were not persisted.
- Production-build loopback HTTP verification against that profile: health/readiness, bearer rejection, models, Chat Completions JSON/SSE, Responses JSON/SSE, FIFO concurrency, and session reset all passed. Response bodies and prompts were not printed.
- Live two-tab GPM verification with concurrency 2: both simultaneous Responses requests returned HTTP 200 with valid contracts.
- Windows per-user autostart: installed task reached health/readiness/models HTTP 200; a forced termination of the exact tab2api Node PID recovered to a new PID through the bounded watchdog. GPM Login autostart was detected separately in the user's Startup folder.
- Live media verification: vision data-URL upload returned text; OS TTS returned a valid RIFF/WAV; that WAV transcribed through multipart/UI; image generation returned a valid PNG `b64_json`. After the intrinsic-render fix, a fresh live Images API request returned HTTP 200 with a 1254x1254 PNG instead of the 480x480 chat preview. Only status and structural metadata were printed, and runtime media remained ignored.
- API-key/usage verification: digest-only persistence tests and admin/client contract tests passed. A live local create/use/admin-deny/report/revoke sequence returned the expected 200/401 statuses and rejected the revoked key; no ChatGPT prompt was submitted.
- Cloudflare: a dedicated `tab2api` tunnel and DNS route for `tab2api.tangvu.dev` were created while offline. A fixed-418 origin probe proved Cloudflare Access is not configured. The owner then explicitly selected the separately documented bearer-only activation path and remote contract verification was performed.
- Bearer-only remote verification: the Windows tunnel task reached Running. Through `https://tab2api.tangvu.dev`, cheap health returned 200; readiness/models without a key returned 401; a temporary client key reached models but not admin usage; the administrator reached usage; and revocation immediately changed that client key to 401. No ChatGPT prompt was submitted.
- Desktop verification: Node lifecycle tests exercised startup failure, bounded parent commands, real loopback server startup, and graceful shutdown. Rust formatting, Clippy with warnings denied, four lifecycle/security tests, and release compilation passed. The Windows resource stage contained no headless-only Chromium shell; an unsigned 167 MiB NSIS installer was built, and its packaged sidecar passed listening/health/graceful-shutdown smoke without opening ChatGPT.
- `npm audit --audit-level=high`: zero vulnerabilities.
- `git diff --check`, ignored-file review, sensitive-term review, and package dry-run completed.
