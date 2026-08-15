# Contributing

Thank you for helping improve tab2api. Read `AGENTS.md`, `docs/architecture.md`, and `docs/security.md` first.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). For usage questions and sanitized troubleshooting, see [SUPPORT.md](SUPPORT.md).

Release publication is maintainer-only and follows [docs/releasing.md](docs/releasing.md).

## Boundaries

Contributions must keep the bridge single-user and loopback-only. Do not submit credential/cookie/token extraction, private ChatGPT endpoints, CAPTCHA or Cloudflare bypass, stealth/fingerprint spoofing, account rotation, rate-limit/paywall circumvention, or hosted proxy features. Do not include real profiles, screenshots, prompts, responses, tokens, HAR files, or account identifiers in issues/tests/commits.

## Development

Use Node.js 22+ and `npm ci`. Automated tests must be offline and use fake providers or sanitized DOM fixtures. Put UI assumptions only in `src/adapters/chatgpt/`; add fixtures and state/error tests for selector changes.

Before opening a pull request:

```text
npm run check
npm test
npm run build
npm run smoke
npm audit --audit-level=high
```

Use a focused branch and keep commits reviewable. Link a relevant issue when one exists. Maintainers may close proposals that conflict with the single-owner, loopback-only product boundary even when the implementation is technically sound.

Review `git status` and the diff for secrets/runtime files. Explain behavior, security consequences, tests, and documentation changes in the PR. Manual E2E is optional and must be explicitly enabled against your own session; never ask maintainers to share credentials or profiles.

## Reporting security issues

Do not publish session material or an exploit containing real data. Use the repository's private security reporting channel when available. Include a minimal sanitized reproduction, affected version, impact, and suggested mitigation.
