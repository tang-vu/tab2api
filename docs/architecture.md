# Architecture

## Scope and principles

tab2api is a single-user desktop bridge, not a shared API service. It automates only the public ChatGPT.com UI after the user logs in manually, using a dedicated Playwright persistent context or the desktop shell's app-managed Chromium profile. Its origin remains loopback; optional personal remote access uses a dedicated tunnel with Access recommended and bearer-only activation requiring an explicit operator flag. It never asks for credentials, reads/exports browser storage, calls private endpoints, bypasses controls, or selects/rotates accounts.

## Components

- `api/`: Fastify routes, strict Zod/multipart parsing, transcript/media serialization, JSON/SSE/binary mapping, authentication integration.
- `audio/`: local operating-system WAV synthesis with restrictive temporary files and cleanup.
- `browser/`: one persistent Chromium context and fresh request tabs. Closing the context closes the browser.
- `adapters/chatgpt/`: all URL/UI assumptions, selector candidates, state classification, visible-text extraction, and completion state machine.
- `queue/`: bounded FIFO scheduler with configurable browser concurrency from one through four.
- `config/`: environment parsing and runtime token loading/creation.
- `security/`: loopback, safe path, bearer parsing, and digest-only per-device API-key registry.
- `observability/`: Pino configuration with allowlisted request serialization and redaction.
- `store/`: bounded response metadata plus content-free usage counters. No transcript persistence.
- `cli/`: start, login, doctor, reset-session, and offline smoke commands.

`WebChatProvider` is the only abstraction needed for a future UI provider. Routes depend on it and contain no selectors or Playwright imports. A second provider is deliberately not implemented.

## Request lifecycle

1. Fastify accepts at most the configured body size and authenticates protected routes.
2. Strict schemas reject unknown fields; media parsers enforce MIME, data-URL, count, and byte limits and reject remote image URLs.
3. The serializer converts messages to an ordered, role-labelled XML-like envelope and entity-escapes boundary characters.
4. The bounded FIFO admits or rejects work. Configurable concurrency is constrained to 1–4 browser tabs and defaults to 1; a request timeout/abort signal applies while queued and running.
5. The adapter opens a new page, navigates to the public ChatGPT root (a new conversation), classifies state, records the assistant-message baseline, fills the visible composer, and submits once.
6. A state machine waits for a new assistant node and stable visible text. Completion additionally requires either the generation control to disappear or a new completed-turn action to appear; this handles UI variants that leave a stale Stop control visible. A turn still carrying a working marker is never complete, because ChatGPT renders the completed-turn action before the answer exists and shows a stable status line in the meantime. No fixed one-shot sleep decides completion.
7. Text is mapped to `chatgpt-web`; generated image elements are temporarily rendered at their intrinsic dimensions and captured as bounded lossless PNG without reading or fetching their private URL, while STT uses a bounded audio attachment. The page closes in `finally` for success, error, timeout, and cancellation. TTS is a separate, labelled OS backend but still enters the bounded work queue for flood control.

## Decisions

### Required stack

Node.js 22+, strict TypeScript, Fastify, Playwright, Zod, Pino, Vitest, ESLint, Prettier, and npm are retained. Zod is used at the API/config boundary because it provides a small, explicit strict parser and inferred types; Fastify still enforces the byte limit and secure JSON parsing before Zod. `linkedom` is test-only so DOM fixtures do not require a browser or network in CI.

### Browser lifecycle and DevTools

The CLI uses Playwright `launchPersistentContext` with a profile inside `TAB2API_DATA_DIR`. Configuration rejects roots, traversal outside that directory, and paths resembling default Chrome/Chromium/Edge user-data directories. No TCP debugging port is created in this mode.

For the packaged desktop application only, `TAB2API_BROWSER_CDP_ENDPOINT` lets the Rust shell own the bundled Chromium process and its dedicated profile while the Node sidecar attaches with Playwright `connectOverCDP`. The endpoint parser accepts only an explicit `http://127.0.0.1:<port>` or `http://[::1]:<port>` origin with no credentials, path, query, or fragment; `localhost`, LAN addresses, public addresses, and privileged ports are refused. The adapter never reads browser storage and creates a fresh page for every request, leaving the shell's existing login page untouched. It closes every request page on success, cancellation, timeout, or error. Sidecar shutdown closes those owned pages and disconnects Playwright; the Rust shell remains responsible for terminating Chromium and preserving the app-managed profile. The ordinary CLI continues to use `launchPersistentContext` when this variable is absent.

On Windows, an optional per-user Scheduled Task starts the production build at interactive logon and restarts a failed process. It intentionally does not run as SYSTEM because manual browser challenges require the user's desktop session. This improves desktop availability but is not a production high-availability design.

### Failure and retry

Browser acquisition may relaunch once only before a request obtains a tab. After prompt submission, errors are never retried automatically because the generation may exist and resubmission could duplicate side effects. Challenges and rate limits become structured errors with manual remediation.

### Streaming and usage

Visible UI text can change non-monotonically while ChatGPT formats an answer. Version 0.1 therefore uses a documented buffered SSE fallback rather than claiming reliable token streaming. It emits compatible event/chunk shapes only after completion and ends with `[DONE]`. Token counts and exact UI-selected model are not observable. Chat usage zeros are explicitly annotated unavailable; Responses usage is `null`.

An independent administrative usage store aggregates requests by key and route. Input/output estimates use UTF-8 byte length divided by four and are explicitly named `estimatedInputTokens`/`estimatedOutputTokens`; they are operational trends, not billing data. Persistence is serialized and contains no prompt or response text.

### Optional personal tunnel

Fastify continues to listen only on loopback. The default `cloudflared` installer uses a fail-closed fixed-418 probe to prove Access interception. A distinct bearer-only command records the owner's explicit acceptance and skips that probe without weakening application authentication. In bearer-only mode `/readyz`, `/v1/*`, and `/admin/*` require a key; `/healthz` alone is public and does no browser work. Tunnel credentials/configuration remain runtime-only and are never packaged or committed.

### Desktop distribution

The optional Tauri 2 shell is a native lifecycle controller, not a second implementation of the API or ChatGPT adapter. Its operating-system WebView renders bundled local controls under a CSP that denies network connections. Rust exposes only typed start, stop, status, and manual-login commands and never returns the administrator key, child output, browser state, prompts, or responses to the frontend.

Development mode starts the repository-built Node entrypoints. A Windows packaging step instead stages the current Node executable, production-only npm tree, compiled `dist/`, and Playwright-matched headed Chromium under generated Tauri resources. Rust resolves only those resources in a packaged app, forces `127.0.0.1` and per-user app-local runtime/profile paths, and supplies an ephemeral loopback CDP origin only to the sidecar. Service shutdown uses a versioned, size-bounded JSONL protocol on child stdin; forced termination is an eight-second fallback.

The shell allocates an ephemeral loopback DevTools port and passes its exact HTTP origin to the sidecar. It must never use `--remote-debugging-address=0.0.0.0`, expose the port through Cloudflare Tunnel, or place the endpoint in logs/UI. CDP has no tab2api bearer authentication; a malicious same-user process may still connect while the browser runs, so the port lifetime is scoped to the desktop session and Chromium is stopped when the shell exits.

### Media fidelity

Vision and transcription use Playwright's public file chooser with in-memory buffers; no ChatGPT upload endpoint is called directly. Image generation waits for a new semantic image element, isolates it from UI overlays, renders it at intrinsic dimensions, and captures only those pixels without extracting private asset URLs. Only `auto` size/quality are accepted. Read-aloud audio cannot be extracted safely from the UI without relying on internal transport, so `/v1/audio/speech` deliberately uses the local OS engine and returns a disclosure header.

### Debug data

No prompt, response, DOM, trace, HAR, cookie, or storage state is persisted. With `TAB2API_DEBUG=true`, only a local screenshot is attempted for `ui_changed`, under a gitignored runtime directory. Screenshots can contain conversation text and must be treated as sensitive.

## Research basis

Reviewed 2026-08-14: [OpenAI Chat resource](https://developers.openai.com/api/reference/resources/chat), [OpenAI streaming responses](https://developers.openai.com/api/docs/guides/streaming-responses), [OpenAI GPT Image 2](https://developers.openai.com/api/docs/models/gpt-image-2), [OpenAI TTS-1](https://developers.openai.com/api/docs/models/tts-1), [OpenAI model modality guidance](https://developers.openai.com/api/docs/models), [Playwright persistent contexts](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context), [Playwright locators](https://playwright.dev/docs/locators), [Fastify server](https://fastify.dev/docs/latest/Reference/Server/), [Fastify validation](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/), [Cloudflare published applications](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/), and [Cloudflare Service Auth](https://developers.cloudflare.com/cloudflare-one/access-controls/authenticate-agents/).
