# tab2api desktop shell

This directory contains the optional Tauri 2 desktop controller. Rust owns native lifecycle and
tray integration while the existing Node.js/Playwright implementation remains the browser sidecar.
ChatGPT is deliberately opened in a dedicated Chromium window, never inside the system WebView.
The manual-login button launches that browser directly with only its dedicated profile path and the
ChatGPT URL. It does not attach Playwright/CDP, enable remote debugging, or automate credentials;
after the user closes this manual window, the service can reuse the same profile through Playwright.

## Development

From the repository root, build the sidecar first:

```powershell
npm run desktop:dev
```

In development the shell executes the built sidecar with the system Node.js runtime. Before making
a platform installer, stage a private Node runtime, production dependencies, `dist`, and Playwright's
browser into the ignored bundle resource directory:

```powershell
npm run desktop:build:windows
npm run desktop:smoke:windows
```

The packaged shell resolves only its bundled `sidecar/node(.exe)`, `sidecar/dist`,
`sidecar/node_modules`, and `sidecar/ms-playwright` resources. The shell always overrides
`TAB2API_HOST=127.0.0.1`, `TAB2API_BROWSER_BACKEND=playwright`, and both data paths; none of these
settings are delegated to the frontend. Runtime data and the dedicated profile live in the OS
app-local data directory, outside installation resources.

The UI never receives an API token, browser profile contents, cookies, authorization headers, or
sidecar output. It probes only the public local `/healthz` endpoint. Login can only open while the
service process is stopped, preventing two processes from concurrently using the profile. The shell
tracks the manual Chromium child until it exits and never falls back to a system browser or personal
profile. Shutdown
uses the sidecar's versioned JSON stdin protocol, waits up to eight seconds for cleanup, and only
then falls back to terminating an unresponsive child.

## Validation

```powershell
npm run desktop:check
npx tauri build --no-bundle --config desktop/tauri.conf.json
```

The initial build needs network access to download Rust dependencies and a platform-supported Tauri
WebView toolchain. Development continues to use Playwright's installed browser. The Windows
packaging command downloads the one version-matched headed Chromium revision into ignored bundle
resources; it never copies a personal browser installation or profile.
