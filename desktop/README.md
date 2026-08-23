# tab2api desktop shell

This directory contains the optional Tauri 2 desktop controller. Rust owns native lifecycle and
tray integration while the existing Node.js/Playwright implementation remains the browser sidecar.
ChatGPT is deliberately opened in a dedicated Chromium window, never inside the system WebView.
The manual-login button launches that browser directly with only its dedicated profile path and the
ChatGPT URL. It does not attach Playwright/CDP, enable remote debugging, or automate credentials;
after the user closes this manual window, the Windows service relaunches the same profile in
Chromium app mode and Playwright connects through a verified loopback-only CDP listener.

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
settings are delegated to the frontend. On Windows, the CDP endpoint is selected dynamically and
passed only between native Rust and the Node child. Runtime data and the dedicated profile live in the OS
app-local data directory, outside installation resources.

The UI never receives an administrator token, CDP endpoint, PID/window handle, browser profile contents,
cookies, authorization headers, or sidecar output. Periodic status probes use only the public local
`/healthz` endpoint; a separate serialized, 45-second-bounded native command calls authenticated
`/readyz` and returns only an allowlisted session state. Login can only open while the
service process is stopped, preventing two processes from concurrently using the profile. The shell
tracks the manual Chromium child until it exits and never falls back to a system browser or personal
profile. During service operation, the verified owned Chromium window is best-effort made a direct
child of the Tauri main window and positioned over the browser pane. No background thread creates
an intermediate HWND that would require its own message loop. DPI, ownership, or Win32 hosting failures fall back to the normal external
app window; the Tauri system WebView never loads ChatGPT. macOS and Linux keep the prior external,
Playwright-owned browser path. Shutdown
uses the sidecar's versioned JSON stdin protocol, waits up to eight seconds for cleanup, and only
then falls back to terminating an unresponsive child. Windows Chromium cleanup targets the exact
launched PID and its process tree with a bounded wait so a loopback debugging listener is not left behind.

On Windows, the **Personal Cloudflare Tunnel** card manages the optional tunnel without exposing
configuration or credentials to the WebView. It can install the exact cloudflared winget package,
verify prerequisites, activate the existing dedicated tunnel with the Access-protected path, and
remove its Scheduled Task. Bearer-only activation is deliberately separate and requires an explicit
single-owner risk confirmation. Cloudflare account, tunnel, DNS, Access policy, and credential setup
remain prerequisites rather than being created or imported by the desktop shell.

The card contains the complete prerequisite and Access-policy walkthrough and opens the private
setup folder without revealing its path to frontend JavaScript. The Settings dialog supports
English, Vietnamese, Chinese, Japanese, Korean, Spanish, French, and German. Initial language
selection uses only the operating-system locale; no IP geolocation or locale network request is
made. The only persisted WebView preference is the selected language code.

## Validation

```powershell
npm run desktop:check
npx tauri build --no-bundle --config desktop/tauri.conf.json
```

The initial build needs network access to download Rust dependencies and a platform-supported Tauri
WebView toolchain. Development continues to use Playwright's installed browser. The Windows
packaging command downloads the one version-matched headed Chromium revision into ignored bundle
resources; it never copies a personal browser installation or profile. Staging emits a CycloneDX
SBOM for production Node dependencies and a SHA-256/size inventory for every sidecar file. The
packaged smoke verifies both before running the compiled fake-adapter request offline and checking
the real sidecar's loopback health and graceful shutdown. This integrity inventory does not replace
signing, externally published installer checksums, full native SBOM/provenance, or a signed release's
broader clean-machine matrix.

The manual `Desktop install smoke` workflow adds an ephemeral Windows install/uninstall gate without
publishing its unsigned installer. It installs under a strict runner-temporary root, runs the same
offline smoke against the installed `sidecar/`, uninstalls with bounded waits, and confirms the
default uninstaller preserves app-local profile data.
