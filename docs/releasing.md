# Release process

Only maintainers may publish a release. Releases must come from a clean, reviewed `main` commit and must never contain browser profiles, runtime files, credentials, tokens, prompts, responses, logs, traces, screenshots, tunnel configuration, or machine-specific paths.

## Source and npm release checklist

1. Keep `package.json`, `desktop/Cargo.toml`, `desktop/tauri.conf.json`, and `CHANGELOG.md` on the same semantic version.
2. Install the pinned Rust auditor with `cargo install cargo-audit --version 0.22.2 --locked`, then run `npm ci`, `npm run check`, `npm test`, `npm run build`, `npm run smoke`, `npm audit`, `npm run desktop:check`, and `npm run desktop:audit`.
3. Run `npm pack --dry-run --json` and inspect every included path. Confirm the generated `dist/` has no stale modules.
4. Review the complete diff and tracked-file list for sensitive or machine-specific data.
5. Create an annotated `vX.Y.Z` tag from the verified commit and publish source release notes derived from `CHANGELOG.md`.
6. If publishing to npm, require maintainer 2FA or trusted publishing, use provenance, and verify the registry tarball and digest after publication.

The npm package is optional for a source preview. If the maintainer is not authenticated with 2FA
or a trusted publisher is not configured, publish only the GitHub source prerelease and record npm as
not published. Never weaken authentication or use an unprotected automation token to make the two
channels appear synchronized.

## Desktop binary gates

Windows staging already creates a production-Node CycloneDX SBOM and a complete SHA-256/size inventory of the bundled sidecar, and `desktop:smoke:windows` verifies both before running its offline fake-adapter and lifecycle checks. These are staging-integrity evidence, not artifact authenticity or a full application SBOM.

Before promoting a Windows candidate, manually dispatch `Desktop install smoke` for the exact commit. It builds but never uploads the unsigned NSIS artifact, installs under an isolated temporary root on a fresh hosted runner, runs the installed sidecar smoke offline, verifies hidden startup/single-instance/crash-lock recovery, uninstalls, checks sign-in launch cleanup, and verifies default profile retention. A green run is installation evidence for that commit, not a signature or publication approval.

Do not attach desktop installers until the target platform pipeline also provides code signing, externally published installer/component checksums, clean-machine install/uninstall tests, a full application SBOM covering Rust/native components, provenance, and complete third-party notices. Build each platform artifact on that platform and keep signing credentials in an environment-protected release job. Pull-request CI must never receive signing or publishing credentials.

If any gate fails after a tag is published, do not silently replace public artifacts. Document the issue, revoke or deprecate the affected release when appropriate, fix it on `main`, and publish a new version.
