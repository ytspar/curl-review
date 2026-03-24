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

## Usage

```bash
curl-review https://example.com/install.sh
```

With the original intercepted command (used by tirith integration):

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

## Tirith Integration

`curl-review` integrates with [tirith](https://github.com/nichochar/tirith) terminal security guard. When tirith blocks a `curl | sh` paste, the zsh hook rewrites the command to `curl-review` automatically.

Add this to your `.zshrc` after tirith initialization:

```zsh
if (( $+functions[_tirith_bracketed_paste] )); then
  _tirith_bracketed_paste() {
    local old_buffer="$BUFFER" old_cursor="$CURSOR"
    zle _tirith_original_bracketed_paste 2>/dev/null || zle .bracketed-paste
    [[ "${TIRITH:-}" == "0" ]] && return

    local new_buffer="$BUFFER"
    local pasted="${new_buffer:$old_cursor:$((${#new_buffer} - ${#old_buffer}))}"
    [[ -z "$pasted" ]] && return

    local tmpfile=$(mktemp)
    echo -n "$pasted" | command tirith paste --shell posix >"$tmpfile" 2>&1
    local rc=$?
    local output=$(<"$tmpfile")
    command rm -f "$tmpfile"

    if [[ $rc -eq 1 ]]; then
      local url
      url=$(echo "$pasted" | grep -oE 'https?://[^ |]+')
      if [[ -n "$url" ]]; then
        BUFFER="${old_buffer}curl-review ${(q)url} --original ${(q)pasted}"
        CURSOR=${#BUFFER}
        return
      fi
      BUFFER="$old_buffer"
      CURSOR=$old_cursor
      _tirith_output ""
      _tirith_output "paste> $pasted"
      [[ -n "$output" ]] && _tirith_output "$output"
      zle send-break
    elif [[ $rc -eq 2 ]]; then
      [[ -n "$output" ]] && { _tirith_output ""; _tirith_output "$output"; }
    fi
  }
fi
```

## Optional Dependencies

- [`bat`](https://github.com/sharkdp/bat) — syntax highlighting (falls back to `less`)
- [`claude`](https://claude.ai/claude-code) — AI security review (run `claude /login` to authenticate)

## License

MIT
