# Release process

Only maintainers may publish a release. Releases must come from a clean, reviewed `main` commit and must never contain browser profiles, runtime files, credentials, tokens, prompts, responses, logs, traces, screenshots, tunnel configuration, or machine-specific paths.

## Source and npm release checklist

1. Keep `package.json`, `desktop/Cargo.toml`, `desktop/tauri.conf.json`, and `CHANGELOG.md` on the same semantic version.
2. Run `npm ci`, `npm run check`, `npm test`, `npm run build`, `npm run smoke`, `npm audit`, and `npm run desktop:check`.
3. Run `npm pack --dry-run --json` and inspect every included path. Confirm the generated `dist/` has no stale modules.
4. Review the complete diff and tracked-file list for sensitive or machine-specific data.
5. Create an annotated `vX.Y.Z` tag from the verified commit and publish source release notes derived from `CHANGELOG.md`.
6. If publishing to npm, require maintainer 2FA or trusted publishing, use provenance, and verify the registry tarball and digest after publication.

## Desktop binary gates

Do not attach desktop installers until the target platform pipeline provides code signing, clean-machine install/uninstall tests, embedded-component checksums, an SBOM, provenance, and complete third-party notices. Build each platform artifact on that platform and keep signing credentials in an environment-protected release job. Pull-request CI must never receive signing or publishing credentials.

If any gate fails after a tag is published, do not silently replace public artifacts. Document the issue, revoke or deprecate the affected release when appropriate, fix it on `main`, and publish a new version.
