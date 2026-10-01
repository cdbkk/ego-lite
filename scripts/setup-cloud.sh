#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) { throw new Error("Node.js 22 or later is required"); }'
cd "$repo_dir/package/ego-browser"
CI=true npm ci
npm run build

printf '%s\n' 'SDK built. Proxy socket tests run with: cd package/ego-proxy && npm test'
printf '%s\n' 'Native ego and Keychain checks require macOS and must not be reported as verified on Linux.'
