# Troubleshooting

Start with `npm run doctor`; it reports actionable checks without printing the local API token.

## Chromium executable missing

Run `npx playwright install chromium`. On Linux, Playwright may also recommend OS dependencies; follow its official install output. Avoid forcing an unrelated system Chrome executable unless you understand Playwright compatibility risk.

This check applies only to `TAB2API_BROWSER_BACKEND=playwright`.

## GPM Login Local API/profile failure

Start the GPM Login desktop application and confirm `TAB2API_GPM_PROFILE_ID` is the UUID of the one intended profile. The default Local API is `http://127.0.0.1:9495/api/v1`; if GPM selected a fallback port, update `TAB2API_GPM_BASE_URL` from its local `http.port` file. tab2api refuses a Local API or returned DevTools WebSocket outside loopback. Do not expose either port through a firewall, tunnel, or reverse proxy.

## `login_required`

Run `npm run login`, log in to your own account in the dedicated window, and wait for `ready`. Do not paste credentials into the terminal. If the account signed out, repeat this flow.

## `security_challenge`

Open `npm run login` and complete the challenge manually. tab2api intentionally cannot solve, skip, or automate CAPTCHA/Cloudflare/security checks. If it repeats, stop and use ChatGPT normally rather than retrying rapidly.

## `rate_limited`

Wait for the UI/account limit to clear and retry later. There is no rotation, quota bypass, or automatic retry.

## `ui_changed`

Confirm the page is normal in `npm run login`. UI experiments/localization can invalidate selectors. Set `TAB2API_DEBUG=true` only if you accept that a local screenshot may include prompt/response content; reproduce once, inspect `.tab2api/debug-artifacts`, remove sensitive data, then file a bug with version/locale and sanitized evidence. Never upload the browser profile.

## Browser disconnected/profile locked

Close other tab2api/Chromium processes using the dedicated profile, run `npm run reset-session` if the server is alive, then retry. Never configure your normal Chrome/Edge profile. If Playwright cannot launch, reinstall its Chromium.

In GPM mode, stop the configured profile from GPM Login if its cached running state is stale, then run `npm run doctor`. tab2api deliberately does not delete or recreate the profile.

## Port unavailable

Stop the existing tab2api process or select another loopback port with `TAB2API_PORT`. Public hosts are rejected by design.

## 401 authentication error

Read `.tab2api/api-token` without adding whitespace and send it as `Authorization: Bearer ...`. Do not put it in a committed `.env`, shell history, issue, or log. Restart the client after token rotation.

## Timeout or cancellation

The request tab is closed and the prompt is not resubmitted automatically. Check ChatGPT manually because a submitted prompt may have generated before the failure. Increase `TAB2API_REQUEST_TIMEOUT_MS` only within its validated maximum if normal answers genuinely need longer.

## Streaming appears all at once

Expected: v0.1 buffered SSE waits for browser completion and then sends a single text delta plus terminal events. This is documented behavior, not token streaming.
