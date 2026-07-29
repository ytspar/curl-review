# curl-review

Safely inspect and optionally execute `curl | sh` install scripts.

Instead of blindly piping a URL to your shell, `curl-review` downloads the script, lets you view it with syntax highlighting, and optionally runs an AI security review before execution.

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

### Non-interactive modes

The default interactive menu needs a TTY. For CI, scripts, or anywhere without
one, use a flag that decides on its own:

```bash
curl-review <url> --review    # review only, never execute — verdict in exit code
curl-review <url> --execute   # review, then execute unless DANGEROUS
curl-review <url> --yes       # execute only if SAFE
```

| Exit | Meaning |
| --- | --- |
| `0` | SAFE (or, for `--execute`/`--yes`, the script ran and succeeded) |
| `1` | DANGEROUS — never executed |
| `2` | CAUTION (`--review`), or verdict not SAFE (`--yes`) |
| `3` | No verdict — every reviewer failed |

All three fail closed: if no reviewer produces a verdict, the script is **not** run.

## Reviewers

The security review runs through a locally installed agent CLI. They are tried in
order until one answers, so a logged-out or rate-limited primary doesn't block the
review:

| Order | CLI | Install | Authenticate |
| --- | --- | --- | --- |
| 1 | [`claude`](https://claude.ai/claude-code) | `npm i -g @anthropic-ai/claude-code` | `claude /login` |
| 2 | [`codex`](https://github.com/openai/codex) | `npm i -g @openai/codex` | `codex login` |
| 3 | [`kimi`](https://moonshotai.github.io/kimi-code/) | `npm i -g @moonshot-ai/kimi-code` | `kimi login` |

Each reviewer runs sandboxed and without project context — the script under review
is untrusted input, so the agent gets no tools it could be talked into using, and
no CLAUDE.md/MCP/hook configuration from the directory you happen to be in.

Claude and Codex stream the script over stdin. Kimi's prompt mode ignores stdin, so
the script travels in the prompt argument, which caps it at 120 KB; larger scripts
report `script too large` for Kimi rather than being silently truncated and reviewed
in part.

Choose or reorder reviewers:

```bash
curl-review <url> --provider codex          # only codex
curl-review <url> --provider codex,claude   # codex first, claude as backup
export CURL_REVIEW_PROVIDERS=codex,claude   # same, persistently
```

### Checking your reviewers

`claude auth status` reports a live session even when the stored token can no
longer be refreshed, so a reviewer can look configured and still fail every
request. `doctor` sends each one a real one-word prompt and reports what
actually works:

```bash
curl-review doctor                    # check all reviewers
curl-review doctor --provider kimi    # check one
```

```
  ✓ Claude   ok · 4.4s
  ✓ Codex    ok · 9.9s
  ✓ Kimi     ok · 7.1s

  3 of 3 reviewer(s) working.
```

Exits `0` if at least one reviewer answered, `1` if none did.

### When a review fails

Every failure names the reviewer, the reason, and the fix:

```
  ✗  Security review failed
  ────────────────────────────────────────────────────────
  Claude   authentication · exit 1 · 1.6s
           Failed to authenticate: OAuth session expired and could not be
           refreshed (HTTP 401)
           → claude /login
  Codex    usage limit · exit 1 · 4.2s
           stream error: exceeded retry limit, last status: 429
           → wait for the limit to reset, or try another provider
  Kimi     not installed
           → uv tool install kimi-cli
  ────────────────────────────────────────────────────────
  Full output: ~/.cache/curl-review/last-error.log
```

Full stdout/stderr of every attempt is always written to
`~/.cache/curl-review/last-error.log`. Add `--debug` (or `CURL_REVIEW_DEBUG=1`) to
print it inline instead.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `CURL_REVIEW_PROVIDERS` | Comma-separated reviewer order (default `claude,codex,kimi`) |
| `CURL_REVIEW_TIMEOUT` | Per-reviewer timeout in seconds (default `180`) |
| `CURL_REVIEW_DEBUG` | Set to `1` to always print full reviewer output on failure |
| `CURL_REVIEW_BYPASS` | Set to `1` to skip the PATH shim |

## Interactive Menu

After downloading, you get an interactive menu:

```
┌─ curl-review ─────────────────────────────────────────────┐
│  Intercepted  curl -fsSL https://example.com/install.sh | sh
│
│  URL          https://example.com/install.sh
│  Size         264 lines (12.4KB)
│  Reviewer     Claude → Codex → Kimi (not installed)
└──────────────────────────────────────────────────────────┘

? What would you like to do?
❯ ℹ View script
  🛡️ Security review
  ▶ Execute script (not yet reviewed)
  ✗ Cancel
```

- **View script** — syntax-highlighted via `bat` (falls back to `less`)
- **Security review** — sends the script to the first available reviewer for analysis of malicious patterns, privilege escalation, obfuscated code, and unexpected network calls
- **Execute** — runs the script; prompts for confirmation if unreviewed or flagged dangerous
- **Cancel** — exit without running

After a security review, the verdict updates the menu:

- **SAFE** — execute option shows "no issues found"
- **CAUTION** — execute option shows "proceed with caution"
- **DANGEROUS** — execute is blocked unless explicitly confirmed

## Optional Dependencies

- [`bat`](https://github.com/sharkdp/bat) — syntax highlighting (falls back to `less`)
- At least one reviewer CLI — see [Reviewers](#reviewers). Without one, viewing and
  executing still work; only the security review is unavailable.

## License

MIT
