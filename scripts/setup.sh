#!/usr/bin/env bash
set -euo pipefail

REPO="edulelis/opencode-mcp"
BRANCH="main"
INSTALL_DIR="${OPENCODE_BRIDGE_DIR:-$HOME/.opencode-mcp}"

echo "==> opencode-mcp installer"
echo "    Installing to: $INSTALL_DIR"

# Check dependencies
if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js >= 18 is required"
  exit 1
fi

NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then
  echo "ERROR: Node.js >= 18 required, found $(node -v)"
  exit 1
fi

if ! command -v opencode &>/dev/null; then
  echo "WARNING: opencode CLI not found in PATH"
  echo "  Install: curl -fsSL https://opencode.ai/install | sh"
  echo "  Or set OPENCODE_BIN env var after installation"
fi

# Download
mkdir -p "$INSTALL_DIR/src" "$INSTALL_DIR/scripts"

echo "==> Downloading bridge..."
for file in src/index.mjs scripts/setup.sh README.md ARCHITECTURE.md AGENTS.md GUIDE.md CONTRIBUTING.md CHANGELOG.md package.json; do
  url="https://raw.githubusercontent.com/$REPO/$BRANCH/$file"
  echo "    $file"
  curl -fsSL "$url" -o "$INSTALL_DIR/$file" 2>/dev/null || echo "    (skipped — $file not found)"
done

chmod +x "$INSTALL_DIR/src/index.mjs" 2>/dev/null || true

echo ""
echo "==> Installation complete!"
echo ""
echo "    Register with Codex:"
echo "      codex mcp add opencode-mcp -- node $INSTALL_DIR/src/index.mjs"
echo ""
echo "    Or run directly:"
echo "      node $INSTALL_DIR/src/index.mjs"
echo ""
echo "    Set DEBUG=1 for verbose logs."
echo "    Set OPENCODE_BIN if opencode is in a non-standard location."
