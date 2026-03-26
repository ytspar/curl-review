# curl-review

Safely inspect and optionally execute `curl | sh` install scripts.

Instead of blindly piping a URL to your shell, `curl-review` downloads the script, lets you view it with syntax highlighting, and optionally runs an AI security review via [Claude Code](https://claude.ai/claude-code) before execution.

## Install

```bash
npm install -g curl-review
```

Or link locally:

```bash
git clone https://github.com/ytspar/curl-review.git
cd curl-review
npm install && npm run build
npm link
```

## Shell Integration (recommended)

The setup script installs two layers of protection:

```bash
# After npm install -g:
bash "$(npm root -g)/curl-review/setup.sh"

# Or from a local clone:
bash setup.sh
```

### Interactive hook (zsh, bash, fish)

Intercepts the Enter key in your interactive shell. When you type a command that pipes `curl` or `wget` into a shell for execution, the hook rewrites it to `curl-review <url>` before it runs. You see the rewritten command and press Enter again to confirm.

Detected patterns:
- `curl -fsSL https://example.com/install.sh | bash`
- `bash <(curl -fsSL https://example.com/install.sh)`
- `wget -qO- https://example.com/setup | sh`
- `bash -c "$(curl -fsSL https://example.com/install.sh)"`

Only commands that pipe downloads into a shell (`sh`, `bash`, `zsh`) are intercepted. Plain `curl` or `wget` usage (API calls, file downloads with `-o`, etc.) is never affected.

### PATH shim (non-interactive)

A `curl` wrapper placed in `~/.local/lib/curl-review/` before the real `curl` in your `PATH`. It catches non-interactive install patterns — when `curl` is called with silent-download flags (`-sSL`, `-fsSL`) and stdout is not a terminal (i.e. piped to a shell). The shim blocks the download and prints instructions to use `curl-review` instead.

Set `CURL_REVIEW_BYPASS=1` to skip the shim when needed.

### Manual setup

To configure either layer by hand instead of using `setup.sh`:

```bash
# Interactive hook — zsh (add to .zshrc):
source "$(npm root -g)/curl-review/shell/hook.zsh"

# Interactive hook — bash (add to .bashrc):
source "$(npm root -g)/curl-review/shell/hook.bash"

# Interactive hook — fish (copy to conf.d):
cp "$(npm root -g)/curl-review/shell/hook.fish" ~/.config/fish/conf.d/curl-review.fish

# PATH shim (add to shell rc, before other PATH entries):
export PATH="$HOME/.local/lib/curl-review:$PATH"
cp "$(npm root -g)/curl-review/shell/shim/curl" ~/.local/lib/curl-review/curl
chmod +x ~/.local/lib/curl-review/curl
```

## Usage

```bash
curl-review https://example.com/install.sh
```

With the original intercepted command (shown in the banner for context):

```bash
curl-review https://example.com/install.sh --original "curl -fsSL https://example.com/install.sh | sh"
```

Non-interactive mode (review then execute):

```bash
curl-review https://example.com/install.sh --execute
```

## Interactive Menu

After downloading, you get an interactive menu:

```
┌─ curl-review ─────────────────────────────────────────────┐
│  Intercepted  curl -fsSL https://example.com/install.sh | sh
│
│  URL          https://example.com/install.sh
│  Size         264 lines (12.4KB)
│  Claude       ✓ ready
└──────────────────────────────────────────────────────────┘

? What would you like to do?
❯ ℹ View script
  🛡️ Security review
  ▶ Execute script (not yet reviewed)
  ✗ Cancel
```

- **View script** — syntax-highlighted via `bat` (falls back to `less`)
- **Security review** — sends the script to Claude for analysis of malicious patterns, privilege escalation, obfuscated code, and unexpected network calls
- **Execute** — runs the script; prompts for confirmation if unreviewed or flagged dangerous
- **Cancel** — exit without running

After a security review, the verdict updates the menu:

- **SAFE** — execute option shows "no issues found"
- **CAUTION** — execute option shows "proceed with caution"
- **DANGEROUS** — execute is blocked unless explicitly confirmed

## Optional Dependencies

- [`bat`](https://github.com/sharkdp/bat) — syntax highlighting (falls back to `less`)
- [`glow`](https://github.com/charmbracelet/glow) — terminal markdown rendering for security review output (falls back to basic ANSI formatting)
- [`claude`](https://claude.ai/claude-code) — AI security review (run `claude /login` to authenticate)

## License

MIT
