# Release process

Only maintainers may publish a release. Releases must come from a clean, reviewed `main` commit and must never contain browser profiles, runtime files, credentials, tokens, prompts, responses, logs, traces, screenshots, tunnel configuration, or machine-specific paths.

## Source and npm release checklist

1. Keep `package.json`, `desktop/Cargo.toml`, `desktop/tauri.conf.json`, and `CHANGELOG.md` on the same semantic version.
2. Install the pinned Rust auditor with `cargo install cargo-audit --version 0.22.2 --locked`, then run `npm ci`, `npm run check`, `npm test`, `npm run test:coverage`, `npm run build`, `npm run smoke`, `npm audit`, `npm run desktop:check`, and `npm run desktop:audit`.
3. Run `npm pack --dry-run --json` and inspect every included path. Confirm the generated `dist/` has no stale modules.
4. Review the complete diff and tracked-file list for sensitive or machine-specific data.
5. Create an annotated `vX.Y.Z` tag from the verified commit and publish source release notes derived from `CHANGELOG.md`.
6. If publishing to npm, use maintainer 2FA, trusted publishing, or a short-lived granular token
   with bypass 2FA. Always publish with provenance and verify the registry tarball and digest.

The npm package is optional for a source preview. `Publish npm package` supports both npm trusted
publishing and an initial/backup granular access token with bypass 2FA. A token must be short-lived,
stored only as the `NPM_TOKEN` secret in the protected `npm` GitHub Environment, and revoked after
use. Remove the environment secret after revocation. Never paste it into chat, issues, workflow
files, repository secrets shared with pull-request jobs, command arguments, or logs. The workflow
exposes it only to `npm publish`; all builds, tests, packing, and post-publish verification run
without that credential.

The publish workflow is manual and requires the exact annotated tag plus the literal
`publish-tab2api` confirmation. Before receiving the environment secret, it proves the tag belongs
to `main`, requires a successful matching `Source package provenance` run and a non-draft GitHub
Release, re-runs the complete source/desktop gates, and validates the tarball allowlist. It publishes
that reviewed tarball with provenance, then downloads the public registry copy and requires its
integrity and manifest to match. Configure npm trusted publishing for future releases whenever the
package already exists; the same workflow can then authenticate through OIDC without a long-lived
write token when the `NPM_TOKEN` environment secret is absent.

Pushing an annotated semantic-version tag also runs `Source package provenance`. The workflow
checks that the tag is reachable from `main`, re-runs the complete source and desktop verification
set, validates the actual `npm pack` file list against a narrow allowlist, generates a production
dependency CycloneDX SBOM and SHA-256 checksums, and creates GitHub provenance plus SBOM
attestations. It retains the candidate for 14 days as an authenticated workflow artifact. The job
has no `contents: write` or npm credential, so it cannot create a GitHub Release, publish to npm, or
attach a desktop binary. An attested candidate is evidence about its origin, not permission to
publish it and not proof that it is vulnerability-free.

After downloading a candidate, verify its provenance before inspection:

```bash
gh attestation verify tab2api-X.Y.Z.tgz -R tang-vu/tab2api
sha256sum --check SHA256SUMS
```

The `v0.2.1` workflow artifact alone retained the internal `release-candidate/` staging prefix in
`SHA256SUMS` even though artifact download flattens that directory. Its hashes and attestations are
valid; verify that artifact with
`sed 's#release-candidate/##' SHA256SUMS | sha256sum --check -`. Later candidates write portable
basenames and use the direct command above.

`npm run release:verify -- --tag vX.Y.Z` performs the local version/changelog/package-boundary
checks. Supplying `--pack-json <path>` additionally checks an `npm pack --json` result.

## Desktop binary gates

Windows staging already creates a production-Node CycloneDX SBOM and a complete SHA-256/size inventory of the bundled sidecar, and `desktop:smoke:windows` verifies both before running its offline fake-adapter and lifecycle checks. These are staging-integrity evidence, not artifact authenticity or a full application SBOM.

Before promoting a Windows candidate, manually dispatch `Desktop install smoke` for the exact commit. It builds but never uploads the unsigned NSIS artifact, installs under an isolated temporary root on a fresh hosted runner, runs the installed sidecar smoke offline, verifies hidden startup/single-instance/crash-lock recovery, uninstalls, checks sign-in launch cleanup, and verifies default profile retention. A green run is installation evidence for that commit, not a signature or publication approval.

Do not attach desktop installers until the target platform pipeline also provides code signing, externally published installer/component checksums, clean-machine install/uninstall tests, a full application SBOM covering Rust/native components, provenance, and complete third-party notices. Build each platform artifact on that platform and keep signing credentials in an environment-protected release job. Pull-request CI must never receive signing or publishing credentials.

If any gate fails after a tag is published, do not silently replace public artifacts. Document the issue, revoke or deprecate the affected release when appropriate, fix it on `main`, and publish a new version.
