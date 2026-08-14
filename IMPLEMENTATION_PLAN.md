# Implementation plan

Living plan; update progress and decisions as implementation proceeds.

## Architecture

An authenticated Fastify server bound only to `127.0.0.1` validates OpenAI-shaped requests, serializes text conversations into an unambiguous prompt envelope, and submits work to a bounded FIFO queue (concurrency 1 by default). A provider interface isolates routes from a ChatGPT UI adapter. The adapter obtains a fresh tab from either a direct Playwright persistent context or one fixed GPM Login profile, classifies UI/session state, submits the prompt through semantic selector candidates, and extracts the new assistant message through a polled completion state machine. Responses are mapped to honest `chatgpt-web` JSON or documented buffered SSE. Runtime metadata is bounded and contains no content.

## Milestones

| Status | Milestone                               | Acceptance criteria                                                                                                            | Validation                                  |
| ------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| done   | 0. Inspect/research/plan                | Repository and environment inspected; current official OpenAI, Playwright and Fastify docs reviewed; safety decisions recorded | review this plan and `docs/architecture.md` |
| done   | 1. Foundation/config/security           | Strict toolchain; typed config; loopback/path/token enforcement; redacted logger                                               | `npm run check`; focused tests passed       |
| done   | 2. Core provider/browser/queue          | Provider abstraction, persistent profile, bounded FIFO, cancellation, health and typed errors                                  | queue/browser/state-machine tests passed    |
| done   | 3. API compatibility                    | Required routes, strict schemas, auth, mappings, buffered SSE, consistent errors                                               | API contract and smoke tests passed         |
| done   | 4. ChatGPT UI adapter                   | Centralized semantic selectors, state classifier, extraction state machine, debug opt-in                                       | DOM fixtures and adapter tests passed       |
| done   | 5. CLI/docs/OSS                         | start/login/doctor/reset/smoke; bilingual guides; security/API/troubleshooting; CI/templates/license                           | docs reviewed; CLI smoke passed             |
| done   | 6. Security review/release verification | Full diff audit, no runtime/secrets, clean install/check/test/build/smoke/audit                                                | acceptance command transcript recorded      |

## Risks and decisions

- **Volatile UI:** candidate selectors and DOM state rules are centralized; failures become `ui_changed` with opt-in screenshots only.
- **False completion:** require a new assistant node plus stopped generation and stable text observations; no one-shot sleep.
- **Duplicate generation:** never resubmit after an ambiguous post-submit error; reconnect is limited to pre-submit browser acquisition.
- **Streaming fidelity:** v0.1 returns the completed text in a single content delta/event, then terminates correctly. It is explicitly buffered, not token streaming.
- **DevTools exposure:** direct Playwright uses private transport. GPM mode validates that both its Local API and returned CDP WebSocket are loopback; the unauthenticated GPM-owned port remains a documented residual risk.
- **Unknown token counts/model choice:** usage fields are zero/omitted as contract permits and docs disclose that they mean unavailable; model identifier remains `chatgpt-web`.
- **Profile safety:** custom profile must resolve inside the configured data directory and cannot be a filesystem root or known default browser profile.
- **Headless login:** first login is headed; headless mode is opt-in only after an authenticated profile exists.
- **GPM Login restricted:** after an explicit scope change, support only one configured existing profile through get/start/stop. Do not expose GPM profile creation, listing, rotation, proxy, fingerprint, group, or extension features.

## Research record (official sources, reviewed 2026-08-14)

- OpenAI Chat Completions resource and stream chunk schema: https://developers.openai.com/api/reference/resources/chat
- OpenAI Responses streaming event lifecycle: https://developers.openai.com/api/docs/guides/streaming-responses
- Playwright persistent context/default-profile warning: https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context
- Playwright locator guidance: https://playwright.dev/docs/locators
- Fastify server/body limit/listen/shutdown: https://fastify.dev/docs/latest/Reference/Server/
- Fastify validation: https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/

## Final validation record

Completed on Windows/PowerShell with Node v24.14.1 and npm 11.11.0:

- `npm ci`: clean dependency install passed.
- `npm run check`: strict TypeScript, ESLint, and Prettier checks passed.
- `npm test`: 11 files / 50 offline tests passed; no ChatGPT request was made.
- `npm run build`: production ESM build passed.
- `npm run smoke`: authenticated fake-provider Chat Completions path passed.
- `npm run test:manual` without opt-in: one manual E2E test skipped as designed.
- `npm audit --audit-level=high`: zero vulnerabilities.
- `git diff --check`, ignored-file review, sensitive-term review, and package dry-run completed.
