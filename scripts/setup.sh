#!/usr/bin/env bash
set -euo pipefail

REPO="edulelis/opencode-mcp"
VERSION="${1:-latest}"
INSTALL_DIR="${OPENCODE_MCP_DIR:-$HOME/.opencode-mcp}"

# ── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${CYAN}==>${NC} $*"; }
ok()    { echo -e "${GREEN}  ✓${NC} $*"; }
warn()  { echo -e "${YELLOW}  ⚠${NC} $*"; }
err()   { echo -e "${RED}  ✗${NC} $*"; }

# ── Banner ──────────────────────────────────────────────────────────────────
cat <<'BANNER'
  ┌──────────────────────────────────────┐
  │        opencode-mcp installer        │
  │  MCP bridge between Codex & opencode │
  └──────────────────────────────────────┘
BANNER

# ── Dependencies ────────────────────────────────────────────────────────────
info "Checking dependencies..."

if ! command -v node &>/dev/null; then
  err "Node.js >= 18 is required. Install: https://nodejs.org"
  exit 1
fi

NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then
  err "Node.js >= 18 required, found $(node -v)"
  exit 1
fi
ok "Node.js $(node -v)"

OPENCODE_BIN="${OPENCODE_BIN:-}"
if [ -z "$OPENCODE_BIN" ]; then
  OPENCODE_BIN=$(command -v opencode 2>/dev/null || true)
fi
if [ -z "$OPENCODE_BIN" ]; then
  warn "opencode CLI not found in PATH"
  warn "Install: curl -fsSL https://opencode.ai/install | sh"
  warn "Or set OPENCODE_BIN after install"
else
  ok "opencode: $OPENCODE_BIN"
fi

# ── Resolve version ─────────────────────────────────────────────────────────
if [ "$VERSION" = "latest" ]; then
  info "Resolving latest release..."
  VERSION=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
    | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": "//;s/".*//')
  if [ -z "$VERSION" ]; then
    warn "Could not resolve latest release, falling back to main branch"
    VERSION="main"
  else
    ok "Latest release: $VERSION"
  fi
fi

# ── Determine download URL ──────────────────────────────────────────────────
if echo "$VERSION" | grep -qE '^v?[0-9]+\.[0-9]+\.[0-9]+'; then
  # Release version — download zip from release assets or tarball
  ZIP_URL="https://github.com/$REPO/releases/download/$VERSION/opencode-mcp-$VERSION.zip"
  TAR_URL="https://github.com/$REPO/archive/refs/tags/$VERSION.tar.gz"
  IS_RELEASE=true
else
  # Branch — use tarball
  TAR_URL="https://github.com/$REPO/archive/refs/heads/$VERSION.tar.gz"
  IS_RELEASE=false
fi

# ── Download ────────────────────────────────────────────────────────────────
info "Downloading opencode-mcp $VERSION ..."
mkdir -p "$INSTALL_DIR"
TMP_DIR=$(mktemp -d)
trap "rm -rf $TMP_DIR" EXIT

# Try zip first (release), then fall back to tarball
DOWNLOADED=false
if [ "$IS_RELEASE" = true ]; then
  if curl -fsSL "$ZIP_URL" -o "$TMP_DIR/release.zip" 2>/dev/null; then
    ok "Downloaded release zip ($VERSION)"
    cd "$TMP_DIR" && unzip -q release.zip
    # The zip contains a top-level dir like opencode-mcp/
    cp -r "$TMP_DIR"/opencode-mcp/* "$INSTALL_DIR/"
    DOWNLOADED=true
  fi
fi

if [ "$DOWNLOADED" = false ]; then
  info "Downloading tarball from $VERSION ..."
  curl -fsSL "$TAR_URL" -o "$TMP_DIR/release.tar.gz"
  cd "$TMP_DIR" && tar xzf release.tar.gz
  # The tarball has a top-level dir like opencode-mcp-4.1.0/
  EXTRACTED_DIR=$(ls -d "$TMP_DIR"/*/ 2>/dev/null | head -1)
  if [ -n "$EXTRACTED_DIR" ]; then
    cp -r "$EXTRACTED_DIR"* "$INSTALL_DIR/"
    DOWNLOADED=true
  fi
fi

if [ "$DOWNLOADED" = false ]; then
  err "Failed to download opencode-mcp"
  err "Try: git clone https://github.com/$REPO.git"
  exit 1
fi

chmod +x "$INSTALL_DIR/src/index.mjs" 2>/dev/null || true
ok "Installed to $INSTALL_DIR"

# ── Verify ──────────────────────────────────────────────────────────────────
if [ -f "$INSTALL_DIR/src/index.mjs" ]; then
  ok "Server file: $INSTALL_DIR/src/index.mjs ($(wc -c < "$INSTALL_DIR/src/index.mjs") bytes)"
else
  err "Server file not found — install may be incomplete"
  ls -la "$INSTALL_DIR/"
  exit 1
fi

# ── Next steps ──────────────────────────────────────────────────────────────
echo ""
info "Installation complete!"
echo ""
echo "  ${GREEN}Register with Codex:${NC}"
echo "    codex mcp add opencode-mcp -- node $INSTALL_DIR/src/index.mjs"
echo ""
echo "  ${GREEN}Register with Claude Desktop:${NC}"
echo '    Add to claude_desktop_config.json:'
echo '    { "mcpServers": { "opencode-mcp": {'
echo "      \"command\": \"node\","
echo "      \"args\": [\"$INSTALL_DIR/src/index.mjs\"]"
echo '    } } }'
echo ""
echo "  ${GREEN}Quick test:${NC}"
echo "    printf '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{}}' | node $INSTALL_DIR/src/index.mjs"
echo ""
echo "  ${YELLOW}Need verbose logs?${NC}"
echo "    export DEBUG=1"
echo ""
echo "  ${YELLOW}Custom opencode binary?${NC}"
echo "    export OPENCODE_BIN=/path/to/opencode"
