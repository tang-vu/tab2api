# Changelog

All notable user-facing changes are documented here. This project follows semantic versioning while it remains in the `0.x` preview phase.

## [Unreleased]

### Fixed

- Keep the desktop responsive during Cloudflare operations, serialize tunnel mutations, and make
  Windows Task Scheduler transitions bounded across repeated disable/enable cycles.
- Keep confirmation and settings dialogs inside the control column so the native Chromium child
  window cannot cover them.

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
