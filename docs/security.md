# Security and threat model

## Assets and trust boundary

The dedicated persistent browser profile is the highest-value asset because it contains a user-owned authenticated web session. The local API token, prompts, visible responses, and opt-in screenshots are sensitive. ChatGPT.com and local callers are outside the process trust boundary; other processes running as the same OS user are a partially trusted local threat.

## Threats and mitigations

| Threat                         | Impact                                            | Mitigations and residual risk                                                                                                                                                                                                                     |
| ------------------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exposed DevTools port          | Full browser/session control                      | Direct Playwright uses private transport. GPM mode accepts only a returned `ws://` loopback endpoint and never logs it. GPM owns the unauthenticated port, so malicious same-user processes remain a material residual risk.                      |
| Stolen persistent profile      | Session takeover                                  | Dedicated path inside data directory, gitignore, restrictive directory mode where honored, no export APIs. Disk malware/backups can still steal it; use OS disk encryption and account permissions.                                               |
| Malicious local process        | Unauthorized prompts/session use                  | Random 256-bit local bearer token and timing-safe SHA-256 digest comparison. Same-user malware may read the token/profile or inject browser input; this cannot be fully prevented in-process.                                                     |
| Prompt/response leakage        | Private data disclosure                           | Bodies/content are never logged or stored; metadata is content-free and bounded. Debug screenshots are opt-in and sensitive. ChatGPT itself necessarily receives prompts.                                                                         |
| Accidental LAN exposure        | Remote API access                                 | Startup accepts exactly `127.0.0.1` or `::1`; `localhost`, wildcard, and LAN addresses are rejected and tested. No trust-proxy behavior. Host firewall remains defense-in-depth.                                                                  |
| Log leakage                    | Token or conversation disclosure                  | Pino redacts authorization/token/cookie/body/prompt/response paths; request serializer allowlists ID/method/URL; exceptions expose safe messages only. Avoid passing nested arbitrary objects to logs in future code.                             |
| Path traversal/default profile | Overwrite or disclosure of unrelated browser data | Profile must resolve inside a non-root data directory; known default browser profile fragments are rejected. Symlink/reparse-point attacks by a malicious same-user process remain a residual risk.                                               |
| Request flooding               | Memory/browser exhaustion                         | Body limit, bounded queue, one concurrent UI operation, request timeout, 429 queue-full response. A local attacker can still consume CPU/network within those bounds.                                                                             |
| Browser tab contamination      | Cross-request context leakage                     | Each request navigates a fresh tab, records a response-node baseline, and closes in `finally`; queue concurrency is one. ChatGPT account-level memories/custom instructions remain account behavior and cannot be isolated by a new conversation. |
| Challenge/rate-limit bypass    | Account/security policy violation                 | State is detected and surfaced; no CAPTCHA/Cloudflare automation, stealth, spoofing, infinite retry, quota rotation, or private endpoint calls.                                                                                                   |

GPM Login is an optional, higher-risk backend. tab2api restricts itself to one configured profile and does not use GPM's proxy, fingerprint, group, extension, or profile-creation APIs. Operators must understand that GPM's separate loopback API and debugging port are not authenticated by tab2api; any malicious process running as the same OS user may attempt to access them.

## Secret handling

If `TAB2API_API_TOKEN` is absent, `.tab2api/api-token` is created with cryptographically secure randomness and mode `0600` where supported; the runtime directory requests `0700`. Windows ACL inheritance may not map Unix modes exactly. The token value is never printed. Email, password, cookies, access/refresh tokens, localStorage, and authorization headers are never requested, extracted, exported, or logged.

The repository ignores `.env`, `.tab2api/`, runtime/profile/artifact directories, logs, screenshots, HARs, traces, and archives. Test fixtures contain no real secrets.

## Operator rules

- Run only on a trusted personal machine and user account.
- Never publish port 3210, reverse-proxy it, or weaken host validation.
- Never share the data directory or debug artifacts.
- Complete login/challenges manually only in the headed dedicated browser.
- If compromise is suspected, close tab2api, sign out/revoke the ChatGPT session through normal account controls, delete the dedicated profile manually, and allow tab2api to generate a new local API token.
