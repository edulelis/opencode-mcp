#!/usr/bin/env bash
set -euo pipefail

REPO="edulelis/opencode-mcp"
INSTALL_DIR="${OPENCODE_MCP_DIR:-$HOME/.opencode-mcp}"
FORCE="${OPENCODE_MCP_FORCE:-0}"
VERSION="latest"

usage() {
  cat <<EOF
Usage: setup.sh [version|branch] [--force]

Installs or updates opencode-mcp in one path.

Environment:
  OPENCODE_MCP_DIR                Install directory (default: \$HOME/.opencode-mcp)
  OPENCODE_MCP_FORCE=1            Reinstall even when the target version is already installed
  OPENCODE_MCP_CODEX_BRIDGE_PATH  Optional extra copied bridge path to sync after install
  OPENCODE_BIN                    Optional opencode binary path hint printed for users
EOF
}

for arg in "$@"; do
  case "$arg" in
    --force|-f)
      FORCE=1
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      VERSION="$arg"
      ;;
  esac
done

# ── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${CYAN}==>${NC} $*"; }
ok()    { echo -e "${GREEN}  ✓${NC} $*"; }
warn()  { echo -e "${YELLOW}  ⚠${NC} $*"; }
err()   { echo -e "${RED}  ✗${NC} $*"; }

normalize_version() {
  echo "$1" | sed 's/^v//'
}

read_installed_version() {
  if [ -f "$INSTALL_DIR/package.json" ]; then
    sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$INSTALL_DIR/package.json" | head -1
    return
  fi
  if [ -f "$INSTALL_DIR/src/index.mjs" ]; then
    sed -n 's/.*const VERSION = "\([^"]*\)".*/\1/p' "$INSTALL_DIR/src/index.mjs" | head -1
  fi
}

print_next_steps() {
  echo ""
  info "$1"
  echo ""
  echo -e "  ${GREEN}Register with Codex:${NC}"
  echo "    codex mcp add opencode-mcp -- node $INSTALL_DIR/src/index.mjs"
  echo ""
  echo -e "  ${GREEN}Register with Claude Desktop:${NC}"
  echo '    Add to claude_desktop_config.json:'
  echo '    { "mcpServers": { "opencode-mcp": {'
  echo "      \"command\": \"node\","
  echo "      \"args\": [\"$INSTALL_DIR/src/index.mjs\"]"
  echo '    } } }'
  echo ""
  echo -e "  ${GREEN}Quick test:${NC}"
  echo "    printf '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{}}' | node $INSTALL_DIR/src/index.mjs"
  echo ""
  echo -e "  ${YELLOW}Need verbose logs?${NC}"
  echo "    export DEBUG=1"
  echo ""
  echo -e "  ${YELLOW}Custom opencode binary?${NC}"
  echo "    export OPENCODE_BIN=/path/to/opencode"
  echo ""
  echo -e "  ${YELLOW}After updating an MCP server:${NC}"
  echo "    Restart or reload your MCP client so it sees new tools and schemas."
}

sync_copied_bridge() {
  if [ -z "${OPENCODE_MCP_CODEX_BRIDGE_PATH:-}" ]; then
    return
  fi

  if [ ! -f "$INSTALL_DIR/src/index.mjs" ]; then
    err "Cannot sync copied bridge because $INSTALL_DIR/src/index.mjs was not found"
    exit 1
  fi

  info "Syncing copied bridge to $OPENCODE_MCP_CODEX_BRIDGE_PATH"
  mkdir -p "$(dirname "$OPENCODE_MCP_CODEX_BRIDGE_PATH")"
  cp "$INSTALL_DIR/src/index.mjs" "$OPENCODE_MCP_CODEX_BRIDGE_PATH"
  chmod +x "$OPENCODE_MCP_CODEX_BRIDGE_PATH" 2>/dev/null || true
  ok "Copied bridge synced"
}

# ── Banner ──────────────────────────────────────────────────────────────────
cat <<'BANNER'
  ┌──────────────────────────────────────┐
  │        opencode-mcp installer        │
  │  install or update in the same path  │
  └──────────────────────────────────────┘
BANNER

# ── Dependencies ────────────────────────────────────────────────────────────
info "Checking dependencies..."

if ! command -v curl &>/dev/null; then
  err "curl is required to download opencode-mcp"
  exit 1
fi
ok "curl: $(command -v curl)"

if ! command -v tar &>/dev/null; then
  err "tar is required to extract fallback release archives"
  exit 1
fi
ok "tar: $(command -v tar)"

HAS_UNZIP=0
if command -v unzip &>/dev/null; then
  HAS_UNZIP=1
  ok "unzip: $(command -v unzip)"
else
  warn "unzip not found; release zip download will be skipped and tarball fallback will be used"
fi

NODE_OK=0
if ! command -v node &>/dev/null; then
  warn "Node.js >= 24 is required to run opencode-mcp, but node was not found"
  warn "Install Node.js >= 24 before starting the MCP server"
else
  NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VER" -lt 24 ]; then
    warn "Node.js >= 24 is required to run opencode-mcp; found $(node -v)"
    warn "Install Node.js >= 24 before starting the MCP server"
  else
    NODE_OK=1
    ok "Node.js $(node -v)"
  fi
fi

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
  if ! echo "$VERSION" | grep -q '^v'; then
    VERSION="v$VERSION"
  fi
  # Release version — download zip from release assets or tarball
  ZIP_URL="https://github.com/$REPO/releases/download/$VERSION/opencode-mcp-$VERSION.zip"
  TAR_URL="https://github.com/$REPO/archive/refs/tags/$VERSION.tar.gz"
  IS_RELEASE=true
else
  # Branch — use tarball
  TAR_URL="https://github.com/$REPO/archive/refs/heads/$VERSION.tar.gz"
  IS_RELEASE=false
fi

CURRENT_VERSION=$(read_installed_version || true)
if [ -n "$CURRENT_VERSION" ]; then
  ok "Current install: $CURRENT_VERSION at $INSTALL_DIR"
else
  info "No existing install detected at $INSTALL_DIR"
fi

if [ "$IS_RELEASE" = true ] && [ "$FORCE" != "1" ] && [ -n "$CURRENT_VERSION" ] \
  && [ "$(normalize_version "$CURRENT_VERSION")" = "$(normalize_version "$VERSION")" ]; then
  ok "opencode-mcp $VERSION is already installed"
  sync_copied_bridge
  print_next_steps "No update needed. Use --force or OPENCODE_MCP_FORCE=1 to reinstall."
  exit 0
fi

# ── Download ────────────────────────────────────────────────────────────────
info "Downloading opencode-mcp $VERSION ..."
TMP_DIR=$(mktemp -d)
trap "rm -rf $TMP_DIR" EXIT
EXTRACT_DIR="$TMP_DIR/extract"
mkdir -p "$EXTRACT_DIR"

# Try zip first (release), then fall back to tarball
DOWNLOADED=false
if [ "$IS_RELEASE" = true ] && [ "$HAS_UNZIP" = "1" ]; then
  if curl -fsSL "$ZIP_URL" -o "$TMP_DIR/release.zip" 2>/dev/null; then
    ok "Downloaded release zip ($VERSION)"
    unzip -q "$TMP_DIR/release.zip" -d "$EXTRACT_DIR"
    DOWNLOADED=true
  fi
fi

if [ "$DOWNLOADED" = false ]; then
  info "Downloading tarball from $VERSION ..."
  curl -fsSL "$TAR_URL" -o "$TMP_DIR/release.tar.gz"
  tar xzf "$TMP_DIR/release.tar.gz" -C "$EXTRACT_DIR"
  DOWNLOADED=true
fi

EXTRACTED_DIR=$(find "$EXTRACT_DIR" -mindepth 1 -maxdepth 1 -type d | head -1)
if [ "$DOWNLOADED" = false ] || [ -z "$EXTRACTED_DIR" ] || [ ! -f "$EXTRACTED_DIR/src/index.mjs" ]; then
  err "Failed to download opencode-mcp"
  err "Try: git clone https://github.com/$REPO.git"
  exit 1
fi

BACKUP_DIR=""
STATE_BACKUP=""
ACTION="Installed"
if [ -e "$INSTALL_DIR" ] || [ -L "$INSTALL_DIR" ]; then
  ACTION="Updated"
  if [ -d "$INSTALL_DIR/state" ]; then
    STATE_BACKUP="$TMP_DIR/state-preserve"
    info "Preserving durable job state from $INSTALL_DIR/state"
    mkdir -p "$STATE_BACKUP"
    cp -R "$INSTALL_DIR/state"/. "$STATE_BACKUP"/
  fi
  BACKUP_DIR="${INSTALL_DIR}.bak.$(date +%Y%m%d%H%M%S).$$"
  info "Backing up existing install to $BACKUP_DIR"
  mv "$INSTALL_DIR" "$BACKUP_DIR"
fi

mkdir -p "$(dirname "$INSTALL_DIR")"
mkdir -p "$INSTALL_DIR"
set +e
cp -R "$EXTRACTED_DIR"/. "$INSTALL_DIR"/
COPY_STATUS=$?
set -e

if [ "$COPY_STATUS" -ne 0 ]; then
  err "Install copy failed"
  rm -rf "$INSTALL_DIR"
  if [ -n "$BACKUP_DIR" ] && [ -e "$BACKUP_DIR" ]; then
    warn "Restoring backup from $BACKUP_DIR"
    mv "$BACKUP_DIR" "$INSTALL_DIR"
  fi
  exit 1
fi

if [ -n "$STATE_BACKUP" ] && [ -d "$STATE_BACKUP" ]; then
  mkdir -p "$INSTALL_DIR/state"
  cp -R "$STATE_BACKUP"/. "$INSTALL_DIR/state"/
  ok "Durable job state preserved"
fi

chmod +x "$INSTALL_DIR/src/index.mjs" 2>/dev/null || true
ok "$ACTION to $INSTALL_DIR"
if [ -n "$BACKUP_DIR" ]; then
  ok "Backup kept at $BACKUP_DIR"
fi

# ── Verify ──────────────────────────────────────────────────────────────────
if [ -f "$INSTALL_DIR/src/index.mjs" ]; then
  ok "Server file: $INSTALL_DIR/src/index.mjs ($(wc -c < "$INSTALL_DIR/src/index.mjs") bytes)"
else
  err "Server file not found — install may be incomplete"
  ls -la "$INSTALL_DIR/"
  exit 1
fi

INSTALLED_VERSION=$(read_installed_version || true)
if [ -n "$INSTALLED_VERSION" ]; then
  ok "Installed version: $INSTALLED_VERSION"
fi

if [ "$IS_RELEASE" = true ] && [ -n "$INSTALLED_VERSION" ] \
  && [ "$(normalize_version "$INSTALLED_VERSION")" != "$(normalize_version "$VERSION")" ]; then
  err "Installed version $INSTALLED_VERSION does not match requested $VERSION"
  exit 1
fi

if [ "$NODE_OK" = "1" ]; then
  node --check "$INSTALL_DIR/src/index.mjs" >/dev/null
  ok "Server syntax check passed"
else
  warn "Skipped server syntax check because Node.js >= 24 is not active"
fi

sync_copied_bridge

# ── Next steps ──────────────────────────────────────────────────────────────
print_next_steps "Installation complete!"
