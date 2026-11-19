#!/bin/bash
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "$0")" && pwd)"
# Use a supported runtime already available to the installed agent, never download one here.
for candidate in "${AGENT_ROUTER_NODE:-}" "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node" "$HOME/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node" "$(command -v node || true)"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ] && "$candidate" -e 'process.exit(Number(process.versions.node.split(".")[0])>=24?0:1)' 2>/dev/null; then
    exec "$candidate" "$ROOT/setup.mjs" "$@"
  fi
done
# Standalone Claude Code need not install Node separately. This runtime is private
# to Agent Router; it does not replace system Node or any provider binary.
case "$(uname -s)-$(uname -m)" in
 Darwin-arm64) NODE_FILE=node-v26.0.0-darwin-arm64.tar.gz; NODE_SHA=dcee8564c1a9342f9594dd5e52d533894dfef6b85aa771bbbb870baa3c403235 ;;
 Darwin-x86_64) NODE_FILE=node-v26.0.0-darwin-x64.tar.gz; NODE_SHA=f488ab543fe202d8a2d56e661682117d3c56903a2bf64f2ec1ff7bd421cfd875 ;;
 *) printf 'Agent Router currently supports macOS.\n' >&2; exit 1 ;;
esac
mkdir -p "$HOME/.agent-router/runtimes"
WORK=$(mktemp -d "$HOME/.agent-router/runtimes/node.XXXXXX")
printf 'Preparing the private Agent Router runtime…\n'
curl --fail --silent --show-error --proto '=https' --tlsv1.2 "https://nodejs.org/dist/v26.0.0/$NODE_FILE" -o "$WORK/node.tar.gz"
ACTUAL=$(shasum -a 256 "$WORK/node.tar.gz" | awk '{print $1}')
if [ "$ACTUAL" != "$NODE_SHA" ]; then printf 'Runtime checksum mismatch. Setup stopped.\n' >&2; exit 1; fi
tar -xzf "$WORK/node.tar.gz" -C "$WORK"
exec "$WORK/${NODE_FILE%.tar.*}/bin/node" "$ROOT/setup.mjs" "$@"
