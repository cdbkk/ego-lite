# ego-proxy

`ego-proxy` runs JavaScript through the installed macOS ego lite browser using
an authenticated upstream proxy. Each preset has a separate headless browser
instance and persistent profile. This companion uses the SDK fork in this
checkout; the native browser remains closed source.

## Requirements

Use Node.js 22 or later, the installed ego lite app at `/Applications/ego lite.app`,
and the CLI wrapper at `~/.local/bin/ego-quiet`. Complete the app's onboarding
first. The fork SDK must be built at `package/ego-browser/dist/out/index.js`.
The companion has no npm runtime dependencies. Preset storage requires macOS
Keychain and access to its master key.

From the checkout root, build the SDK if needed:

```sh
cd package/ego-browser
npm ci
npm run build
```

The examples below use the installed `ego-proxy` command. Run
`ego-proxy --help` to see its command syntax.

## Add a preset without putting credentials in shell history

In macOS zsh, read the full proxy URL with hidden input, then send it through
stdin. The URL stays out of the command arguments and terminal display.

```zsh
read -rs 'proxy_url?Proxy URL: '
printf '\n'
printf '%s\n' "$proxy_url" | ego-proxy add work
unset proxy_url
```

Supported URL forms are `http://`, `https://`, `socks5://` and `socks5h://`.
For example, enter a URL shaped like
`socks5://USERNAME:PASSWORD@proxy.example:1080` at the hidden prompt. Percent-encode
reserved characters in credentials. A proxy URL cannot contain a path, query
or fragment. Both SOCKS forms send destination names to the upstream for DNS
resolution. HTTP proxies must support CONNECT, including for HTTP destinations.

Preset names start with a lowercase letter and contain at most 48 lowercase
letters, digits or hyphens. Adding an existing name replaces its proxy URL and
keeps its browser profile.

```sh
ego-proxy list
ego-proxy check work
ego-proxy check work https://example.com/
```

`list` prints names only. `check` uses the same loopback relay as browser runs;
it defaults to `https://api.ipify.org?format=json`. It prints status and elapsed
time, plus `exitIp` when the response contains a valid `ip` field. A custom
destination must use HTTP or HTTPS without URL credentials. A successful check
confirms that request, not the provider's wider reliability or anonymity.

## Run a browser script

Scripts use the fork SDK's injected helpers. This stdin example creates a task
Space, opens a page, prints its title and finishes the Space:

```sh
ego-proxy run work --timeout 60 <<'JS'
const task = await taskSpace('Proxy example');
const page = task.page('p1');
await page.goto('https://example.com/');
cliLog(await page.evaluate(() => document.title));
await task.finish({ keep: [] });
JS
```

Use `-e` for an inline script or `--file` for a saved script:

```sh
ego-proxy run work -e 'cliLog("ready")'
ego-proxy run work --file ./browse.js --timeout 300
```

Choose one script source. When neither option is present, the command reads
stdin. `--timeout` limits script execution in seconds, defaults to 120, and
accepts 1 to 86400. Startup has a separate verification timeout. The command
stops its browser instance and relay after success, failure, timeout or a
handled interrupt. Script output goes to stdout; connection counts go to stderr.
Avoid printing secrets from your own scripts.

## Profiles and storage

The default directory is `~/Library/Application Support/ego-proxy`. It contains
encrypted presets in `presets.json` and browser data under `profiles/NAME`.
Proxy URLs use AES-256-GCM encryption with a master key stored in macOS Keychain.
Browser profile data, including cookies created during managed runs, uses the
browser's normal storage and is separate from preset encryption.

Profiles start clean. Setup copies only the installed app's completed-onboarding
flags; it does not copy existing cookies, logins or browser history. Later runs
of the same preset reuse its profile. All Spaces in that instance share its
proxy. Different preset names use separate profiles and can run concurrently;
two runs of the same profile are rejected by a lock. After an unhandled crash,
inspect the owner recorded in `.ego-proxy.lock` before removing a stale lock.

```sh
ego-proxy remove work
```

Removal deletes the encrypted preset and keeps its browser data. Re-adding the
same name reuses that data. Removal also keeps the Keychain master key.

Set `EGO_PROXY_DIRECTORY` to use another preset and profile directory:

```sh
export EGO_PROXY_DIRECTORY="$PWD/.ego-proxy"
ego-proxy list
```

The directory must belong to the current user, have permissions `0700`, and
must not be a symlink. A new directory uses the same Keychain master key.

## Routing limits

Browser page requests use a loopback HTTP relay that opens tunnels only through
the configured upstream. Authentication failure or an unavailable upstream
returns an error; the relay has no direct-network fallback. Startup verifies
the named native service before executing a script, so an onboarding response
or a missing service fails the run.

Managed profiles disable DNS-over-HTTPS and network prediction and set WebRTC
IP handling to `disable_non_proxied_udp`. Browser arguments disable QUIC,
target hostname resolution and Chromium's implicit localhost proxy bypass.
The upstream proxy's own hostname can still use the operating system resolver.
TLS certificate verification remains enabled for HTTPS upstreams and check
destinations. Plain HTTP and SOCKS connections do not encrypt the link to the
proxy, including its authentication exchange.

This is browser page routing, not an operating-system VPN or a guarantee about
every native browser service. Local browser tests cover named-instance routing,
subresources and upstream outage behavior. The WebRTC gate gathers ICE
candidates without a STUN server and observes zero non-relay candidates with
the managed preference; that test does not establish complete leak prevention.
Production proxy providers have not been verified by these local fixtures.

## Development checks

From the checkout root:

```sh
cd package/ego-proxy
npm test
npm run test:browser
```

The browser gate requires the installed app, CLI wrapper and built fork SDK;
missing dependencies fail the check. It uses clean temporary profiles and local
proxy/origin fixtures without importing existing logins. Native integration
checks also exercise macOS Keychain. The tests remove their temporary browser
profiles and fixture servers.
