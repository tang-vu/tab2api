# Desktop application and distribution

## Status

The `desktop/` directory is a Tauri 2 developer preview, not a signed end-user release. It provides a native window and system tray for status, start, stop, and manual login. The existing TypeScript service and Playwright adapter remain the source of truth for the API and browser automation.

Development mode uses the repository Node.js runtime and Playwright installation. The Windows packaging pipeline is self-contained: it stages the current Node runtime, audited production npm dependencies, compiled service, and only the headed Chromium revision matched to Playwright, then creates an unsigned NSIS installer. Staging also creates a CycloneDX SBOM for the production Node dependency graph and a SHA-256/size inventory for every bundled sidecar file. Pull-request CI compiles with `--no-bundle` and deliberately uploads nothing. A separate manual workflow performs an ephemeral Windows install/uninstall smoke without retaining the unsigned artifact; signing and broader clean-VM validation remain release gates.

## Architecture

```mermaid
flowchart LR
    U[Single local operator] --> W[Tauri native control window]
    W -->|allowlisted commands only| R[Rust lifecycle controller]
    R -->|child process| N[Node.js tab2api sidecar]
    N -->|127.0.0.1 only| A[OpenAI-compatible API]
    R -->|app mode + random loopback CDP| C[Dedicated headed Chromium profile]
    N -->|Playwright connectOverCDP| C
    C --> G[ChatGPT.com public web UI]
    L[Local API client] -->|bearer token| A
```

Tauri's operating-system WebView renders only the local control UI. It never navigates to ChatGPT. During normal Windows operation Rust launches the bundled Chromium in application mode with the dedicated profile and an operating-system-selected debugging port. After verifying that the listener belongs to that Chromium process tree and is loopback-only, Rust passes an internal loopback endpoint to the Node sidecar; Playwright then connects over CDP. The endpoint, browser process identifiers, native handles, and profile path are never returned to the frontend.

The Windows shell can best-effort make Chromium's owned top-level window a direct child of the Tauri main HWND and position it over the reserved UI pane. It deliberately does not create an intermediate Win32 window from a background worker: such a window would have no UI-thread message pump and can deadlock painting. Candidate Chromium windows must belong to the launched process tree and resolve to the canonical bundled executable; matching a title alone is never sufficient. Docking also requires compatible DPI-awareness contexts. Cross-thread resize requests use asynchronous Win32 positioning. The requested pane rectangle is converted for the current DPI and clipped to the application client area on resize and scroll; when the pane is entirely outside the visible viewport, Chromium is reduced to a one-pixel edge until it becomes visible again. Any discovery, ownership, DPI, `SetParent`, style, or resize failure restores/keeps Chromium as a normal external app window without disabling the local API. macOS and Linux retain the existing Playwright-owned external browser behavior.

The Rust layer owns both child-process boundaries and forces `TAB2API_HOST=127.0.0.1` and `TAB2API_BROWSER_BACKEND=playwright`. On Windows it supplies `TAB2API_BROWSER_CDP_ENDPOINT` only to the sidecar process. Its normal status payload contains only a phase, the local API endpoint, a content-free status message, and `none`, `external`, or `docked` browser mode. Process health is deliberately not presented as proof that ChatGPT is ready. A separate, serialized session check uses the administrator credential inside Rust to call the authenticated loopback `/readyz` route, then returns only `ready` plus one allowlisted session-state enum to the WebView. The administrator credential, CDP endpoint, sidecar output, profile data, process/window identifiers, cookies, authorization headers, prompts, and responses never cross into the WebView. The sole key exception is a newly created revocable client key: an explicit create action returns it once to a modal, the UI never persists it, and closing the modal clears its DOM text. The WebView content security policy denies network connections.

The Windows controller also exposes bounded Cloudflare Tunnel lifecycle controls. It can install the exact `Cloudflare.cloudflared` winget package, inspect prerequisites, install/start the existing dedicated tunnel as a per-user Scheduled Task, or stop/remove that task. Access-protected activation remains the default and runs the fixed-response Access probe. Bearer-only activation is a separate UI action with explicit single-owner risk confirmation. Mutating operations are serialized, and Task Scheduler transitions wait up to ten seconds for stop, removal, and startup states instead of racing or retrying silently. The tunnel card shows localized progress and disables only its own controls, so the local service, browser controls, and settings remain responsive. Both activation paths verify the final running mode before reporting success. The frontend receives booleans, mode, and content-free status text only; configuration paths, tunnel credentials, command output, and authorization material never cross the native bridge. The desktop controller does not create a Cloudflare account, tunnel, DNS route, Access policy, or credential file.

The tunnel card includes an in-app, localized setup guide and can open the exact private runtime folder in File Explorer without returning its path to the WebView. Settings support English, Vietnamese, Simplified Chinese, Japanese, Korean, Spanish, French, and German. On first launch the WebView selects from the operating-system locale; it never performs IP geolocation or sends locale data over the network. A user-selected language is the only value stored in the controller WebView's local settings storage. If that storage is unavailable, the app continues with local locale detection and does not fail startup.

The main window also has Browser, API Docs, and Keys & Usage tabs. The service card distinguishes a healthy local API from a verified ChatGPT session. It runs one session check after the service reaches healthy state and also provides an explicit retry button; it never polls the live ChatGPT UI in the background. Each check opens a temporary provider tab through `/readyz`, is bounded to 45 seconds, and localizes actionable states such as login required, security challenge, rate limit, UI change, and browser disconnection. API Docs is fully local, follows the selected language, and documents authentication, core OpenAI-compatible routes, projects, media, administrator routes, examples, and current limitations. Its export button writes the canonical `docs/api.md` to a newly named `tab2api-api*.md` file in Downloads, never overwrites an existing file, and never inserts credentials. Keys & Usage lists only key metadata, creates and shows a revocable client key once, requires confirmation before revocation, displays content-free per-key/per-endpoint counters, and requires confirmation before resetting those counters. The local service must be running for administration. On Windows, switching away from Browser hides the docked native Chromium child; switching back restores and resizes it. An explicitly undocked external browser remains independent of the tab selection.

Native authenticated access is deliberately narrow: Rust reads the administrator token from the private app runtime (or the explicit environment override), rejects header-unsafe values, sends only hard-coded administrator routes and `/readyz` to IPv4 loopback, applies four-second administration timeouts and a 45-second readiness timeout, enforces a 1 MiB response limit, and discards the request buffer and administrator token before reading the response. Error messages never include the token or response body. Returned key, usage, and readiness structures are bounded and validated again before crossing the Tauri command boundary.

Current lifecycle behavior is intentionally small:

- start waits up to 15 seconds for `GET /healthz` on IPv4 loopback;
- login is allowed only while the service and automation browser are stopped. It launches Chromium directly with only the dedicated `--user-data-dir` and ChatGPT URL: no CDP, Playwright, automation, proxy, or anti-detection flags are used during login;
- Windows Start removes only the stale `DevToolsActivePort` file inside the dedicated profile, launches `--app=https://chatgpt.com/ --remote-debugging-port=0`, parses a bounded port file, and rejects an unowned or non-loopback listener before starting Node;
- a Start failure rolls back the Node child and Chromium. Stop/quit requests graceful Node shutdown and then performs bounded Chromium process-tree cleanup so CDP is not orphaned;
- periodic status probes only `127.0.0.1` for process liveness; authenticated browser readiness is a separate bounded check and is never treated as a cheap background poll;
- stop and application exit request graceful shutdown over a private, bounded JSONL stdin protocol, wait up to eight seconds, then terminate and reap the child only as a fallback;
- the profile and runtime data stay outside the application installation directory.

Native Win32 reparenting is explicitly experimental because Chromium and Windows do not promise that cross-process child-window hosting will remain stable. "Open externally" is the supported escape hatch; "Dock browser" retries only the already verified owned window. The UI intentionally offers no native reload shortcut because synthesizing input could interfere with an in-progress generation.

## Development

Install Node.js 22.13+, the Rust toolchain declared by `desktop/Cargo.toml`, and the platform prerequisites from the [official Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). Windows development requires the MSVC C++ build tools and WebView2; macOS requires Xcode Command Line Tools; Linux requires WebKitGTK 4.1 and the tray/application-indicator libraries.

Build and run from the repository root:

```powershell
npm ci
npx playwright install chromium
npm run desktop:dev
```

`desktop:dev` rebuilds `dist/` and runs it. It does not refresh `desktop/generated/sidecar/`, which only `desktop:prepare:*` stages, so the shell deliberately prefers the repository build in a development build; otherwise `npm run build` would appear to have no effect. The staged Node runtime and Chromium are still used when they exist, so a development machine does not need its own working Playwright installation. Packaged builds are unaffected and resolve only their own resources.

Use only your own dedicated profile and log in manually. Development and CI commands must not contact ChatGPT.com automatically.

Validate the desktop code:

```powershell
npm run check
npm test
npm run desktop:check
npx tauri build --no-bundle --config desktop/tauri.conf.json
```

`desktop.yml` runs those checks on Windows, macOS, and Ubuntu 22.04. It skips the Playwright browser download, has read-only repository permissions, supplies no production secrets, creates no installer, and publishes no artifact or release. The build proves compilation; it is not an installation test.

`desktop-install-smoke.yml` is a separate `workflow_dispatch` gate on a fresh Windows runner. It builds the unsigned NSIS preview, installs silently with shortcuts disabled into a unique directory under `RUNNER_TEMP`, verifies the installed manifest/SBOM and offline fake-adapter plus loopback lifecycle, then silently uninstalls. The test confirms installation files are removed while an app-local profile marker is retained because profile deletion was never requested. Every installer, uninstaller, startup, shutdown, and cleanup wait is bounded. The workflow has read-only repository permissions and uploads no installer or other artifact.

## Self-contained Windows packaging

The preferred OSS distribution is a Tauri/Rust shell around the existing Node.js/Playwright implementation. Rewriting browser automation in Rust or loading ChatGPT inside the system WebView would add platform-specific behavior without eliminating the need to maintain a browser engine.

Build and smoke the current unsigned Windows preview:

```powershell
npm run desktop:build:windows
npm run desktop:smoke:windows
```

`desktop:prepare:windows` creates the ignored `desktop/generated/sidecar/` resource tree from a clean production dependency install and uses Playwright's `--no-shell` option because the application is always headed. It requires the Node runtime license, retains project notices and Chromium's bundled attribution files, writes `sidecar-sbom.cdx.json`, then writes `bundle-manifest.json` with the byte length and SHA-256 of every other staged file. Before Tauri runs, preparation removes the previous `target/release/sidecar` copy because Tauri overlays directory resources and would otherwise retain obsolete files. Tauri bundles the clean tree under `sidecar/`; the Rust process never accepts a binary path from the WebView. `desktop:smoke:windows` first rejects missing, extra, resized, rehashed, duplicate, rooted, or traversal paths and validates the SBOM. It then runs the compiled CLI fake provider through authentication, validation, mapping, and the FIFO queue with external proxy variables pointed at a closed loopback port, followed by the real packaged sidecar's loopback liveness and graceful-shutdown lifecycle. All child waits are bounded and the ignored smoke runtime is removed in `finally`. The generated installer is under `desktop/target/release/bundle/nsis/` and must not be committed.

The installer workflow passes the installed `sidecar/` path explicitly to that same smoke script only after the strict manifest check. `smoke-desktop-installer.ps1` refuses an existing or out-of-root install directory, uses the documented NSIS silent `/S` and no-shortcut `/NS` modes, keeps `/D` as the final unquoted installer argument, and uses `_?=` for a fully waitable silent uninstall. Cleanup is limited to the validated runner-temporary directory and a non-sensitive, uniquely named profile-retention probe.

The implemented Windows staging layout contains all executable dependencies needed at runtime. Other platforms must implement the equivalent native staging before distributing installers:

1. Build `dist/` from a clean `npm ci` checkout and stage only audited production dependencies.
2. Package a platform-native Node.js 22 runtime or a tested standalone sidecar executable. Do not assume `node` is on the user's `PATH`.
3. Package the Playwright version-matched Chromium build in an application resource directory and set an internal browser path. Do not use the user's default Chrome profile.
4. Register the platform-specific sidecar/resource paths in Tauri configuration. Validate resolved paths before execution; never accept an executable path from the WebView.
5. Keep `.tab2api/`, the browser profile, API keys, usage metadata, and opt-in debug artifacts in the per-user application-data directory, outside the signed/read-only installation tree.
6. Include third-party notices and licenses for Node.js, Chromium, Playwright, Rust crates, and JavaScript dependencies.
7. Produce installers on native, pinned build images. Code-sign Windows packages and sign/notarize macOS packages before calling them releases.

Bundling Chromium makes the download much larger and transfers browser patch responsibility to tab2api maintainers. A release policy must define how quickly a Playwright/Chromium security update is rebuilt and shipped. The embedded inventory detects accidental staging drift but provides no authenticity while the installer is unsigned; an official release still needs signed artifacts, externally published checksums, full-application SBOM/provenance, and clean-machine tests. The application must never silently fall back to a personal system browser profile.

Tauri supports separating compilation from bundling with `tauri build --no-bundle`; see the [official distribution guide](https://v2.tauri.app/distribute/). Installer generation should remain a separate, protected release workflow.

## Release workflow recommendation

Do not turn pull-request CI into a publishing pipeline. Add a separate release workflow only after the staging layout and clean-machine install tests exist. That workflow should:

- run only for protected semantic-version tags after maintainer approval;
- pin actions and toolchains, use least-privilege permissions, and isolate signing secrets to environment-protected native jobs;
- build each OS artifact on that OS and verify the embedded sidecar and Chromium checksums;
- install into a clean VM, start offline with a fake adapter, verify loopback binding/authentication, uninstall, and confirm the user profile is retained unless deletion was explicitly selected;
- generate checksums, an SBOM, provenance, third-party notices, and a changelog;
- sign/notarize before publishing and never include `.env`, `.tab2api/`, profiles, tokens, logs, screenshots, or tunnel credentials;
- require an explicit maintainer promotion step before creating a GitHub Release.

An updater should not be enabled until update manifests and binaries are cryptographically signed, downgrade behavior is defined, and profile/schema compatibility is tested. Autostart must remain opt-in and must not create a second service alongside an existing Scheduled Task or login item.

## Acceptance criteria for the first distributable preview

- A clean Windows machine can install and run without separately installing Node.js, Chrome, or Playwright.
- The first-login button opens the bundled, dedicated Chromium profile in headed mode.
- Start, stop, quit, crash recovery, reboot/autostart opt-in, update, and uninstall have automated lifecycle tests.
- The API and browser debugging transport remain loopback-only, and non-loopback configuration is rejected.
- The UI never receives or persists API tokens or conversation content.
- A fake-adapter smoke test passes inside each packaged application without network access.
- No unsigned artifact is described as an official release.
- Windows signing, macOS signing/notarization, checksums, SBOM, dependency notices, and update ownership are documented.

Until these criteria pass, build from source and treat the desktop shell as a developer preview.
