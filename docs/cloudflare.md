# Private remote access with Cloudflare

`tab2api` remains bound to `127.0.0.1`. A Cloudflare Tunnel may proxy the loopback origin only when a Cloudflare Access application protects the entire hostname first. A tunnel without Access is a public Internet route and is unsupported.

## Required controls

1. Create a dedicated named tunnel; never reuse another project's tunnel.
2. Route the dedicated tunnel to `tab2api.tangvu.dev`.
3. In Cloudflare Zero Trust, create a self-hosted Access application for the entire `tab2api.tangvu.dev` hostname.
4. Use a deny-by-default policy. For interactive tools, allow only the owner's identity with MFA. For unattended OpenAI-compatible clients, use a `Service Auth` policy scoped to one service token per device.
5. Never add `Everyone` or `Bypass`. Protect every path, including `/healthz` and `/readyz`.
6. Keep the independent tab2api bearer key. Cloudflare Access does not replace application authentication.

Automated clients using Service Auth send both Cloudflare headers in addition to the tab2api bearer token:

```text
CF-Access-Client-Id: <device service-token id>
CF-Access-Client-Secret: <device service-token secret>
Authorization: Bearer <tab2api client key>
```

Many OpenAI-compatible clients support custom/default headers. If yours cannot send the two Cloudflare headers, do not create an Access bypass; use a different client or a private-network solution.

## Windows activation

The local runtime files `.tab2api/cloudflared-tab2api.yml` and `.tab2api/cloudflared-access-probe.yml` are deliberately gitignored because they contain tunnel identifiers and credential paths. After creating the Access application, run:

```powershell
npm run tunnel:install
npm run tunnel:status
```

The installer starts a temporary tunnel whose origin is a fixed HTTP 418 response. It refuses installation unless Cloudflare intercepts that response and redirects to a `cloudflareaccess.com` login host. It never exposes tab2api during this check.

Remove autostart without deleting DNS or credentials:

```powershell
npm run tunnel:remove
```

## API keys and usage

Create one tab2api client key per remote device:

```powershell
npm run keys -- create "personal laptop"
npm run keys -- list
npm run keys -- revoke <key-id>
npm run usage
```

The plaintext client key is printed once. Only its SHA-256 digest is stored in `.tab2api/api-keys.json`. Usage is stored in `.tab2api/usage.json` and contains counters, endpoint names, byte totals, latency, labels, and estimated token counts—never prompts or responses.

ChatGPT Web does not expose authoritative token usage. `estimatedInputTokens` and `estimatedOutputTokens` are an explicit byte-length estimate and must not be used for billing or quota enforcement.
