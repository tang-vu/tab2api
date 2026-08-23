# Changelog

All notable user-facing changes are documented here. This project follows semantic versioning while it remains in the `0.x` preview phase.

## [Unreleased]

### Added

- A manual, artifact-free Windows clean-install workflow that builds the unsigned NSIS preview,
  installs it silently in an isolated runner directory, verifies the installed sidecar offline,
  uninstalls it, and proves app-local profile data is retained by default.
- Windows desktop staging now emits a CycloneDX SBOM for bundled production npm dependencies and a
  SHA-256/size inventory covering every sidecar resource, and clears stale Tauri resource copies
  before packaging. The packaged smoke verifies that inventory before executing anything, runs the
  compiled fake-adapter authenticated request with remote proxies forced closed, then checks loopback
  health and graceful sidecar shutdown.
- A desktop ChatGPT session check that clearly separates loopback process health from authenticated
  UI readiness, reports every typed `/readyz` state with localized guidance, and stays bounded to 45
  seconds without exposing the administrator key to the WebView.
- A localized in-app API Docs tab covering authentication, examples, core routes, projects, media,
  administrator routes, and current limitations.
- In-app API-key and content-free usage management, including one-time client-key display,
  revocation/reset confirmations, and a canonical Markdown API-document export to Downloads.
- ChatGPT project routes so a large codebase is uploaded once instead of resent with every request: `POST/GET /v1/projects`, `DELETE /v1/projects/:projectId`, `POST /v1/projects/:projectId/files`, and project-scoped Chat Completions and Responses.
- Optional `conversation_id` on Chat Completions and Responses, returned as `tab2api.conversation_id` and `metadata.tab2api_conversation_id`, so a client can continue a thread instead of always starting a new conversation.

### Fixed

- Keep Windows-only tunnel process imports and activation arguments behind the Windows compile gate,
  so desktop Clippy remains warning-free on Linux and macOS CI.
- Make sidecar process tests tolerate normal TypeScript-loader startup variance while retaining a
  strict bounded hang detector, avoiding false failures when the full suite runs concurrently.
- Hide docked Chromium while API Docs is selected, then restore and resize it when returning to the
  Browser tab, so the native child window cannot cover in-app documentation.
- Upgrade the supported lint/test toolchain to ESLint 10, `globals` 17, and Vitest 4; the minimum
  development Node.js version is now 22.13 to match ESLint's runtime requirement.
- Keep the desktop responsive during Cloudflare operations, serialize tunnel mutations, and make
  Windows Task Scheduler transitions bounded across repeated disable/enable cycles.
- Keep confirmation and settings dialogs inside the control column so the native Chromium child
  window cannot cover them.
- Run the service just compiled by `npm run build` in desktop development builds instead of a
  previously staged sidecar, while packaged builds continue to use only bundled resources.
- Never treat a working status line such as "Analyzing image" as a completed answer, even when
  ChatGPT has already rendered the completed-turn action.
- Isolate generated images from chat controls and blank page chrome, then clip the screenshot to
  the image box so a correctly sized but visually incorrect result is never returned.

### Security

- Desktop administration calls only the authenticated loopback API. The administrator key is read
  inside the native layer for the bounded request and is never returned to the WebView; only a newly
  created revocable client key crosses the bridge once and is cleared from the dialog on close.
- Project and conversation identifiers are interpolated into a chatgpt.com URL, so both are validated against anchored, charset-restricted patterns in the API layer and again in the adapter, and upload filenames are reduced to a bare sanitised name before reaching the browser file chooser.

### Limitations

- Listing and deleting projects cost roughly one navigation per project because the projects grid publishes no identifier; listing reports at most 25.
- Deletion is irreversible, requires an exact project-id confirmation header, applies to whatever identifier the client supplies including projects tab2api did not create, and is refused when two projects share the resolved name.

## [0.1.0] - 2026-08-15

### Added

- Local OpenAI-compatible Chat Completions, Responses, image generation, WAV speech, and UI-mediated transcription endpoints.
- Strict loopback binding, revocable per-device client keys, content-free usage counters, and bounded FIFO scheduling.
- Direct Playwright and app-managed loopback CDP browser backends.
- Tauri desktop controller with a docked dedicated Chromium window, localized settings, and in-app Cloudflare Tunnel management.
- English and Vietnamese documentation, offline CI, issue templates, security policy, and contribution guidance.

### Security

- Remote access remains optional and single-owner. Cloudflare Access is preferred; bearer-only activation requires explicit risk acceptance.
- Browser profiles, credentials, runtime data, logs, prompts, and generated artifacts remain excluded from source control.

### Limitations

- This is an unofficial browser automation preview, not the official OpenAI API and not a production or shared-service proxy.
- ChatGPT UI changes, rate limits, challenges, experiments, and account policy can interrupt operation.
- Windows desktop builds are unsigned previews; public binaries require code signing and clean-machine validation.

[Unreleased]: https://github.com/tang-vu/tab2api/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/tang-vu/tab2api/releases/tag/v0.1.0
