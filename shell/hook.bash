# curl-review shell hook for bash
# Intercepts curl/wget install patterns (pipe-to-shell, process substitution)
# and rewrites them to curl-review for safe inspection.
#
# Source this file in your .bashrc:
#   source "$(npm root -g)/curl-review/shell/hook.bash"
# Or if installed locally:
#   source /path/to/curl-review/shell/hook.bash

# Guard against double-sourcing
[[ -n "$_CURL_REVIEW_HOOK_LOADED" ]] && return
_CURL_REVIEW_HOOK_LOADED=1

_curl_review_extract_url() {
  printf '%s' "$1" | grep -oE 'https?://[^ )"'"'"'|]+' | head -1
}

_curl_review_pipes_to_shell() {
  # Normalize whitespace around pipe for matching
  local cmd="${1//	/ }"  # tabs to spaces
  while [[ "$cmd" = *'  '* ]]; do cmd="${cmd//  / }"; done
  [[ "$cmd" = *'| sh'* ]] || \
  [[ "$cmd" = *'| bash'* ]] || \
  [[ "$cmd" = *'| zsh'* ]] || \
  [[ "$cmd" = *'| sudo sh'* ]] || \
  [[ "$cmd" = *'| sudo bash'* ]] || \
  [[ "$cmd" = *'| sudo zsh'* ]] || \
  [[ "$cmd" = *'| sudo env sh'* ]] || \
  [[ "$cmd" = *'| sudo env bash'* ]] || \
  [[ "$cmd" = *'| sudo env zsh'* ]] || \
  [[ "$cmd" = *'| env sh'* ]] || \
  [[ "$cmd" = *'| env bash'* ]] || \
  [[ "$cmd" = *'| env zsh'* ]] || \
  [[ "$cmd" = *'| /usr/bin/sh'* ]] || \
  [[ "$cmd" = *'| /usr/bin/bash'* ]] || \
  [[ "$cmd" = *'| /bin/sh'* ]] || \
  [[ "$cmd" = *'| /bin/bash'* ]] || \
  [[ "$cmd" = *'| /bin/zsh'* ]]
}

_curl_review_is_install_cmd() {
  # Normalize tabs to spaces for matching
  local cmd="${1//	/ }"

  # curl ... | sh/bash/zsh
  if [[ "$cmd" = *'curl '* ]] && _curl_review_pipes_to_shell "$cmd"; then
    return 0
  fi

  # wget ... | sh/bash/zsh
  if [[ "$cmd" = *'wget '* ]] && _curl_review_pipes_to_shell "$cmd"; then
    return 0
  fi

  # sh/bash/zsh <(curl ...)  (process substitution)
  if [[ "$cmd" = *sh*'<(curl '* || "$cmd" = *bash*'<(curl '* || "$cmd" = *zsh*'<(curl '* ]]; then
    return 0
  fi

  # bash -c "$(curl ...)" / sh -c "$(curl ...)"
  if [[ "$cmd" = *'-c'*'$(curl '* ]]; then
    return 0
  fi

  return 1
}

# Flag used to communicate between the two bind -x stages.
# When set to "1", the second stage skips accept-line.
_CURL_REVIEW_INTERCEPTED=""

# Stage 1: Check the current readline buffer for install patterns.
_curl_review_check() {
  _CURL_REVIEW_INTERCEPTED=""
  local cmd="$READLINE_LINE"

  if [[ -n "$cmd" && "$cmd" != '#'* && "$cmd" != *'curl-review'* ]] \
     && _curl_review_is_install_cmd "$cmd"; then
    local url
    url=$(_curl_review_extract_url "$cmd")
    if [[ -n "$url" ]]; then
      echo "curl-review: intercepted install command -- press Enter to continue"
      READLINE_LINE="curl-review $(printf '%q' "$url") --original $(printf '%q' "$cmd")"
      READLINE_POINT=${#READLINE_LINE}
      _CURL_REVIEW_INTERCEPTED=1
    fi
  fi
}

# Stage 2: Conditionally accept the line based on the flag.
_curl_review_maybe_accept() {
  if [[ -z "$_CURL_REVIEW_INTERCEPTED" ]]; then
    # Not intercepted — submit via a temporary keyseq
    bind '"\e[0n": accept-line'
    printf '\e[5n'
  fi
  # If intercepted, do nothing — user sees rewritten line and presses Enter again
}

# Enter key → check (\C-x1), then conditionally accept (\C-x2).
bind -x '"\C-x1": _curl_review_check'
bind -x '"\C-x2": _curl_review_maybe_accept'
bind '"\C-m": "\C-x1\C-x2"'
bind '"\C-j": "\C-x1\C-x2"'
