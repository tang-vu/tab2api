# Architecture

## Scope and principles

tab2api is a single-user desktop bridge, not an API service for deployment. It automates only the public ChatGPT.com UI after the user logs in manually, using either a dedicated Playwright persistent context or one explicitly configured GPM Login profile. It never asks for credentials, reads/exports browser storage, calls private endpoints, bypasses controls, or selects/rotates accounts.

## Components

- `api/`: Fastify routes, strict Zod schemas, transcript serialization, JSON/SSE mapping, authentication integration.
- `browser/`: one persistent Chromium context and fresh request tabs. Closing the context closes the browser.
- `adapters/chatgpt/`: all URL/UI assumptions, selector candidates, state classification, visible-text extraction, and completion state machine.
- `queue/`: bounded FIFO scheduler. Default and currently fixed execution concurrency is one.
- `config/`: environment parsing and runtime token loading/creation.
- `security/`: loopback, safe path, bearer parsing, and timing-safe digest comparison.
- `observability/`: Pino configuration with allowlisted request serialization and redaction.
- `store/`: bounded, content-free response metadata. No transcript persistence.
- `cli/`: start, login, doctor, reset-session, and offline smoke commands.

`WebChatProvider` is the only abstraction needed for a future UI provider. Routes depend on it and contain no selectors or Playwright imports. A second provider is deliberately not implemented.

## Request lifecycle

1. Fastify accepts at most the configured body size and authenticates protected routes.
2. Zod strict schemas reject unknown/unsupported fields and non-text content.
3. The serializer converts messages to an ordered, role-labelled XML-like envelope and entity-escapes boundary characters.
4. The bounded FIFO admits or rejects work. A request timeout/abort signal applies while queued and running.
5. The adapter opens a new page, navigates to the public ChatGPT root (a new conversation), classifies state, records the assistant-message baseline, fills the visible composer, and submits once.
6. A state machine waits for a new assistant node and stable visible text. Completion additionally requires either the generation control to disappear or a new completed-turn action to appear; this handles UI variants that leave a stale Stop control visible. No fixed one-shot sleep decides completion.
7. The result is mapped to the truthful `chatgpt-web` model. The page closes in `finally` for success, error, timeout, and cancellation.

## Decisions

### Required stack

Node.js 22+, strict TypeScript, Fastify, Playwright, Zod, Pino, Vitest, ESLint, Prettier, and npm are retained. Zod is used at the API/config boundary because it provides a small, explicit strict parser and inferred types; Fastify still enforces the byte limit and secure JSON parsing before Zod. `linkedom` is test-only so DOM fixtures do not require a browser or network in CI.

### Browser backends and DevTools

The `playwright` backend uses `launchPersistentContext` with a profile inside `TAB2API_DATA_DIR`. Configuration rejects roots, traversal outside that directory, and paths resembling default Chrome/Chromium/Edge user-data directories. No TCP debugging port is created for this backend.

The `gpm` backend calls only `GET profiles/{id}`, `GET profiles/start/{id}`, and `GET profiles/stop/{id}` for one UUID supplied by `TAB2API_GPM_PROFILE_ID`. It never lists, creates, updates, deletes, or rotates profiles and never calls proxy/fingerprint/group/extension endpoints. The GPM Local API base URL must be loopback. Playwright attaches only if the returned DevTools WebSocket is also `ws://` loopback; LAN/public endpoints are refused. GPM's Local API and debugging port have no tab2api-controlled authentication, so using this backend increases risk from malicious same-user processes and is opt-in.

GPM support was added after an explicit scope change on 2026-08-14. The restriction to one existing profile and three endpoints is intentional; tab2api does not claim that GPM's broader fingerprint/proxy features are safe or necessary. API shapes follow the [GPM Login Local API documentation](https://api-docs.gpmloginapp.com/).

### Failure and retry

Browser acquisition may relaunch once only before a request obtains a tab. After prompt submission, errors are never retried automatically because the generation may exist and resubmission could duplicate side effects. Challenges and rate limits become structured errors with manual remediation.

### Streaming and usage

Visible UI text can change non-monotonically while ChatGPT formats an answer. Version 0.1 therefore uses a documented buffered SSE fallback rather than claiming reliable token streaming. It emits compatible event/chunk shapes only after completion and ends with `[DONE]`. Token counts and exact UI-selected model are not observable. Chat usage zeros are explicitly annotated unavailable; Responses usage is `null`.

### Debug data

No prompt, response, DOM, trace, HAR, cookie, or storage state is persisted. With `TAB2API_DEBUG=true`, only a local screenshot is attempted for `ui_changed`, under a gitignored runtime directory. Screenshots can contain conversation text and must be treated as sensitive.

## Research basis

Reviewed 2026-08-14: [OpenAI Chat resource](https://developers.openai.com/api/reference/resources/chat), [OpenAI streaming responses](https://developers.openai.com/api/docs/guides/streaming-responses), [Playwright persistent contexts](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context), [Playwright locators](https://playwright.dev/docs/locators), [Fastify server](https://fastify.dev/docs/latest/Reference/Server/), [Fastify validation](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/), and [GPM Login Local API](https://api-docs.gpmloginapp.com/).
