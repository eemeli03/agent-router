#!/bin/bash
set -euo pipefail
umask 077
BA_ORIGIN='__ORIGIN__'
BA_TICKET='__TICKET__'
BA_ARCHIVE_SHA='__ARCHIVE_SHA__'
BASE="$HOME/.agent-router"
mkdir -p "$BASE/downloads"
WORK=$(mktemp -d "$BASE/downloads/setup.XXXXXX")
case "$(uname -s)-$(uname -m)" in
 Darwin-arm64) NODE_FILE=node-v26.0.0-darwin-arm64.tar.gz; NODE_SHA=dcee8564c1a9342f9594dd5e52d533894dfef6b85aa771bbbb870baa3c403235 ;;
 Darwin-x86_64) NODE_FILE=node-v26.0.0-darwin-x64.tar.gz; NODE_SHA=f488ab543fe202d8a2d56e661682117d3c56903a2bf64f2ec1ff7bd421cfd875 ;;
 *) echo 'This connector currently supports macOS.'; exit 1 ;;
esac
printf 'Connecting your own account with Agent Router...\n'
curl --fail --silent --show-error --proto '=https' --tlsv1.2 "https://nodejs.org/dist/v26.0.0/$NODE_FILE" -o "$WORK/node.tar"
verify(){ actual=$(shasum -a 256 "$1" | awk '{print $1}'); test "$actual" = "$2" || { echo 'Download verification failed'; exit 1; }; }
verify "$WORK/node.tar" "$NODE_SHA"
tar -xf "$WORK/node.tar" -C "$WORK"
NODE="$WORK/${NODE_FILE%.tar.*}/bin/node"
curl --fail --silent --show-error --proto '=https' --tlsv1.2 -H "X-Ba-Setup-Ticket: $BA_TICKET" "$BA_ORIGIN/downloads/agent-router-connector.tar.gz" -o "$WORK/connector.tar.gz"
verify "$WORK/connector.tar.gz" "$BA_ARCHIVE_SHA"
tar -xzf "$WORK/connector.tar.gz" -C "$WORK"
read -r -p 'Workspace directory (absolute path): ' workspace
"$NODE" "$WORK/setup.mjs" --origin "$BA_ORIGIN" --ticket "$BA_TICKET" --workspace "$workspace"
printf '\nYou can close this window.\n'
