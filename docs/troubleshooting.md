# Troubleshooting

Start with `npm run doctor`; it reports actionable checks without printing the local API token.

## Cloudflare installer says Access is not protecting the hostname

This is a fail-closed result, not a tunnel failure. The recommended fix is a Cloudflare Zero Trust self-hosted Access application covering the hostname configured in `TAB2API_TUNNEL_HOSTNAME`, followed by `npm run tunnel:install`. A single owner who explicitly accepts bearer-only public reachability may instead run `npm run tunnel:install:bearer-only`. See [cloudflare.md](cloudflare.md).

## Chromium executable missing

Run `npx playwright install chromium`. On Linux, Playwright may also recommend OS dependencies; follow its official install output. Avoid forcing an unrelated system Chrome executable unless you understand Playwright compatibility risk.

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

## Port unavailable

Stop the existing tab2api process or select another loopback port with `TAB2API_PORT`. Public hosts are rejected by design.

## 401 authentication error

Read `.tab2api/api-token` without adding whitespace and send it as `Authorization: Bearer ...`. Do not put it in a committed `.env`, shell history, issue, or log. Restart the client after token rotation.

## Timeout or cancellation

The request tab is closed and the prompt is not resubmitted automatically. Check ChatGPT manually because a submitted prompt may have generated before the failure. Increase `TAB2API_REQUEST_TIMEOUT_MS` only within its validated maximum if normal answers genuinely need longer.

## Streaming appears all at once

Expected: v0.1 buffered SSE waits for browser completion and then sends a single text delta plus terminal events. This is documented behavior, not token streaming.

## Windows autostart is installed but unavailable

Run `npm run autostart:status`, then inspect the ignored `.tab2api/service.log`. The task runs only after the configured user logs in. Moving the repository or Node executable invalidates the stored task paths; run `npm run autostart:remove` followed by `npm run autostart:install` from the new location.

If parallel requests become unreliable or trigger rate limits, set `TAB2API_CONCURRENCY=1` and restart the task. Values above 4 are rejected rather than allowing unbounded browser tabs.

## Image generation times out

Image UI generation is slower than text and defaults to `TAB2API_IMAGE_TIMEOUT_MS=300000`. Open the latest conversation manually: if the image exists, a ChatGPT DOM experiment may require a selector update. Enable debug only if you accept local screenshots. Do not blindly resend after timeout because the first image may already exist.

## Image capture reports a size mismatch

A `ui_changed` error naming the expected and captured sizes, such as `expected 1254x1254, captured 956x836`, means the frame could not be clipped to the whole picture. This is deliberate: the request fails rather than returning an image padded with chat interface and blank background. It usually indicates the viewport could not be sized to contain the element, so retry once and report a selector bug if it persists.

## Speech engine unavailable

Windows uses `System.Speech`; macOS requires `say`; Linux requires `espeak`. Only WAV output is supported. The `X-Tab2api-Audio-Backend` header intentionally identifies this as OS speech rather than ChatGPT/OpenAI TTS.

## Audio or image upload is rejected

Use a supported MIME type and stay below `TAB2API_MEDIA_LIMIT_BYTES`. Vision accepts only PNG/JPEG/WebP base64 data URLs, never remote URLs. Transcription accepts one multipart audio file. If ChatGPT itself rejects a valid file, inspect the headed UI; the bridge does not bypass account/UI restrictions.
