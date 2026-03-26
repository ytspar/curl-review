#!/usr/bin/env bash
# curl-review setup script
# Installs curl-review and configures shell hooks for zsh, bash, or fish
set -euo pipefail

BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[32m'
YELLOW='\033[33m'
CYAN='\033[36m'
RESET='\033[0m'

info()  { printf "  ${CYAN}▸${RESET} %s\n" "$1"; }
ok()    { printf "  ${GREEN}✓${RESET} %s\n" "$1"; }
warn()  { printf "  ${YELLOW}!${RESET} %s\n" "$1"; }

echo ""
printf "  ${BOLD}curl-review${RESET} ${DIM}— setup${RESET}\n"
echo ""

# ── Step 1: Check for Node.js ────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  warn "Node.js is required but not installed."
  warn "Install it from https://nodejs.org or via your package manager."
  exit 1
fi
ok "Node.js $(node -v)"

# ── Step 2: Install curl-review via npm ──────────────────────────────────────
if command -v curl-review &>/dev/null; then
  ok "curl-review already installed ($(curl-review --version 2>/dev/null || echo 'unknown version'))"
else
  info "Installing curl-review..."
  npm install -g curl-review
  ok "curl-review installed"
fi

# ── Step 3: Locate hook files ────────────────────────────────────────────────
HOOK_DIR=""

# Prefer the script's own directory (for local dev / git clone installs)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -d "${SCRIPT_DIR}/shell" ]]; then
  HOOK_DIR="${SCRIPT_DIR}/shell"
fi

# Fall back to npm global root
if [[ -z "$HOOK_DIR" ]]; then
  NPM_ROOT="$(npm root -g 2>/dev/null || true)"
  if [[ -d "${NPM_ROOT}/curl-review/shell" ]]; then
    HOOK_DIR="${NPM_ROOT}/curl-review/shell"
  fi
fi

if [[ -z "$HOOK_DIR" ]]; then
  warn "Could not locate shell/ directory — shell integration skipped."
  warn "You can source the hook manually from the curl-review install."
  exit 0
fi

ok "Found hooks: ${HOOK_DIR}"

# ── Step 4: Detect shell and install hook ────────────────────────────────────
SHELL_NAME="$(basename "${SHELL:-/bin/sh}")"

case "$SHELL_NAME" in
  zsh)
    RC_FILE="${ZDOTDIR:-$HOME}/.zshrc"
    HOOK_FILE="${HOOK_DIR}/hook.zsh"
    MARKER="curl-review/shell/hook.zsh"
    SOURCE_LINE="source \"${HOOK_FILE}\"  # curl-review: intercept install commands"
    ;;
  bash)
    RC_FILE="$HOME/.bashrc"
    HOOK_FILE="${HOOK_DIR}/hook.bash"
    MARKER="curl-review/shell/hook.bash"
    SOURCE_LINE="source \"${HOOK_FILE}\"  # curl-review: intercept install commands"
    ;;
  fish)
    FISH_CONF_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d"
    HOOK_FILE="${HOOK_DIR}/hook.fish"
    MARKER=""  # fish uses conf.d, no rc marker needed
    ;;
  *)
    warn "Unsupported shell: ${SHELL_NAME}"
    warn "curl-review hooks are available for zsh, bash, and fish."
    warn "You can still use curl-review manually: curl-review <url>"
    exit 0
    ;;
esac

if [[ ! -f "$HOOK_FILE" ]]; then
  warn "Hook file not found: ${HOOK_FILE}"
  warn "You can still use curl-review manually: curl-review <url>"
  exit 0
fi

if [[ "$SHELL_NAME" = "fish" ]]; then
  # Fish: copy hook to conf.d
  mkdir -p "$FISH_CONF_DIR"
  DEST="${FISH_CONF_DIR}/curl-review.fish"
  if [[ -f "$DEST" ]]; then
    ok "Fish hook already installed at ${DEST}"
  else
    cp "$HOOK_FILE" "$DEST"
    ok "Installed hook to ${DEST}"
  fi
else
  # Bash/Zsh: add source line to rc file
  if [[ -f "$RC_FILE" ]] && grep -qF "$MARKER" "$RC_FILE"; then
    ok "Shell hook already in ${RC_FILE}"
  else
    printf "\n# curl-review shell integration\n%s\n" "$SOURCE_LINE" >> "$RC_FILE"
    ok "Added shell hook to ${RC_FILE}"
  fi
fi

# ── Step 5: Install PATH shim (non-interactive protection) ───────────────────
SHIM_DIR="$HOME/.local/lib/curl-review"
SHIM_SRC="${HOOK_DIR}/shim/curl"

if [[ -f "$SHIM_SRC" ]]; then
  mkdir -p "$SHIM_DIR"
  if [[ -f "${SHIM_DIR}/curl" ]]; then
    ok "PATH shim already installed at ${SHIM_DIR}/curl"
  else
    cp "$SHIM_SRC" "${SHIM_DIR}/curl"
    chmod +x "${SHIM_DIR}/curl"
    ok "Installed PATH shim to ${SHIM_DIR}/curl"
  fi

  # Add shim to PATH in rc file if not already present
  PATH_LINE="export PATH=\"${SHIM_DIR}:\$PATH\"  # curl-review: shim for non-interactive protection"
  case "$SHELL_NAME" in
    fish)
      FISH_PATH_LINE="fish_add_path --prepend ${SHIM_DIR}  # curl-review shim"
      if [[ -f "$DEST" ]] && grep -qF "fish_add_path" "$DEST" 2>/dev/null; then
        ok "PATH shim already in fish config"
      else
        # Append to the hook.fish conf.d file
        printf "\n%s\n" "$FISH_PATH_LINE" >> "$DEST"
        ok "Added PATH shim to fish config"
      fi
      ;;
    *)
      if [[ -f "$RC_FILE" ]] && grep -qF "curl-review" "$RC_FILE" && grep -qF "$SHIM_DIR" "$RC_FILE"; then
        ok "PATH shim already in ${RC_FILE}"
      else
        # Append PATH line (the hook does not depend on the shim)
        printf "%s\n" "$PATH_LINE" >> "$RC_FILE"
        ok "Added PATH shim to ${RC_FILE}"
      fi
      ;;
  esac
else
  warn "PATH shim not found — non-interactive protection skipped"
fi

# ── Step 6: Check optional deps ─────────────────────────────────────────────
echo ""
printf "  ${BOLD}Optional dependencies:${RESET}\n"

for dep in bat glow claude; do
  if command -v "$dep" &>/dev/null; then
    ok "$dep"
  else
    case "$dep" in
      bat)    warn "bat — install for syntax highlighting (brew install bat)" ;;
      glow)   warn "glow — install for markdown rendering (brew install glow)" ;;
      claude) warn "claude — install for AI security review (npm i -g @anthropic-ai/claude-code)" ;;
    esac
  fi
done

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
printf "  ${GREEN}${BOLD}Done!${RESET} "
if [[ "$SHELL_NAME" = "fish" ]]; then
  printf "Restart your shell to activate.\n"
else
  printf "Restart your shell or run:\n"
  printf "    ${DIM}source ${RC_FILE}${RESET}\n"
fi
echo ""
printf "  The hook will intercept ${BOLD}curl|bash${RESET} install patterns and\n"
printf "  redirect them through curl-review for inspection.\n"
echo ""
printf "  Try it: ${DIM}curl -fsSL https://example.com/install.sh | bash${RESET}\n"
echo ""
