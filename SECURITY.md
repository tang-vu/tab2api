# Security policy

tab2api controls a browser profile containing a manually authenticated, user-owned ChatGPT session. Treat that profile, every tab2api API key, Cloudflare credential, prompt, response, and debug artifact as sensitive.

## Supported versions

Security fixes are provided for the latest tagged release and the current `main` branch. Older releases are not guaranteed to receive patches. This is an unofficial, single-user tool and is not suitable for production or shared-service operation.

## Report a vulnerability privately

Do not open a public issue for a vulnerability. Use [GitHub private vulnerability reporting](https://github.com/tang-vu/tab2api/security/advisories/new). If that channel is unavailable, open a content-free issue asking the maintainer to enable a private contact method; do not include exploit details or sensitive material.

Include only a sanitized description of:

- the affected version or commit;
- impact and prerequisites;
- minimal reproduction steps using fake data;
- the proposed mitigation, if known.

Never submit a browser profile, cookie, web storage, authorization header, API key, tunnel credential, real prompt/response, HAR, trace, or unsanitized screenshot. Maintainers will not ask for account credentials or a copy of an authenticated profile.

## Security boundaries

Supported use is one person operating one dedicated browser profile that they log into manually. The API origin and browser debugging interface must remain loopback-only. A personal tunnel is optional, must target the loopback origin, and must use an independent revocable client key; Cloudflare Access is recommended as a second authentication layer. Bearer-only tunnel mode is an explicit single-owner risk acceptance, not a hosted or multi-user mode.

The project will not accept features that extract session material, call private ChatGPT endpoints, automate security challenges, conceal automation, rotate accounts, evade quotas, or expose a public/shared proxy. See `docs/security.md` for the complete threat model and operator guidance.

## If a secret or profile is exposed

1. Stop tab2api and its tunnel.
2. Revoke affected tab2api client keys and rotate the local administrator token.
3. Sign out or revoke the affected ChatGPT session using normal account controls.
4. Remove the dedicated browser profile and log in again manually.
5. Rotate Cloudflare tunnel or Access credentials when applicable.
6. If material entered Git history, rotate it before rewriting history; deleting it in a later commit is insufficient.

Do not post the exposed value while requesting help.
