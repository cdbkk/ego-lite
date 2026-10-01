# Continue this work in Codex Cloud

Repository: https://github.com/cdbkk/ego-lite

Working branch: `proxy-cloud-work`. This branch contains unfinished proxy work,
not a release. Use the draft PR and its test results as the starting state.

## Environment

Add `cdbkk/ego-lite` to a Codex Cloud environment through your ChatGPT account.
Choose this branch for the task. Use Node.js 22 or later and run
`sh scripts/setup-cloud.sh` to install and build the upstream SDK.

No OpenAI API key, local Codex login file, proxy password, browser profile,
Keychain data, or macOS session belongs in this environment. This setup uses the
account-backed Codex Cloud product; it does not configure an API-funded agent
workflow in GitHub Actions.

## Checks

```sh
cd package/ego-proxy
npm test
```

The socket, validation and encrypted-store checks run on Linux with local
fixtures. The upstream SDK's build, API checks, typecheck and 494 tests passed
locally before this handoff. Its regular command is `npm test` from
`package/ego-browser`.

Native checks use `npm run test:browser` in `package/ego-proxy`. They require
macOS, the installed ego lite app, its CLI wrapper and Keychain. They fail when
these are missing. Linux cloud tasks must report this coverage as unavailable,
not skipped successfully. After the latest HTTP forwarding change, native
integration has not been rerun.

## Current state and remaining work

The companion supports encrypted presets, authenticated HTTP/HTTPS/SOCKS5
upstreams, isolated named headless instances and the fork's SDK via `--sdk-path`.
Earlier native checks passed separate-instance routing, fetch/image resources,
proxy outage blocking, CLI use, real Keychain storage and interruption cleanup.

A WebRTC check initially exposed host ICE candidates despite the command-line
flag. Setting the managed profile's `webrtc.ip_handling_policy` to
`disable_non_proxied_udp` fixed the no-STUN candidate test. This is a narrow test,
not a guarantee of zero network leakage or an operating-system VPN.

The latest change sends ordinary HTTP in absolute form to HTTP/HTTPS upstreams,
so proxies that prohibit CONNECT on port 80 can work. The latest socket run had
23 tests: 20 passed, 2 failed and 1 was cancelled by a timeout. Resolve these
before claiming this branch is ready:

1. WebSocket disconnect coverage expects zero successful connections, but the
   new HTTP upgrade path counts the upstream connection before its 101 response.
   Check the actual upgrade response, including authentication failure, before
   marking it successful. Preserve prompt upstream cancellation.
2. Wrong HTTP credentials count a failure twice when the 407 path and subsequent
   socket error both run. Count each request failure once.
3. The truncated-body regression now passes through the fixture proxy's new
   regular HTTP forwarding path. That fixture does not propagate origin aborts,
   so the downstream test times out. Fix the fixture's abort propagation and
   retain the relay's downstream-abort assertion.

Pending connections now receive client/shutdown cancellation and are tracked at
socket creation. The added raw CONNECT regressions passed prompt disconnect and
relay-close cleanup. Preserve these tests.

## Suggested parallel ownership

- Networking implementation: `relay.mjs` and `test/fixtures.mjs`.
- Regression coverage: `test/adversarial.test.mjs`, `test/relay.test.mjs` and
  `test/tls.test.mjs`; coordinate with the networking owner.
- Security review: read-only `store.mjs`, `browser.mjs` and `cli.mjs`.
- Documentation: `README.md` and this handoff, updated from final evidence.

Keep unrelated upstream APIs intact, preserve others' edits and use current
models. GPT-5.6 Sol and its aliases are excluded. Do not publish a release or
claim native macOS coverage from Linux. Independent Claude review was attempted
locally but could not start because the Claude delegate lane is disabled.
