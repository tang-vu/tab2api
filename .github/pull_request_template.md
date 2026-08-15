## Summary

Describe the user-visible behavior and why the change is needed.

## Security and privacy

- [ ] The API origin and browser debugging interface remain loopback-only.
- [ ] I did not add credential/session extraction, private ChatGPT endpoints, challenge bypass, stealth, account rotation, or hosted/shared proxy behavior.
- [ ] I did not include browser profiles, tokens, cookies, storage, prompts, responses, HARs, traces, or unsanitized artifacts.
- [ ] New runtime/profile/artifact files are ignored by Git.
- [ ] Security consequences and residual risks are documented.

## Validation

- [ ] `npm run check`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `npm run smoke`
- [ ] `npm audit --audit-level=high`
- [ ] Relevant Rust formatting, Clippy, tests, and desktop build checks (for desktop changes)
- [ ] Automated tests did not contact ChatGPT.com

## Documentation

- [ ] Documentation matches the implemented behavior and limitations.
- [ ] Manual E2E steps, if used, were opt-in and ran only against my own session.
