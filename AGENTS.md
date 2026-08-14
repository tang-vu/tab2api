# Repository instructions

## Product and safety invariant

`tab2api` is a local-only, unofficial browser automation bridge for one user operating one manually authenticated ChatGPT.com profile. Never read, export, print, persist outside the dedicated profile, or log credentials, cookies, web storage, access/refresh tokens, or authorization headers. Never call private ChatGPT endpoints, bypass challenges/rate limits/paywalls, rotate accounts/profiles, or expose the service/DevTools beyond loopback. GPM Login support may only get/start/stop the one explicitly configured profile; do not add profile, proxy, fingerprint, group, or extension management.

## Engineering rules

- Node.js 22+, strict TypeScript, ESM, Fastify, Playwright, Zod, Pino, Vitest.
- Keep HTTP concerns in `api/`, browser lifecycle in `browser/`, UI assumptions in `adapters/chatgpt/`, scheduling in `queue/`, and secrets/path checks in `security/`.
- Route handlers must never contain browser selectors. Add a provider capability rather than importing Playwright into API routes.
- Avoid `any`, unchecked casts, swallowed errors, fixed sleeps for completion, unbounded collections/queues/retries, and logging request/response bodies.
- Treat every UI locator as volatile. Prefer roles, labels, and stable data attributes; centralize candidates and test DOM variants.
- Automated tests must not contact ChatGPT.com. Manual E2E is opt-in only.
- Runtime/profile/artifact/prompt/log files must remain ignored by Git.

## Validation and definition of done

For behavior changes, add tests covering success, cancellation, timeout, and relevant typed failures. Before completion run `npm run check`, `npm test`, `npm run build`, `npm run smoke`, and `npm audit`; inspect `git status` and staged/untracked files for secrets/runtime data. Documentation must describe actual behavior and limitations. Do not call work complete with failing checks or an undocumented security tradeoff.

After each completed update, create a focused commit describing the change and push it to the configured remote. Never stage or push ignored runtime data, browser profiles, local API tokens, credentials, logs, or debug artifacts. If push authentication or branch protection blocks publication, keep the verified local commit and report the exact blocker.
